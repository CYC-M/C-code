import { describe, expect, it, vi } from "vitest";
import { runTeamRound } from "../../src/core/teamwork/orchestrator.ts";
import { createRun } from "../../src/core/teamwork/state.ts";
import type { TeamConfig } from "../../src/core/teamwork/types.ts";

const team: TeamConfig = {
	roles: {
		worker: { provider: "o", model: "m", systemPrompt: "W" },
		reviewer: { provider: "o", model: "m", systemPrompt: "R" },
	},
	reviewer: "reviewer",
	budget: { maxRounds: 2, maxWorkerCalls: 4 },
	executor: "serial",
};
const tasks = [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }];

function fakeClient(workerText: string, reviewText: string) {
	return {
		find: vi.fn((provider: string, model: string) => ({ provider, id: model })),
		complete: vi.fn(async (_model: unknown, context: { systemPrompt?: string; messages: { content: unknown }[] }) => {
			const text = JSON.stringify(context);
			return text.includes("Run team-") ? reviewText : workerText;
		}),
		hasConfiguredAuth: vi.fn(() => true),
	};
}

describe("orchestrator", () => {
	it("runs worker then reviewer and finishes on pass", async () => {
		const run = createRun("goal", team, tasks);
		const client = fakeClient('{"summary":"done"}', '{"verdict":"pass","findings":[]}');
		const final = await runTeamRound(run, client, async () => "");
		expect(final.phase).toBe("done");
		expect(final.results.t1.summary).toBe("done");
		expect(client.complete).toHaveBeenCalledTimes(2);
	});

	it("needs_fix with exhausted budget fails without silent pass", async () => {
		const tight = { ...team, budget: { maxRounds: 1, maxWorkerCalls: 3 } };
		const run = createRun("goal", tight, tasks);
		const client = fakeClient('{"summary":"bad"}', '{"verdict":"needs_fix","findings":[]}');
		const final = await runTeamRound(run, client, async () => "");
		expect(final.phase).toBe("failed");
		expect(final.results.t1).toBeDefined();
	});

	it("lets a worker spawn a depth-limited sub-run carved from parent budget", async () => {
		const teamWithSub: TeamConfig = {
			roles: {
				worker: { provider: "o", model: "m", systemPrompt: "W", allowSubAgents: true },
				reviewer: { provider: "o", model: "m", systemPrompt: "R" },
			},
			reviewer: "reviewer",
			budget: { maxRounds: 3, maxWorkerCalls: 6 },
			executor: "serial",
		};
		const run = createRun("goal", teamWithSub, tasks);
		const client = {
			find: (provider: string, model: string) => ({ provider, id: model }),
			hasConfiguredAuth: () => true,
			complete: async (_model: unknown, context: { systemPrompt?: string; messages: { content: unknown }[] }) => {
				const text = JSON.stringify(context);
				if (text.includes("Run team-")) return '{"verdict":"pass","findings":[]}';
				if (text.includes("Task t1:"))
					return '{"summary":"parent","data":{"delegate":{"goal":"sub","tasks":[{"id":"s","title":"s","goal":"sg","role":"worker","successCriteria":["c"]}]}}}';
				return '{"summary":"done"}';
			},
		};
		const final = await runTeamRound(run, client, async () => "");
		expect(final.phase).toBe("done");
		expect(final.results.t1.summary).toContain("Sub-run");
		// Budget: 1 parent worker + 2 sub (worker + reviewer) + 1 parent reviewer = 4.
		// Sub carve is remaining - 1 to reserve the parent reviewer call.
		expect(final.budget.workerCallsUsed).toBe(4);
	});
});
