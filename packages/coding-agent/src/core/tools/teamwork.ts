import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { defineTool } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { summarizeResults } from "../teamwork/context.ts";
import {
	canonicalizeWorkerTaskRoles,
	formatWorkerLabel,
	isWorkerRoleId,
	workerDescriptionsInTasks,
	workerRolesInTasks,
} from "../teamwork/naming.ts";
import { runTeamRound, type WorkerModelClient } from "../teamwork/orchestrator.ts";
import { assembleTeamConfig, WORKER_PROMPT } from "../teamwork/roles.ts";
import { continueRun, createRun } from "../teamwork/state.ts";
import type {
	RoleModelRef,
	TeamRunState,
	TeamTask,
	TeamUsage,
	TeamworkEvent,
	TeamworkWorkerPreview,
} from "../teamwork/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export interface TeamworkToolOptions {
	sessionManager?: SessionManager;
	settingsManager?: SettingsManager;
	/**
	 * Ask the user to bind a model for each worker the leader proposed but that has no
	 * binding yet. The interactive mode supplies this; headless callers leave it unset and
	 * get an actionable error instead.
	 */
	ensureWorkerBindings?: (
		roles: readonly string[],
		labels: Record<string, string>,
		previews?: readonly TeamworkWorkerPreview[],
	) => Promise<void>;
}

const teamworkSchema = Type.Object({
	goal: Type.String(),
	tasks: Type.Array(
		Type.Object({
			id: Type.String(),
			title: Type.String(),
			goal: Type.String(),
			role: Type.String(),
			roleDescription: Type.Optional(Type.String()),
			dependsOn: Type.Optional(Type.Array(Type.String())),
			inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			successCriteria: Type.Array(Type.String()),
		}),
	),
	budget: Type.Optional(
		Type.Object({ maxRounds: Type.Optional(Type.Number()), maxWorkerCalls: Type.Optional(Type.Number()) }),
	),
	continueRunId: Type.Optional(Type.String()),
});

/**
 * Worker roles used by the tasks that still have no model binding. Roles the user
 * configured are bound by definition; canonicalization leaves only workerN unknowns.
 */
function unboundWorkerRoles(
	roleModels: Record<string, RoleModelRef> | undefined,
	tasks: readonly TeamTask[],
): string[] {
	const bound = new Set(Object.keys(roleModels ?? {}));
	return workerRolesInTasks(tasks).filter((role) => !bound.has(role));
}

function unboundWorkersError(roles: readonly string[], labels: Record<string, string>): Error {
	const names = roles.map((role) => formatWorkerLabel(role, labels[role])).join(", ");
	return new Error(
		`teamwork: no model configured for ${names}. Run /teamwork bind ${roles.join(" ")} to pick a model per worker, then call teamwork again.`,
	);
}

/**
 * Leader 分工预览：每个待配工位取首个任务的标题/目标/验收标准，
 * 供 UI 先展示分工表再逐个确认模型。
 */
function buildWorkerPreviews(tasks: readonly TeamTask[], roles: readonly string[]): TeamworkWorkerPreview[] {
	const labels = workerDescriptionsInTasks(tasks);
	const firstByRole = new Map<string, TeamTask>();
	for (const task of tasks) {
		if (!firstByRole.has(task.role)) firstByRole.set(task.role, task);
	}
	return roles.map((role) => {
		const task = firstByRole.get(role);
		return {
			role,
			label: formatWorkerLabel(role, labels[role]),
			...(task?.title === undefined ? {} : { title: task.title }),
			...(task?.goal === undefined ? {} : { goal: task.goal }),
			...(task?.successCriteria === undefined ? {} : { successCriteria: task.successCriteria }),
		};
	});
}

function assertValidPriorRun(data: unknown, runId: string): asserts data is TeamRunState {
	const budget = (data as { budget?: unknown }).budget as Record<string, unknown> | undefined;
	const results = (data as { results?: unknown }).results;
	const reviews = (data as { reviews?: unknown }).reviews;
	const decisionLog = (data as { decisionLog?: unknown }).decisionLog;
	const team = (data as { team?: unknown }).team as Record<string, unknown> | undefined;
	const roles = team?.roles;
	const tasks = (data as { tasks?: unknown }).tasks;
	const valid =
		typeof data === "object" &&
		data !== null &&
		typeof budget === "object" &&
		budget !== null &&
		typeof budget.maxRounds === "number" &&
		typeof budget.maxWorkerCalls === "number" &&
		typeof budget.roundsUsed === "number" &&
		typeof budget.workerCallsUsed === "number" &&
		typeof results === "object" &&
		results !== null &&
		Array.isArray(reviews) &&
		Array.isArray(decisionLog) &&
		typeof team === "object" &&
		team !== null &&
		typeof roles === "object" &&
		roles !== null &&
		Array.isArray(tasks);
	if (!valid) throw new Error(`teamwork: corrupt prior run state for continueRunId ${runId}`);
}

