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
			const isReview = text.includes("Run team-");
			return {
				text: isReview ? reviewText : workerText,
				usage: isReview
					? { input: 50, output: 20, cacheRead: 5, cacheWrite: 0, total: 75 }
					: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, total: 150 },
			};
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

	it("records real usage from worker and reviewer completions", async () => {
		const run = createRun("goal", team, tasks);
		const client = fakeClient('{"summary":"done"}', '{"verdict":"pass","findings":[]}');
		const final = await runTeamRound(run, client, async () => "");
		expect(final.results.t1.usage).toEqual({ input: 100, output: 40, cacheRead: 10, cacheWrite: 0, total: 150 });
		expect(final.reviews[0].usage).toEqual({ input: 50, output: 20, cacheRead: 5, cacheWrite: 0, total: 75 });
	});

	it("passes each role thinkingLevel through to the model client", async () => {
		const thinkingTeam: TeamConfig = {
			roles: {
				worker: { provider: "o", model: "m", systemPrompt: "W", thinkingLevel: "high" },
				reviewer: { provider: "o", model: "m", systemPrompt: "R", thinkingLevel: "low" },
			},
			reviewer: "reviewer",
			budget: { maxRounds: 2, maxWorkerCalls: 4 },
			executor: "serial",
		};
		const run = createRun("goal", thinkingTeam, tasks);
		const client = fakeClient('{"summary":"done"}', '{"verdict":"pass","findings":[]}');
		const final = await runTeamRound(run, client, async () => "");
		expect(final.phase).toBe("done");
		const calls = client.complete.mock.calls as { 2?: unknown }[];
		expect(calls[0]?.[2]).toBe("high");
		expect(calls[1]?.[2]).toBe("low");
	});

	it("passes undefined thinkingLevel when roles have none configured", async () => {
		const run = createRun("goal", team, tasks);
		const client = fakeClient('{"summary":"done"}', '{"verdict":"pass","findings":[]}');
		const final = await runTeamRound(run, client, async () => "");
		expect(final.phase).toBe("done");
		const calls = client.complete.mock.calls as { 2?: unknown }[];
		expect(calls[0]?.[2]).toBeUndefined();
		expect(calls[1]?.[2]).toBeUndefined();
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
				if (text.includes("Run team-"))
					return {
						text: '{"verdict":"pass","findings":[]}',
						usage: { input: 50, output: 20, cacheRead: 5, cacheWrite: 0, total: 75 },
					};
				if (text.includes("Task t1:"))
					return {
						text: '{"summary":"parent","data":{"delegate":{"goal":"sub","tasks":[{"id":"s","title":"s","goal":"sg","role":"worker","successCriteria":["c"]}]}}}',
						usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, total: 150 },
					};
				return {
					text: '{"summary":"done"}',
					usage: { input: 80, output: 30, cacheRead: 0, cacheWrite: 0, total: 110 },
				};
			},
		};
		const final = await runTeamRound(run, client, async () => "");
		expect(final.phase).toBe("done");
		expect(final.results.t1.summary).toContain("Sub-run");
		// Budget: 1 parent worker + 2 sub (worker + reviewer) + 1 parent reviewer = 4.
		// Sub carve is remaining - 1 to reserve the parent reviewer call.
		expect(final.budget.workerCallsUsed).toBe(4);
	});

	it("keeps sub-run boundary events off the parent panel stream", async () => {
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
				if (text.includes("Run team-"))
					return {
						text: '{"verdict":"pass","findings":[]}',
						usage: { input: 50, output: 20, cacheRead: 5, cacheWrite: 0, total: 75 },
					};
				if (text.includes("Task t1:"))
					return {
						text: '{"summary":"parent","data":{"delegate":{"goal":"sub","tasks":[{"id":"s","title":"s","goal":"sg","role":"worker","successCriteria":["c"]}]}}}',
						usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, total: 150 },
					};
				return {
					text: '{"summary":"done"}',
					usage: { input: 80, output: 30, cacheRead: 0, cacheWrite: 0, total: 110 },
				};
			},
		};
		const events: { type: string; runId: string }[] = [];
		const final = await runTeamRound(
			run,
			client,
			async () => "",
			0,
			(e) => {
				events.push({ type: e.type, runId: e.runId });
			},
		);
		expect(final.phase).toBe("done");
		// A sub-run started/completed pair must not reset the parent panel:
		// exactly one parent teamwork.started and one parent teamwork.completed.
		expect(events.filter((e) => e.type === "teamwork.started").map((e) => e.runId)).toEqual([final.runId]);
		expect(events.filter((e) => e.type === "teamwork.completed").map((e) => e.runId)).toEqual([final.runId]);
	});
});
