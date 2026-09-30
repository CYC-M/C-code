import type { Context } from "@earendil-works/pi-ai";
import { buildWorkerMessages, parseReviewOutput, parseWorkerOutput } from "./context.ts";
import { assertBudgetForDispatch, transitionOnReview } from "./state.ts";
import type { ReviewResult, TeamRunState, TeamTask, TeamworkEvent, WorkerResult } from "./types.ts";

export interface WorkerModelRef {
	provider: string;
	id: string;
}

export interface WorkerModelClient {
	find(provider: string, model: string): WorkerModelRef | undefined;
	hasConfiguredAuth(ref: WorkerModelRef): boolean;
	complete(model: WorkerModelRef, context: Context): Promise<string>;
}

export interface Executor {
	runReady(
		run: TeamRunState,
		ready: TeamTask[],
		callOne: (task: TeamTask) => Promise<WorkerResult>,
	): Promise<WorkerResult[]>;
}

export class SerialExecutor implements Executor {
	async runReady(
		run: TeamRunState,
		ready: TeamTask[],
		callOne: (task: TeamTask) => Promise<WorkerResult>,
	): Promise<WorkerResult[]> {
		const out: WorkerResult[] = [];
		for (const task of ready) {
			assertWorkerCallBudget(run, 1);
			run.budget.workerCallsUsed += 1;
			out.push(await callOne(task));
		}
		return out;
	}
}

// Round budget is enforced once per runTeamRound call at entry; per-call
// checks enforce only the worker-call budget (reviewer calls consume it).
function assertWorkerCallBudget(run: TeamRunState, callsNeeded: number): void {
	if (run.budget.workerCallsUsed + callsNeeded > run.budget.maxWorkerCalls) {
		throw new Error(
			`team worker call budget exhausted (${run.budget.workerCallsUsed}/${run.budget.maxWorkerCalls}, need ${callsNeeded})`,
		);
	}
}

const MAX_DEPTH = 2;

export async function runTeamRound(
	run: TeamRunState,
	client: WorkerModelClient,
	readFile: (path: string) => Promise<string>,
	depth = 0,
	onEvent?: (event: TeamworkEvent) => void,
): Promise<TeamRunState> {
	// Exactly one round per invocation: dispatch → collect → review → return.
	// On needs_fix with budget left the state returns as "dispatched" and the
	// BRAIN (main session, between tool calls) decides retry / swap_worker /
	// revise_package / downgrade / finish / abort and re-invokes the tool.
	assertBudgetForDispatch(run, run.tasks.length);
	run.budget.roundsUsed += 1;
	run.phase = "dispatched";
	onEvent?.({
		type: "teamwork.started",
		runId: run.runId,
		goal: run.goal,
		team: {
			leader: run.team.leader,
			workers: run.tasks.map((t) => {
				const role = run.team.roles[t.role];
				return { roleId: t.role, provider: role?.provider ?? "?", model: role?.model ?? "?" };
			}),
			reviewer: {
				provider: run.team.roles[run.team.reviewer]?.provider ?? "?",
				model: run.team.roles[run.team.reviewer]?.model ?? "?",
			},
		},
	});
	const ready = run.tasks.filter((t) => (t.dependsOn ?? []).every((d) => run.results[d] !== undefined));
	run.phase = "collecting";
	const executor = new SerialExecutor();
	const results = await executor.runReady(run, ready, (task) =>
		callWorker(run, task, client, readFile, depth, onEvent),
	);
	for (const r of results) run.results[r.taskId] = r;
	run.phase = "reviewing";
	const review = await callReviewer(run, client, onEvent);
	transitionOnReview(run, review);
	onEvent?.({ type: "teamwork.completed", runId: run.runId, phase: run.phase });
	return run;
}

