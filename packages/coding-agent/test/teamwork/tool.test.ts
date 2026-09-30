import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import type { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTeamworkToolDefinition } from "../../src/core/tools/teamwork.ts";

function makeCtx(entries: unknown[] = []) {
	return {
		sessionManager: { getEntries: () => entries },
		modelRegistry: {
			find: (p: string, m: string) => ({ provider: p, id: m }),
			hasConfiguredAuth: () => true,
			complete: async (_m: unknown, context: { systemPrompt?: string; messages: { content: unknown }[] }) =>
				JSON.stringify(context).includes("Run team-")
					? { content: [{ type: "text", text: '{"verdict":"pass","findings":[]}' }] }
					: { content: [{ type: "text", text: '{"summary":"did it"}' }] },
		},
	} as unknown as ExtensionContext;
}

describe("teamwork tool", () => {
	it("executes a run, persists state, and returns a compact summary", async () => {
		const appended: { type: string; data: unknown }[] = [];
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {
				appendCustomEntry: (t: string, d: unknown) => {
					appended.push({ type: t, data: d });
					return "e1";
				},
			} as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		const ctx = makeCtx();
		const result = await tool.execute(
			"call-1",
			{ goal: "fix", tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }] },
			undefined,
			undefined,
			ctx,
		);
		expect(appended[0].type).toBe("teamwork-run");
		expect(JSON.stringify(result.content)).toContain("did it");
	});

	it("rejects empty tasks before running", async () => {
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {} as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		await expect(tool.execute("call-1", { goal: "fix", tasks: [] }, undefined, undefined, makeCtx())).rejects.toThrow(
			"teamwork: no tasks provided",
		);
	});

	it("throws on unknown continueRunId", async () => {
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {} as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		await expect(
			tool.execute(
				"call-1",
				{
					goal: "fix",
					tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }],
					continueRunId: "missing",
				},
				undefined,
				undefined,
				makeCtx([]),
			),
		).rejects.toThrow("teamwork: unknown continueRunId");
	});

	it("continues within the original budget from persisted state", async () => {
		const appended: unknown[] = [];
		const prior = {
			runId: "team-1",
			goal: "fix",
			phase: "dispatched",
			team: {
				roles: {
					worker: { provider: "o", model: "m", systemPrompt: "W" },
					reviewer: { provider: "o", model: "m", systemPrompt: "R" },
				},
				reviewer: "reviewer",
				budget: { maxRounds: 3, maxWorkerCalls: 12 },
				executor: "serial",
			},
			tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }],
			results: {},
			reviews: [],
			budget: { maxRounds: 3, maxWorkerCalls: 12, roundsUsed: 1, workerCallsUsed: 2 },
			decisionLog: [],
		};
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {
				appendCustomEntry: (_t: string, d: unknown) => {
					appended.push(d);
					return "e2";
				},
			} as unknown as SessionManager,
			settingsManager: {} as unknown as SettingsManager,
		});
		const ctx = makeCtx([{ type: "custom", customType: "teamwork-run", data: prior }]);
		const result = await tool.execute(
			"call-2",
			{
				goal: "fix",
				tasks: [{ id: "t2", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }],
				continueRunId: "team-1",
			},
			undefined,
			undefined,
			ctx,
		);
		const persisted = appended[0] as { runId: string; budget: { roundsUsed: number; workerCallsUsed: number } };
		expect(persisted.runId.startsWith("team-1#2-")).toBe(true);
		expect(persisted.budget.roundsUsed).toBe(2);
		expect(JSON.stringify(result.content)).toContain(persisted.runId);
	});

	it("accepts a partial budget override", async () => {
		const appended: unknown[] = [];
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {
				appendCustomEntry: (_t: string, d: unknown) => {
					appended.push(d);
					return "e1";
				},
			} as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		const result = await tool.execute(
			"call-1",
			{
				goal: "fix",
				tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }],
				budget: { maxRounds: 1 },
			},
			undefined,
			undefined,
			makeCtx(),
		);
		const persisted = appended[0] as { budget: { maxRounds: number; maxWorkerCalls: number } };
		expect(persisted.budget.maxRounds).toBe(1);
		expect(persisted.budget.maxWorkerCalls).toBe(12);
		expect(JSON.stringify(result.content)).toContain("did it");
	});

	it("throws corrupt-state error for a matching runId with broken budget", async () => {
		const corrupt = {
			runId: "team-1",
			goal: "fix",
			phase: "dispatched",
			team: {
				roles: {
					worker: { provider: "o", model: "m", systemPrompt: "W" },
					reviewer: { provider: "o", model: "m", systemPrompt: "R" },
				},
				reviewer: "reviewer",
				budget: { maxRounds: 3, maxWorkerCalls: 12 },
				executor: "serial",
			},
			tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }],
			results: {},
			reviews: [],
			budget: { maxRounds: 3, maxWorkerCalls: 12, roundsUsed: "1", workerCallsUsed: 2 },
			decisionLog: [],
		};
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {} as unknown as SessionManager,
			settingsManager: {} as unknown as SettingsManager,
		});
		const ctx = makeCtx([{ type: "custom", customType: "teamwork-run", data: corrupt }]);
		await expect(
			tool.execute(
				"call-3",
				{
					goal: "fix",
					tasks: [{ id: "t2", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }],
					continueRunId: "team-1",
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("teamwork: corrupt prior run state for continueRunId team-1");
	});
});

describe("teamwork tool onUpdate forwarding", () => {
	it("forwards structured teamwork events through onUpdate", async () => {
		const seen: { teamwork?: unknown }[] = [];
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {
				appendCustomEntry: () => "e1",
			} as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		const ctx = makeCtx();
		await tool.execute(
			"call-1",
			{ goal: "fix", tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }] },
			undefined,
			(partial) => {
				seen.push((partial as { details?: unknown }).details as { teamwork?: unknown });
			},
			ctx,
		);
		const events = seen.map((s) => s?.teamwork).filter(Boolean);
		expect(events.map((e) => (e as { type: string }).type)).toEqual([
			"teamwork.started",
			"member.started",
			"member.completed",
			"review.started",
			"review.completed",
			"teamwork.completed",
		]);
		const started = events[0] as { team: { workers: { roleId: string; provider: string; model: string }[] } };
		expect(started.team.workers[0]).toMatchObject({ roleId: "worker", provider: "o", model: "m" });
		expect(events).toContainEqual(expect.objectContaining({ type: "member.completed" }));
	});
});
