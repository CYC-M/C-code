import { describe, expect, it, vi } from "vitest";
import { runTeamRound } from "../../src/core/teamwork/orchestrator.ts";
import { createRun } from "../../src/core/teamwork/state.ts";
import type { TeamConfig, TeamworkEvent } from "../../src/core/teamwork/types.ts";

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

describe("orchestrator events", () => {
	it("emits the full sequence in order on a pass run", async () => {
		const run = createRun("goal", team, tasks);
		const client = fakeClient('{"summary":"done"}', '{"verdict":"pass","findings":[]}');
		const events: TeamworkEvent[] = [];
		await runTeamRound(
			run,
			client,
			async () => "",
			0,
			(e) => events.push(e),
		);
		expect(events.map((e) => e.type)).toEqual([
			"teamwork.started",
			"member.started",
			"member.completed",
			"review.started",
			"review.completed",
			"teamwork.completed",
		]);
	});

	it("carries provider/model/task payloads and pass verdict", async () => {
		const run = createRun("goal", team, tasks);
		const client = fakeClient('{"summary":"done"}', '{"verdict":"pass","findings":[]}');
		const events: TeamworkEvent[] = [];
		await runTeamRound(
			run,
			client,
			async () => "",
			0,
			(e) => events.push(e),
		);
		const started = events.find((e) => e.type === "member.started");
		expect(started).toMatchObject({ provider: "o", model: "m", taskId: "t1", taskTitle: "t" });
		const completed = events.find((e) => e.type === "review.completed");
		expect(completed).toMatchObject({ verdict: "pass" });
	});

	it("carries real usage on member.completed and review.completed", async () => {
		const run = createRun("goal", team, tasks);
		const client = fakeClient('{"summary":"done"}', '{"verdict":"pass","findings":[]}');
		const events: TeamworkEvent[] = [];
		await runTeamRound(
			run,
			client,
			async () => "",
			0,
			(e) => events.push(e),
		);
		const memberCompleted = events.find((e) => e.type === "member.completed");
		expect(memberCompleted).toMatchObject({
			usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, total: 150 },
		});
		const reviewCompleted = events.find((e) => e.type === "review.completed");
		expect(reviewCompleted).toMatchObject({
			usage: { input: 50, output: 20, cacheRead: 5, cacheWrite: 0, total: 75 },
		});
	});

	it("lists finding taskIds on needs_fix and returns to brain as dispatched", async () => {
		const run = createRun("goal", team, tasks);
		const client = fakeClient(
			'{"summary":"bad"}',
			'{"verdict":"needs_fix","findings":[{"severity":"major","taskId":"t1","detail":"bad","suggestion":"fix"}]}',
		);
		const events: TeamworkEvent[] = [];
		const final = await runTeamRound(
			run,
			client,
			async () => "",
			0,
			(e) => events.push(e),
		);
		const reviewCompleted = events.find((e) => e.type === "review.completed");
		expect(reviewCompleted).toMatchObject({ failedTaskIds: ["t1"] });
		const last = events[events.length - 1];
		expect(last.type).toBe("teamwork.completed");
		expect((last as { phase: string }).phase).toBe("dispatched");
		expect(final.phase).toBe("dispatched");
	});

	it("completes done with no onEvent passed", async () => {
		const run = createRun("goal", team, tasks);
		const client = fakeClient('{"summary":"done"}', '{"verdict":"pass","findings":[]}');
		const final = await runTeamRound(run, client, async () => "");
		expect(final.phase).toBe("done");
	});
});
