import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { defineTool } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { summarizeResults } from "../teamwork/context.ts";
import { runTeamRound, type WorkerModelClient } from "../teamwork/orchestrator.ts";
import { assembleTeamConfig } from "../teamwork/roles.ts";
import { continueRun, createRun } from "../teamwork/state.ts";
import type { TeamRunState, TeamworkEvent } from "../teamwork/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export interface TeamworkToolOptions {
	sessionManager?: SessionManager;
	settingsManager?: SettingsManager;
}

const teamworkSchema = Type.Object({
	goal: Type.String(),
	tasks: Type.Array(
		Type.Object({
			id: Type.String(),
			title: Type.String(),
			goal: Type.String(),
			role: Type.String(),
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

export function createTeamworkToolDefinition(
	cwd: string,
	options?: TeamworkToolOptions,
): ToolDefinition<typeof teamworkSchema, { runId: string; phase: string }> {
	void cwd;
	return defineTool({
		name: "teamwork",
		label: "teamwork",
		description:
			"Delegate a goal to a dynamic team: serial workers with scoped contexts plus a reviewer. Pass tasks with role ids configured via /teamwork. Returns a compact structured summary; full state is persisted to the session. To retry within the original budget, pass continueRunId with revised tasks to continue within the original budget.",
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
			let run: TeamRunState;
			if (params.continueRunId) {
				const prior = findPriorRun(ctx, params.continueRunId);
				if (!prior) throw new Error("teamwork: unknown continueRunId");
				run = continueRun(prior, params.tasks);
			} else {
				const settings = options?.settingsManager;
				const team = assembleTeamConfig(settings?.getRoleModels(), params.budget ?? undefined);
				run = createRun(params.goal, team, params.tasks);
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
				complete: async (ref, context) => {
					const found = registry.find(ref.provider, ref.id);
					if (!found) throw new Error(`teamwork: model ${ref.provider}/${ref.id} not found`);
					const response = await registry.complete(found, context);
					return contentText(response.content);
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
			const review = final.reviews[final.reviews.length - 1];
			const summary = [
				`Team run ${final.runId}: ${final.phase}${final.downgraded ? " (downgraded)" : ""}`,
				summarizeResults(final.results, final.tasks),
			];
			if (haltError) summary.push(`Halted: ${haltError}`);
			if (review) summary.push(`Review: ${review.verdict} (${review.findings.length} findings)`);
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
