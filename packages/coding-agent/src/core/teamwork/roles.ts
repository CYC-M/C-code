import type { RoleModelRef, TeamConfig } from "./types.ts";

export const WORKER_PROMPT =
	'You are a worker in a C-code team. Do ONLY the assigned task. Return STRICT JSON: {"summary": string, "data"?: unknown, "artifacts"?: {"path": string, "kind": string}[]}. No prose outside JSON.';

export const REVIEWER_PROMPT =
	'You are the team reviewer. You do NOT modify tasks. Judge the worker results against each task\'s goal and successCriteria. Return STRICT JSON: {"verdict": "pass" | "needs_fix", "findings": [{"severity": "blocker"|"major"|"minor", "taskId"?: string, "detail": string, "suggestion": string}], "retryPlan"?: {"taskIds": string[], "instructions": string}}.';

const DEFAULT_BUDGET = { maxRounds: 3, maxWorkerCalls: 12 };

export function assembleTeamConfig(
	roleModels: Record<string, RoleModelRef> | undefined,
	budgetOverride?: { maxRounds?: number; maxWorkerCalls?: number },
): TeamConfig {
	const roles: TeamConfig["roles"] = {};
	for (const [role, ref] of Object.entries(roleModels ?? {})) {
		if (role === "leader") continue;
		roles[role] = { ...ref, systemPrompt: role === "reviewer" ? REVIEWER_PROMPT : WORKER_PROMPT };
	}
	if (!roles.reviewer)
		throw new Error("teamwork: no reviewer role configured (set roleModels.reviewer via /teamwork)");
	return {
		roles,
		reviewer: "reviewer",
		leader: roleModels?.leader,
		budget: { ...DEFAULT_BUDGET, ...budgetOverride },
		executor: "serial",
	};
}
