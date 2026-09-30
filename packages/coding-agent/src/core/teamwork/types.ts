import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type RoleId = string;
export type BrainDecision = "retry" | "swap_worker" | "revise_package" | "downgrade" | "finish" | "abort";
export type RunPhase = "pending" | "dispatched" | "collecting" | "reviewing" | "done" | "failed";

export interface RoleModelRef {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface TeamTask {
	id: string;
	title: string;
	goal: string;
	role: RoleId;
	dependsOn?: string[];
	inputs?: Record<string, unknown>;
	successCriteria: string[];
	maxAttempts?: number;
}

export interface ContextSlice {
	files?: { path: string; offset?: number; limit?: number }[];
	priorSummaries?: { taskId: string; summary: string }[];
	notes?: string;
}

export interface TaskPackage {
	runId: string;
	assignment: TeamTask;
	contextSlice: ContextSlice;
	rolePrompt: string;
	allowSubAgents: boolean;
	attempt: number;
	depth: number;
}

export interface WorkerResult {
	taskId: string;
	role: RoleId;
	model: { provider: string; id: string };
	status: "ok" | "error";
	summary: string;
	artifacts?: { path: string; kind: string }[];
	data?: unknown;
	error?: string;
	usage?: { inputTokens: number; outputTokens: number };
}

export interface ReviewFinding {
	severity: "blocker" | "major" | "minor";
	taskId?: string;
	detail: string;
	suggestion: string;
}

export interface ReviewResult {
	runId: string;
	verdict: "pass" | "needs_fix";
	findings: ReviewFinding[];
	retryPlan?: { taskIds: string[]; instructions: string; swapWorker?: { taskId: string; newRole: RoleId }[] };
}

export interface RoleDefinition {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt: string;
	tools?: string[];
	allowSubAgents?: boolean;
}

export interface TeamConfig {
	roles: Record<RoleId, RoleDefinition>;
	reviewer: RoleId;
	leader?: RoleModelRef;
	budget: { maxRounds: number; maxWorkerCalls: number };
	executor: "serial" | "parallel";
}

export type TeamMemberStatus = "pending" | "working" | "completed" | "failed" | "reviewing" | "needs_fix";

export interface TeamRosterEntry {
	roleId: string;
	provider: string;
	model: string;
}

export interface TeamRoster {
	leader?: RoleModelRef;
	workers: TeamRosterEntry[];
	reviewer: { provider: string; model: string };
}

export type TeamworkEvent =
	| { type: "teamwork.started"; runId: string; goal: string; team: TeamRoster }
	| {
			type: "member.started";
			runId: string;
			roleId: string;
			provider: string;
			model: string;
			taskId: string;
			taskTitle: string;
	  }
	| {
			type: "member.completed";
			runId: string;
			roleId: string;
			provider: string;
			model: string;
			taskId: string;
			summary: string;
	  }
	| {
			type: "member.failed";
			runId: string;
			roleId: string;
			provider: string;
			model: string;
			taskId: string;
			error: string;
	  }
	| { type: "review.started"; runId: string; provider: string; model: string }
	| {
			type: "review.completed";
			runId: string;
			provider: string;
			model: string;
			verdict: "pass" | "needs_fix";
			failedTaskIds?: string[];
	  }
	| { type: "teamwork.completed"; runId: string; phase: RunPhase };

export interface TeamRunState {
	runId: string;
	goal: string;
	phase: RunPhase;
	team: TeamConfig;
	tasks: TeamTask[];
	results: Record<string, WorkerResult>;
	reviews: ReviewResult[];
	budget: { maxRounds: number; maxWorkerCalls: number; roundsUsed: number; workerCallsUsed: number };
	decisionLog: { at: string; by: "brain"; decision: BrainDecision; reason: string }[];
	downgraded?: boolean;
}
