import { describe, expect, it } from "vitest";
import {
	applyBrainDecision,
	assertBudgetForDispatch,
	continueRun,
	createRun,
	transitionOnReview,
} from "../../src/core/teamwork/state.ts";
import type { ReviewResult, TeamConfig } from "../../src/core/teamwork/types.ts";

const team: TeamConfig = {
	roles: {
		worker: { provider: "openai", model: "gpt-5", systemPrompt: "You implement.", tools: ["read", "edit"] },
		reviewer: { provider: "anthropic", model: "claude-sonnet-4-5", systemPrompt: "You review." },
	},
	reviewer: "reviewer",
	budget: { maxRounds: 2, maxWorkerCalls: 4 },
	executor: "serial",
};

describe("team run state machine", () => {
	it("needs_fix with budget left returns to dispatched", () => {
		const run = createRun("goal", team, [
			{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] },
		]);
		const review: ReviewResult = { runId: run.runId, verdict: "needs_fix", findings: [] };
		expect(transitionOnReview(run, review)).toBe("dispatched");
	});

	it("needs_fix with exhausted budget goes to failed, never passes silently", () => {
		const run = createRun("goal", team, [
			{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] },
		]);
		run.budget.roundsUsed = 2;
		const review: ReviewResult = { runId: run.runId, verdict: "needs_fix", findings: [] };
		expect(transitionOnReview(run, review)).toBe("failed");
	});

	it("assertBudgetForDispatch throws when worker calls are exhausted", () => {
		const run = createRun("goal", team, []);
		run.budget.workerCallsUsed = 4;
		expect(() => assertBudgetForDispatch(run, 1)).toThrow("worker call budget exhausted");
	});

	it("brain downgrade finishes explicitly annotated, abort fails", () => {
		const run = createRun("goal", team, []);
		expect(applyBrainDecision(run, "downgrade", "partial ok").phase).toBe("done");
		expect(applyBrainDecision(run, "abort", "stop").phase).toBe("failed");
	});

	it("createRun generates unique runIds", () => {
		const a = createRun("goal", team, []);
		const b = createRun("goal", team, []);
		expect(a.runId).not.toBe(b.runId);
	});

	it("continueRun carries budget counters and results into a new runId", () => {
		const prior = createRun("goal", team, [
			{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] },
		]);
		prior.budget.roundsUsed = 1;
		prior.budget.workerCallsUsed = 2;
		prior.results.t1 = {
			taskId: "t1",
			role: "worker",
			model: { provider: "o", id: "m" },
			status: "ok",
			summary: "done",
		};
		const next = continueRun(prior, [{ id: "t2", title: "t2", goal: "g2", role: "worker", successCriteria: ["c"] }]);
		expect(next.runId.startsWith(`${prior.runId}#2-`)).toBe(true);
		expect(next.budget.roundsUsed).toBe(1);
		expect(next.budget.workerCallsUsed).toBe(2);
		expect(next.results.t1.summary).toBe("done");
		expect(next.tasks.map((t) => t.id)).toEqual(["t2"]);
	});

	it("two continueRun calls from the same prior yield different runIds", () => {
		const prior = createRun("goal", team, [
			{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] },
		]);
		prior.budget.roundsUsed = 1;
		const tasks = [{ id: "t2", title: "t2", goal: "g2", role: "worker", successCriteria: ["c"] }];
		const first = continueRun(prior, tasks);
		const second = continueRun(prior, tasks);
		expect(first.runId).not.toBe(second.runId);
		expect(first.runId.startsWith(`${prior.runId}#2-`)).toBe(true);
		expect(second.runId.startsWith(`${prior.runId}#2-`)).toBe(true);
	});
});