function findPriorRun(ctx: ExtensionContext, runId: string): TeamRunState | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && (entry as { customType?: string }).customType === "teamwork-run") {
			const data = (entry as { data?: unknown }).data as TeamRunState | undefined;
			if (data && typeof data === "object" && (data as TeamRunState).runId === runId) {
				assertValidPriorRun(data, runId);
				return data as TeamRunState;
			}
		}
	}
	return undefined;
}

function teamworkEventLine(event: TeamworkEvent): string {
	switch (event.type) {
		case "teamwork.started":
			return `Team ${event.runId} started: ${event.goal}`;
		case "member.started":
			return `${event.roleId} started ${event.taskId}: ${event.taskTitle}`;
		case "member.completed":
			return `${event.roleId} completed ${event.taskId}`;
		case "member.failed":
			return `${event.roleId} failed ${event.taskId}: ${event.error}`;
		case "review.started":
			return `Review started (${event.provider}/${event.model})`;
		case "review.completed":
			return `Review ${event.verdict}`;
		case "teamwork.completed":
			return `Team ${event.runId} ${event.phase}`;
	}
}

function formatUsageSummary(final: TeamRunState): string | undefined {
	const parts: string[] = [];
	for (const r of Object.values(final.results)) {
		if (r.usage === undefined) continue;
		parts.push(
			`${r.taskId} (${r.model.provider}/${r.model.id}): in ${r.usage.input} out ${r.usage.output} cacheR ${r.usage.cacheRead} cacheW ${r.usage.cacheWrite} total ${r.usage.total}`,
		);
	}
	const review = final.reviews[final.reviews.length - 1];
	if (review?.usage !== undefined) {
		parts.push(
			`review: in ${review.usage.input} out ${review.usage.output} cacheR ${review.usage.cacheRead} cacheW ${review.usage.cacheWrite} total ${review.usage.total}`,
		);
	}
	if (parts.length === 0) return undefined;
	return `Tokens:\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

/** Max reviewer findings inlined in the tool result; the rest stays in `teamwork-run`. */
const MAX_REVIEW_FINDINGS = 20;

function formatReviewDetails(final: TeamRunState): string[] {
	const review = final.reviews[final.reviews.length - 1];
	if (!review) return [];
	const lines = [`Review: ${review.verdict} (${review.findings.length} findings)`];
	for (const f of review.findings.slice(0, MAX_REVIEW_FINDINGS)) {
		lines.push(`- [${f.severity}] ${f.taskId ?? "-"}: ${f.detail} → ${f.suggestion}`);
	}
	if (review.findings.length > MAX_REVIEW_FINDINGS) {
		lines.push(`…${review.findings.length - MAX_REVIEW_FINDINGS} more, see teamwork-run`);
	}
	const failedIds = [...new Set(review.findings.map((f) => f.taskId).filter((id) => id !== undefined))];
	if (failedIds.length > 0) lines.push(`FailedTaskIds: ${failedIds.join(", ")}`);
	if (review.retryPlan) {
		lines.push(`Retry: tasks ${review.retryPlan.taskIds.join(", ")} — ${review.retryPlan.instructions}`);
	}
	if (final.phase !== "done") {
		lines.push(`Continue: call teamwork again with {continueRunId: "${final.runId}", tasks: <revised>}`);
	}
	return lines;
}

export function createTeamworkToolDefinition(
	cwd: string,
	options?: TeamworkToolOptions,
): ToolDefinition<typeof teamworkSchema, { runId: string; phase: string }> {
	void cwd;
	return defineTool({
		name: "teamwork",
		label: "teamwork",
		description:
			"Delegate a goal to a dynamic team: serial workers with scoped contexts plus a reviewer. Name workers worker1, worker2, ... in order and describe each worker's job in roleDescription (shown as worker1（UI designer）). Workers without a model binding are bound by the user when the tool runs. Returns a compact structured summary; full state is persisted to the session. To retry within the original budget, pass continueRunId with revised tasks to continue within the original budget.",
		promptSnippet: "teamwork: multi-model team delegation with review loop",
		promptGuidelines: ["Use teamwork when a goal splits into parallelizable subtasks needing different models."],
		parameters: teamworkSchema,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			void toolCallId;
			void signal;
			if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
				throw new Error("teamwork: no tasks provided");
			}
			const settings = options?.settingsManager;
			// Worker bindings are single-use per task: snapshot the pre-run worker
			// pool so the teardown restores it (pre-bound workers survive with
			// their initial values, task-local workers are dropped).
			const snapshotWorkers = (): Record<string, RoleModelRef> => {
				const snap: Record<string, RoleModelRef> = {};
				for (const [role, ref] of Object.entries(settings?.getRoleModels?.() ?? {})) {
					if (isWorkerRoleId(role)) snap[role] = { ...ref };
				}
				return snap;
			};
			const initialWorkerSnapshot = snapshotWorkers();
			const restoreWorkerBindings = async (): Promise<{ restored: string[]; dropped: string[] }> => {
				const restored: string[] = [];
				const dropped: string[] = [];
				const current = settings?.getRoleModels?.() ?? {};
				const seen = new Set([...Object.keys(initialWorkerSnapshot), ...Object.keys(current)]);
				for (const role of seen) {
					if (!isWorkerRoleId(role)) continue;
					const initial = initialWorkerSnapshot[role];
					if (initial === undefined) {
						if (current[role] !== undefined && typeof settings?.clearRoleModel === "function") {
							settings.clearRoleModel(role);
							dropped.push(role);
						}
					} else if (
						current[role]?.provider !== initial.provider ||
						current[role]?.model !== initial.model ||
						current[role]?.thinkingLevel !== initial.thinkingLevel
					) {
						settings?.setRoleModel?.(role, { ...initial });
						restored.push(role);
					}
				}
				await settings?.flush?.();
				return { restored, dropped };
			};
			let run: TeamRunState;
			if (params.continueRunId) {
				const prior = findPriorRun(ctx, params.continueRunId);
				if (!prior) throw new Error("teamwork: unknown continueRunId");
				// The leader names the workers. Accept whatever it produced: a role the user
				// already bound is kept, `worker 1（UI designer）` becomes `worker1`, and any
				// other name becomes the description of the next free worker. This is what
				// keeps a naming slip from failing the run.
				const tasks = canonicalizeWorkerTaskRoles(params.tasks, { knownRoles: Object.keys(prior.team.roles) });
				run = continueRun(prior, tasks);
				// New workers introduced on retry need model bindings too: backfill from
				// stored settings first, then ask the user (with 分工预览) for the rest.
				const backfill = settings?.getRoleModels?.() ?? {};
				for (const role of workerRolesInTasks(tasks)) {
					if (run.team.roles[role] === undefined && backfill[role] !== undefined) {
						run.team.roles[role] = { ...backfill[role], systemPrompt: WORKER_PROMPT };
					}
				}
				const missingRetry = workerRolesInTasks(tasks).filter((role) => run.team.roles[role] === undefined);
				if (missingRetry.length > 0) {
					const labels = workerDescriptionsInTasks(tasks);
					await options?.ensureWorkerBindings?.(missingRetry, labels, buildWorkerPreviews(tasks, missingRetry));
					const latest = settings?.getRoleModels?.() ?? {};
					for (const role of missingRetry) {
						if (run.team.roles[role] === undefined && latest[role] !== undefined) {
							run.team.roles[role] = { ...latest[role], systemPrompt: WORKER_PROMPT };
						}
					}
					const stillMissing = missingRetry.filter((role) => run.team.roles[role] === undefined);
					if (stillMissing.length > 0) {
						await restoreWorkerBindings();
						throw unboundWorkersError(stillMissing, labels);
					}
				}
			} else {
				const roleModels = settings?.getRoleModels();
				const tasks = canonicalizeWorkerTaskRoles(params.tasks, { knownRoles: Object.keys(roleModels ?? {}) });
				const missing = unboundWorkerRoles(roleModels, tasks);
				if (missing.length > 0) {
					const labels = workerDescriptionsInTasks(tasks);
					await options?.ensureWorkerBindings?.(missing, labels, buildWorkerPreviews(tasks, missing));
					const stillMissing = unboundWorkerRoles(settings?.getRoleModels(), tasks);
					if (stillMissing.length > 0) {
						await restoreWorkerBindings();
						throw unboundWorkersError(stillMissing, labels);
					}
				}
				const team = assembleTeamConfig(settings?.getRoleModels(), params.budget ?? undefined);
				run = createRun(params.goal, team, tasks);
			}
			const registry = ctx.modelRegistry;
			const client: WorkerModelClient = {
				find: (provider, model) => {
					const found = registry.find(provider, model);
					return found ? { provider: found.provider, id: found.id as string } : undefined;
				},
				hasConfiguredAuth: (ref) => {
					const found = registry.find(ref.provider, ref.id);
					return found ? registry.hasConfiguredAuth(found) : false;
				},
				complete: async (ref, context, thinkingLevel) => {
					const found = registry.find(ref.provider, ref.id);
					if (!found) throw new Error(`teamwork: model ${ref.provider}/${ref.id} not found`);
					const response =
						thinkingLevel === undefined || thinkingLevel === "off"
							? await registry.complete(found, context)
							: await registry.completeSimple(found, context, { reasoning: thinkingLevel });
					const usage = response.usage;
					return {
						text: contentText(response.content),
						...(usage === undefined
							? {}
							: {
									usage: {
										input: usage.input,
										output: usage.output,
										cacheRead: usage.cacheRead,
										cacheWrite: usage.cacheWrite,
										total: usage.totalTokens,
										...(usage.cost === undefined ? {} : { cost: usage.cost }),
									},
								}),
					};
				},
			};
			let final: TeamRunState;
			let haltError: string | undefined;
			const emit = (event: TeamworkEvent) => {
				onUpdate?.({
					content: [{ type: "text", text: teamworkEventLine(event) }],
					// Extra `teamwork` flows at runtime; the declared details type stays { runId, phase }.
					details: { runId: run.runId, phase: run.phase, teamwork: event } as {
						runId: string;
						phase: string;
					},
				});
			};
			try {
				final = await runTeamRound(run, client, (path) => readFile(path, "utf-8"), 0, emit);
			} catch (error) {
				haltError = error instanceof Error ? error.message : String(error);
				run.phase = "failed";
				final = run;
			}
			options?.sessionManager?.appendCustomEntry("teamwork-run", final);
			// Attribute worker/reviewer spend to their own models so the footer
			// totals and per-model breakdown stop showing leader-only numbers.
			// Recorded once per final state (a retry re-spends, so it records again).
			const recordUsage = (u: TeamUsage | undefined, provider: string, model: string, note: string): void => {
				if (u === undefined) return;
				options?.sessionManager?.appendUsage?.(
					"teamwork",
					provider,
					model,
					{
						input: u.input,
						output: u.output,
						cacheRead: u.cacheRead,
						cacheWrite: u.cacheWrite,
						totalTokens: u.total,
						cost: u.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					note,
				);
			};
			for (const r of Object.values(final.results)) recordUsage(r.usage, r.model.provider, r.model.id, r.taskId);
			const reviewerRef = run.team.roles[run.team.reviewer];
			const lastReview = final.reviews[final.reviews.length - 1];
			if (lastReview?.usage !== undefined && reviewerRef) {
				recordUsage(lastReview.usage, reviewerRef.provider, reviewerRef.model, "review");
			}
			// Worker bindings are single-use per task: restore the pre-run pool.
			// Pre-bound workers survive with their initial values; task-local
			// workers are dropped. Leader and reviewer are untouched.
			// Flush synchronously: quitting right after the run must not resurrect them.
			const { restored, dropped } = await restoreWorkerBindings();
			const summary = [
				`Team run ${final.runId}: ${final.phase}${final.downgraded ? " (downgraded)" : ""}`,
				summarizeResults(final.results, final.tasks),
			];
			const tokenLines = formatUsageSummary(final);
			if (tokenLines !== undefined) summary.push(tokenLines);
			if (haltError) summary.push(`Halted: ${haltError}`);
			summary.push(...formatReviewDetails(final));
			if (dropped.length > 0) summary.push(`Dropped single-use bindings: ${dropped.join(", ")}`);
			if (restored.length > 0) summary.push(`Restored bindings: ${restored.join(", ")}`);
			return {
				content: [{ type: "text", text: summary.join("\n") }],
				details: { runId: final.runId, phase: final.phase },
			};
		},
	});
}

export function createTeamworkTool(cwd: string, options?: TeamworkToolOptions): AgentTool<typeof teamworkSchema> {
	return wrapToolDefinition(createTeamworkToolDefinition(cwd, options));
}