async function callWorker(
	run: TeamRunState,
	task: TeamTask,
	client: WorkerModelClient,
	readFile: (path: string) => Promise<string>,
	depth: number,
	onEvent?: (event: TeamworkEvent) => void,
): Promise<WorkerResult> {
	const role = run.team.roles[task.role];
	if (!role) throw new Error(`teamwork: unknown role "${task.role}" for task ${task.id}`);
	const ref = client.find(role.provider, role.model);
	if (!ref || !client.hasConfiguredAuth(ref))
		throw new Error(`teamwork: model ${role.provider}/${role.model} not configured (see /model)`);
	const attempt = (run.results[task.id] !== undefined ? 1 : 0) + 1;
	const messages = await buildWorkerMessages(
		{
			runId: run.runId,
			assignment: task,
			contextSlice: {
				notes: typeof task.inputs?.notes === "string" ? (task.inputs.notes as string) : undefined,
				priorSummaries: (task.dependsOn ?? []).map((d) => ({ taskId: d, summary: run.results[d]?.summary ?? "" })),
				files: extractContextFiles(task),
			},
			rolePrompt: role.systemPrompt,
			allowSubAgents: role.allowSubAgents ?? false,
			attempt,
			depth,
		},
		readFile,
	);
	onEvent?.({
		type: "member.started",
		runId: run.runId,
		roleId: task.role,
		provider: ref.provider,
		model: ref.id,
		taskId: task.id,
		taskTitle: task.title,
	});
	const text = await client.complete(ref, messages).catch((error: unknown) => {
		onEvent?.({
			type: "member.failed",
			runId: run.runId,
			roleId: task.role,
			provider: ref.provider,
			model: ref.id,
			taskId: task.id,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	});
	try {
		const parsed = parseWorkerOutput(text);
		const nested = await maybeDelegate(run, task, parsed.data, client, readFile, depth, onEvent);
		if (nested) parsed.summary += `\nSub-run ${nested.runId}: ${nested.phase}.`;
		onEvent?.({
			type: "member.completed",
			runId: run.runId,
			roleId: task.role,
			provider: ref.provider,
			model: ref.id,
			taskId: task.id,
			summary: parsed.summary,
		});
		return {
			taskId: task.id,
			role: task.role,
			model: { provider: ref.provider, id: ref.id },
			status: "ok",
			summary: parsed.summary,
			artifacts: parsed.artifacts,
			data: parsed.data,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onEvent?.({
			type: "member.failed",
			runId: run.runId,
			roleId: task.role,
			provider: ref.provider,
			model: ref.id,
			taskId: task.id,
			error: message,
		});
		return {
			taskId: task.id,
			role: task.role,
			model: { provider: ref.provider, id: ref.id },
			status: "error",
			summary: `worker output unparseable (attempt ${attempt})`,
			error: message,
		};
	}
}

async function maybeDelegate(
	run: TeamRunState,
	task: TeamTask,
	data: unknown,
	client: WorkerModelClient,
	readFile: (path: string) => Promise<string>,
	depth: number,
	onEvent?: (event: TeamworkEvent) => void,
): Promise<TeamRunState | undefined> {
	if (!run.team.roles[task.role]?.allowSubAgents || depth >= MAX_DEPTH) return undefined;
	const delegate = (data as { delegate?: { goal?: string; tasks?: TeamTask[] } } | null)?.delegate;
	if (!delegate?.goal || !Array.isArray(delegate.tasks) || delegate.tasks.length === 0) return undefined;
	// Carve the sub-run budget from what remains, reserving 1 call for the parent reviewer.
	const remaining = run.budget.maxWorkerCalls - run.budget.workerCallsUsed;
	const subBudget = {
		maxRounds: 1,
		maxWorkerCalls: Math.max(0, remaining - 1),
	};
	if (subBudget.maxWorkerCalls === 0) return undefined;
	const subTasks = delegate.tasks.map((t, i) => ({ ...t, id: `${task.id}.${i}` }));
	const sub = await runTeamRound(
		{
			...createSubState(run, delegate.goal, subTasks),
			budget: { ...subBudget, roundsUsed: 0, workerCallsUsed: 0 },
		},
		client,
		readFile,
		depth + 1,
		onEvent,
	);
	run.budget.workerCallsUsed += sub.budget.workerCallsUsed;
	return sub;
}

function extractContextFiles(task: TeamTask): { path: string; offset?: number; limit?: number }[] | undefined {
	const raw = task.inputs?.files;
	if (!Array.isArray(raw)) return undefined;
	const files: { path: string; offset?: number; limit?: number }[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const rec = entry as Record<string, unknown>;
		if (typeof rec.path !== "string" || rec.path.length === 0) continue;
		const file: { path: string; offset?: number; limit?: number } = { path: rec.path };
		if (typeof rec.offset === "number" && Number.isFinite(rec.offset) && rec.offset >= 0) {
			file.offset = Math.floor(rec.offset);
		}
		if (typeof rec.limit === "number" && Number.isFinite(rec.limit) && rec.limit >= 0) {
			file.limit = Math.floor(rec.limit);
		}
		files.push(file);
	}
	return files.length > 0 ? files : undefined;
}

function createSubState(run: TeamRunState, goal: string, tasks: TeamTask[]): TeamRunState {
	return {
		runId: `${run.runId}/sub`,
		goal,
		phase: "pending",
		team: run.team,
		tasks,
		results: {},
		reviews: [],
		budget: { maxRounds: 1, maxWorkerCalls: 0, roundsUsed: 0, workerCallsUsed: 0 },
		decisionLog: [],
	};
}

async function callReviewer(
	run: TeamRunState,
	client: WorkerModelClient,
	onEvent?: (event: TeamworkEvent) => void,
): Promise<ReviewResult> {
	const reviewerRole = run.team.roles[run.team.reviewer];
	const ref = client.find(reviewerRole.provider, reviewerRole.model);
	if (!ref || !client.hasConfiguredAuth(ref))
		throw new Error(`teamwork: reviewer model not configured (see /teamwork)`);
	assertWorkerCallBudget(run, 1);
	run.budget.workerCallsUsed += 1;
	const report = Object.values(run.results)
		.map(
			(r) =>
				`Task ${r.taskId} [${r.status}]: ${r.summary}\nGoal check: ${run.tasks.find((t) => t.id === r.taskId)?.goal ?? ""}`,
		)
		.join("\n\n");
	onEvent?.({ type: "review.started", runId: run.runId, provider: ref.provider, model: ref.id });
	const text = await client.complete(ref, {
		systemPrompt: reviewerRole.systemPrompt,
		messages: [{ role: "user", content: `Run ${run.runId} goal: ${run.goal}\n\n${report}`, timestamp: Date.now() }],
	});
	let review: ReviewResult;
	try {
		review = parseReviewOutput(text, run.runId);
	} catch {
		review = {
			runId: run.runId,
			verdict: "needs_fix",
			findings: [{ severity: "major", detail: "reviewer output unparseable", suggestion: "retry review" }],
		};
	}
	const failedTaskIds = [...new Set(review.findings.filter((f) => f.taskId).map((f) => f.taskId as string))];
	onEvent?.({
		type: "review.completed",
		runId: run.runId,
		provider: ref.provider,
		model: ref.id,
		verdict: review.verdict,
		failedTaskIds,
	});
	return review;
}
