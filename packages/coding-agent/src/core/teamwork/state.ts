import type { BrainDecision, ReviewResult, RunPhase, TeamConfig, TeamRunState, TeamTask } from "./types.ts";

export function createRun(goal: string, team: TeamConfig, tasks: TeamTask[]): TeamRunState {
	return {
		runId: `team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		goal,
		phase: "pending",
		team,
		tasks,
		results: {},
		reviews: [],
		budget: {
			maxRounds: team.budget.maxRounds,
			maxWorkerCalls: team.budget.maxWorkerCalls,
			roundsUsed: 0,
			workerCallsUsed: 0,
		},
		decisionLog: [],
	};
}

export function assertBudgetForDispatch(run: TeamRunState, callsNeeded: number): void {
	if (run.budget.roundsUsed >= run.budget.maxRounds) {
		throw new Error(`team round budget exhausted (${run.budget.roundsUsed}/${run.budget.maxRounds})`);
	}
	if (run.budget.workerCallsUsed + callsNeeded > run.budget.maxWorkerCalls) {
		throw new Error(
			`team worker call budget exhausted (${run.budget.workerCallsUsed}/${run.budget.maxWorkerCalls}, need ${callsNeeded})`,
		);
	}
}

export function transitionOnReview(run: TeamRunState, review: ReviewResult): RunPhase {
	run.reviews.push(review);
	if (review.verdict === "pass") {
		run.phase = "done";
		return run.phase;
	}
	const budgetLeft =
		run.budget.roundsUsed < run.budget.maxRounds && run.budget.workerCallsUsed < run.budget.maxWorkerCalls;
	run.phase = budgetLeft ? "dispatched" : "failed";
	return run.phase;
}

export function applyBrainDecision(run: TeamRunState, decision: BrainDecision, reason: string): TeamRunState {
	run.decisionLog.push({ at: new Date().toISOString(), by: "brain", decision, reason });
	if (decision === "finish") run.phase = "done";
	else if (decision === "downgrade") {
		run.phase = "done";
		run.downgraded = true;
	} else if (decision === "abort") run.phase = "failed";
	else run.phase = "dispatched";
	return run;
}

export function continueRun(prior: TeamRunState, tasks: TeamTask[]): TeamRunState {
	return {
		runId: `${prior.runId}#${prior.budget.roundsUsed + 1}-${Math.random().toString(36).slice(2, 8)}`,
		goal: prior.goal,
		phase: "pending",
		team: prior.team,
		tasks,
		results: { ...prior.results },
		reviews: [...prior.reviews],
		budget: { ...prior.budget },
		decisionLog: [...prior.decisionLog],
		...(prior.downgraded ? { downgraded: prior.downgraded } : {}),
	};
}
