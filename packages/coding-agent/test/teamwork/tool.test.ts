import { describe, expect, it, vi } from "vitest";
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
			complete: async (_m: unknown, context: { systemPrompt?: string; messages: { content: unknown }[] }) => {
				const isReview = JSON.stringify(context).includes("Run team-");
				return {
					content: [
						{
							type: "text",
							text: isReview ? '{"verdict":"pass","findings":[]}' : '{"summary":"did it"}',
						},
					],
					usage: isReview
						? {
								input: 50,
								output: 20,
								cacheRead: 5,
								cacheWrite: 0,
								totalTokens: 75,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							}
						: {
								input: 100,
								output: 40,
								cacheRead: 10,
								cacheWrite: 0,
								totalTokens: 150,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
				};
			},
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

	it("reports real token usage in the summary", async () => {
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {
				appendCustomEntry: () => "e1",
			} as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		const result = await tool.execute(
			"call-1",
			{ goal: "fix", tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }] },
			undefined,
			undefined,
			makeCtx(),
		);
		const text = JSON.stringify(result.content);
		expect(text).toContain("Tokens:");
		expect(text).toContain("t1 (o/m): in 100 out 40 cacheR 10 cacheW 0 total 150");
		expect(text).toContain("review: in 50 out 20 cacheR 5 cacheW 0 total 75");
	});

	it("records per-model usage entries for workers and reviewer", async () => {
		const usageCalls: { kind: string; provider: string; model: string; usage: unknown; note?: string }[] = [];
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {
				appendCustomEntry: () => "e1",
				appendUsage: (kind: string, provider: string, model: string, usage: unknown, note?: string) => {
					usageCalls.push({ kind, provider, model, usage, note });
					return "u1";
				},
			} as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		await tool.execute(
			"call-1",
			{ goal: "fix", tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }] },
			undefined,
			undefined,
			makeCtx(),
		);
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		expect(usageCalls).toEqual([
			{
				kind: "teamwork",
				provider: "o",
				model: "m",
				usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, totalTokens: 150, cost: zeroCost },
				note: "t1",
			},
			{
				kind: "teamwork",
				provider: "o",
				model: "m",
				usage: { input: 50, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 75, cost: zeroCost },
				note: "review",
			},
		]);
	});

	it("keeps pre-bound workers and drops only single-use bindings", async () => {
		const store: Record<string, { provider: string; model: string }> = {
			leader: { provider: "k", model: "lead" },
			worker1: { provider: "o", model: "m" },
			reviewer: { provider: "o", model: "r" },
		};
		const cleared: string[] = [];
		let flushed = false;
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {
				appendCustomEntry: () => "e1",
				appendUsage: () => "u1",
			} as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ ...store }),
				setRoleModel: (role: string, ref: { provider: string; model: string }) => {
					store[role] = ref;
				},
				clearRoleModel: (role: string) => {
					cleared.push(role);
					delete store[role];
				},
				flush: async () => {
					flushed = true;
				},
			} as unknown as SettingsManager,
		});
		const result = await tool.execute(
			"call-1",
			{
				goal: "fix",
				tasks: [
					{ id: "t1", title: "t", goal: "g", role: "worker1", roleDescription: "UI", successCriteria: ["c"] },
				],
			},
			undefined,
			undefined,
			makeCtx(),
		);
		expect(cleared).toEqual([]);
		expect(store.worker1).toEqual({ provider: "o", model: "m" });
		expect(store.leader).toBeDefined();
		expect(store.reviewer).toBeDefined();
		expect(JSON.stringify(result.content)).not.toContain("Dropped single-use bindings");
		expect(flushed).toBe(true);
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

describe("teamwork tool thinking routing", () => {
	function thinkingCtx() {
		const respond = async (_m: unknown, context: { messages: { content: unknown }[] }) => {
			const isReview = JSON.stringify(context).includes("Run team-");
			return {
				content: [{ type: "text", text: isReview ? '{"verdict":"pass","findings":[]}' : '{"summary":"did it"}' }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: undefined },
			};
		};
		return {
			sessionManager: { getEntries: () => [] },
			modelRegistry: {
				find: (p: string, m: string) => ({ provider: p, id: m }),
				hasConfiguredAuth: () => true,
				complete: vi.fn(respond),
				completeSimple: vi.fn(respond),
			},
		} as unknown as ExtensionContext;
	}

	async function runWithRoles(
		roleModels: Record<string, { provider: string; model: string; thinkingLevel?: string }>,
	) {
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: { getRoleModels: () => roleModels } as unknown as SettingsManager,
		});
		const ctx = thinkingCtx();
		await tool.execute(
			"call-1",
			{ goal: "fix", tasks: [{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] }] },
			undefined,
			undefined,
			ctx,
		);
		return ctx.modelRegistry as unknown as {
			complete: ReturnType<typeof vi.fn>;
			completeSimple: ReturnType<typeof vi.fn>;
		};
	}

	it("uses completeSimple with reasoning when roles configure thinkingLevel", async () => {
		const registry = await runWithRoles({
			worker: { provider: "o", model: "m", thinkingLevel: "high" },
			reviewer: { provider: "o", model: "m", thinkingLevel: "low" },
		});
		expect(registry.complete).not.toHaveBeenCalled();
		expect(registry.completeSimple).toHaveBeenCalledTimes(2);
		expect(registry.completeSimple.mock.calls[0][2]).toEqual({ reasoning: "high" });
		expect(registry.completeSimple.mock.calls[1][2]).toEqual({ reasoning: "low" });
	});

	it("keeps plain complete when no thinkingLevel is configured", async () => {
		const registry = await runWithRoles({
			worker: { provider: "o", model: "m" },
			reviewer: { provider: "o", model: "m" },
		});
		expect(registry.completeSimple).not.toHaveBeenCalled();
		expect(registry.complete).toHaveBeenCalledTimes(2);
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

describe("teamwork tool worker naming", () => {
	function makeMutableSettings(initial: Record<string, { provider: string; model: string }>) {
		let store = { ...initial };
		return {
			settings: {
				getRoleModels: () => ({ ...store }),
				setRoleModel: (role: string, ref: { provider: string; model: string }) => {
					store = { ...store, [role]: ref };
				},
			} as unknown as SettingsManager,
			snapshot: () => ({ ...store }),
		};
	}

	it("accepts the leader's workerN（work）naming and asks the user for missing models", async () => {
		const settings = makeMutableSettings({ reviewer: { provider: "o", model: "rev" } });
		const asked: { roles: readonly string[]; labels: Record<string, string> }[] = [];
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: settings.settings,
			ensureWorkerBindings: async (roles, labels) => {
				asked.push({ roles, labels });
				// The user picks a model per worker.
				for (const role of roles) settings.settings.setRoleModel(role, { provider: "o", model: "picked" });
			},
		});

		const result = await tool.execute(
			"call-1",
			{
				goal: "build",
				tasks: [
					{ id: "t1", title: "ui", goal: "g", role: "worker1（UI designer）", successCriteria: ["c"] },
					{ id: "t2", title: "api", goal: "g", role: "worker2（Back-end architect）", successCriteria: ["c"] },
				],
			},
			undefined,
			undefined,
			makeCtx(),
		);

		expect(asked).toHaveLength(1);
		expect(asked[0].roles).toEqual(["worker1", "worker2"]);
		expect(asked[0].labels).toEqual({ worker1: "UI designer", worker2: "Back-end architect" });
		expect(settings.snapshot()).toMatchObject({
			worker1: { provider: "o", model: "picked" },
			worker2: { provider: "o", model: "picked" },
		});
		expect(JSON.stringify(result.content)).toContain("did it");
	});

	it("keeps ad-hoc names working by turning them into workerN plus a description", async () => {
		const settings = makeMutableSettings({ reviewer: { provider: "o", model: "rev" } });
		const asked: { roles: readonly string[]; labels: Record<string, string> }[] = [];
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: settings.settings,
			ensureWorkerBindings: async (roles, labels) => {
				asked.push({ roles, labels });
				for (const role of roles) settings.settings.setRoleModel(role, { provider: "o", model: "picked" });
			},
		});

		await tool.execute(
			"call-1",
			{ goal: "build", tasks: [{ id: "t1", title: "ui", goal: "g", role: "ui designer", successCriteria: ["c"] }] },
			undefined,
			undefined,
			makeCtx(),
		);

		expect(asked[0].roles).toEqual(["worker1"]);
		expect(asked[0].labels).toEqual({ worker1: "ui designer" });
	});

	it("explains the binding command when no UI can ask", async () => {
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ reviewer: { provider: "o", model: "rev" } }),
			} as unknown as SettingsManager,
		});

		await expect(
			tool.execute(
				"call-1",
				{ goal: "build", tasks: [{ id: "t1", title: "ui", goal: "g", role: "worker1", successCriteria: ["c"] }] },
				undefined,
				undefined,
				makeCtx(),
			),
		).rejects.toThrow(/no model configured for worker1.*\/teamwork bind worker1/s);
	});

	it("passes分工 previews when asking for missing models", async () => {
		const settings = makeMutableSettings({ reviewer: { provider: "o", model: "rev" } });
		const asked: { roles: readonly string[]; labels: Record<string, string>; previews?: unknown }[] = [];
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: settings.settings,
			ensureWorkerBindings: async (roles, labels, previews) => {
				asked.push({ roles, labels, previews });
				for (const role of roles) settings.settings.setRoleModel(role, { provider: "o", model: "picked" });
			},
		});

		await tool.execute(
			"call-1",
			{
				goal: "build",
				tasks: [
					{
						id: "t1",
						title: "Login page",
						goal: "Build the login form",
						role: "worker1（UI designer）",
						successCriteria: ["renders"],
					},
				],
			},
			undefined,
			undefined,
			makeCtx(),
		);

		expect(asked).toHaveLength(1);
		expect(asked[0].previews).toEqual([
			{
				role: "worker1",
				label: "worker1（UI designer）",
				title: "Login page",
				goal: "Build the login form",
				successCriteria: ["renders"],
			},
		]);
	});

	it("binds new workers introduced on continueRun instead of failing", async () => {
		const appended: unknown[] = [];
		const prior = {
			runId: "team-1",
			goal: "fix",
			phase: "dispatched",
			team: {
				roles: {
					worker1: { provider: "o", model: "m", systemPrompt: "W" },
					reviewer: { provider: "o", model: "m", systemPrompt: "R" },
				},
				reviewer: "reviewer",
				budget: { maxRounds: 3, maxWorkerCalls: 12 },
				executor: "serial",
			},
			tasks: [{ id: "t1", title: "t", goal: "g", role: "worker1", successCriteria: ["c"] }],
			results: {},
			reviews: [],
			budget: { maxRounds: 3, maxWorkerCalls: 12, roundsUsed: 1, workerCallsUsed: 2 },
			decisionLog: [],
		};
		const settings = makeMutableSettings({ reviewer: { provider: "o", model: "rev" } });
		const asked: { roles: readonly string[]; labels: Record<string, string>; previews?: unknown }[] = [];
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: {
				appendCustomEntry: (_t: string, d: unknown) => {
					appended.push(d);
					return "e2";
				},
			} as unknown as SessionManager,
			settingsManager: settings.settings,
			ensureWorkerBindings: async (roles, labels, previews) => {
				asked.push({ roles, labels, previews });
				for (const role of roles) settings.settings.setRoleModel(role, { provider: "o", model: "picked" });
			},
		});
		const result = await tool.execute(
			"call-2",
			{
				goal: "fix",
				tasks: [
					{ id: "t1", title: "t", goal: "g", role: "worker1", successCriteria: ["c"] },
					{
						id: "t2",
						title: "new UI",
						goal: "build new UI",
						role: "worker2（UI designer）",
						successCriteria: ["renders"],
					},
				],
				continueRunId: "team-1",
			},
			undefined,
			undefined,
			makeCtx([{ type: "custom", customType: "teamwork-run", data: prior }]),
		);
		expect(asked).toHaveLength(1);
		expect(asked[0].roles).toEqual(["worker2"]);
		expect(asked[0].previews).toEqual([
			{
				role: "worker2",
				label: "worker2（UI designer）",
				title: "new UI",
				goal: "build new UI",
				successCriteria: ["renders"],
			},
		]);
		const persisted = appended[0] as { team: { roles: Record<string, unknown> } };
		expect(persisted.team.roles.worker2).toMatchObject({ provider: "o", model: "picked" });
		expect(JSON.stringify(result.content)).toContain("did it");
	});
});

describe("teamwork worker binding snapshot restore", () => {
	function makeMutableSettings(initial: Record<string, { provider: string; model: string }>) {
		let store = { ...initial };
		return {
			settings: {
				getRoleModels: () => ({ ...store }),
				setRoleModel: (role: string, ref: { provider: string; model: string }) => {
					store = { ...store, [role]: ref };
				},
				clearRoleModel: (role: string) => {
					const rest = { ...store };
					delete rest[role];
					store = rest;
				},
				flush: async () => {},
			} as unknown as SettingsManager,
			snapshot: () => ({ ...store }),
		};
	}

	it("restores pre-bound workers and drops single-use workers", async () => {
		const settings = makeMutableSettings({
			worker1: { provider: "o", model: "m1" },
			reviewer: { provider: "o", model: "rev" },
		});
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: settings.settings,
			ensureWorkerBindings: async (roles) => {
				for (const role of roles) settings.settings.setRoleModel(role, { provider: "o", model: "picked" });
			},
		});
		const result = await tool.execute(
			"call-1",
			{
				goal: "build",
				tasks: [
					{ id: "t1", title: "a", goal: "g", role: "worker1", successCriteria: ["c"] },
					{ id: "t2", title: "b", goal: "g", role: "worker2", successCriteria: ["c"] },
				],
			},
			undefined,
			undefined,
			makeCtx(),
		);
		// worker1 was bound before the run: kept with its initial value.
		expect(settings.snapshot().worker1).toEqual({ provider: "o", model: "m1" });
		// worker2 was bound single-use for this run: dropped afterwards.
		expect(settings.snapshot().worker2).toBeUndefined();
		expect(settings.snapshot().reviewer).toBeDefined();
		const text = JSON.stringify(result.content);
		expect(text).toContain("Dropped single-use bindings: worker2");
		expect(text).not.toContain("Cleared bindings");
	});

	it("empty pool stays empty after run", async () => {
		const settings = makeMutableSettings({ reviewer: { provider: "o", model: "rev" } });
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: settings.settings,
			ensureWorkerBindings: async (roles) => {
				for (const role of roles) settings.settings.setRoleModel(role, { provider: "o", model: "picked" });
			},
		});
		await tool.execute(
			"call-1",
			{ goal: "build", tasks: [{ id: "t1", title: "a", goal: "g", role: "worker1", successCriteria: ["c"] }] },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(settings.snapshot().worker1).toBeUndefined();
		expect(settings.snapshot().reviewer).toBeDefined();
	});
});

describe("teamwork reviewer full findings", () => {
	function findingsCtx() {
		return {
			sessionManager: { getEntries: () => [] },
			modelRegistry: {
				find: (p: string, m: string) => ({ provider: p, id: m }),
				hasConfiguredAuth: () => true,
				complete: async (_m: unknown, context: { messages: { content: unknown }[] }) => {
					const raw = JSON.stringify(context);
					if (raw.includes("Run team-")) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										verdict: "needs_fix",
										findings: [
											{ severity: "blocker", taskId: "t1", detail: "missing login", suggestion: "redo t1" },
											{ severity: "major", taskId: "t2", detail: "weak test", suggestion: "add test" },
										],
										retryPlan: { taskIds: ["t1", "t2"], instructions: "fix both" },
									}),
								},
							],
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						};
					}
					return { content: [{ type: "text", text: '{"summary":"did it"}' }] };
				},
			},
		} as unknown as ExtensionContext;
	}

	it("returns full reviewer findings with retryPlan and continue hint", async () => {
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker1: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		const result = await tool.execute(
			"call-1",
			{
				goal: "build",
				tasks: [
					{ id: "t1", title: "a", goal: "g1", role: "worker1", successCriteria: ["c1"] },
					{ id: "t2", title: "b", goal: "g2", role: "worker1", successCriteria: ["c2"] },
				],
			},
			undefined,
			undefined,
			findingsCtx(),
		);
		const text = (result.content as { text: string }[]).map((c) => c.text).join("\n");
		expect(text).toContain("Review: needs_fix (2 findings)");
		expect(text).toContain("[blocker] t1: missing login → redo t1");
		expect(text).toContain("[major] t2: weak test → add test");
		expect(text).toContain("FailedTaskIds: t1, t2");
		expect(text).toContain("Retry: tasks t1, t2 — fix both");
		expect(text).toContain("continueRunId");
	});

	it("omits Retry/FailedTaskIds on pass", async () => {
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker1: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		const result = await tool.execute(
			"call-1",
			{ goal: "build", tasks: [{ id: "t1", title: "a", goal: "g", role: "worker1", successCriteria: ["c"] }] },
			undefined,
			undefined,
			makeCtx(),
		);
		const text = (result.content as { text: string }[]).map((c) => c.text).join("\n");
		expect(text).toContain("Review: pass");
		expect(text).not.toContain("FailedTaskIds");
		expect(text).not.toContain("Retry:");
		expect(text).not.toContain("continueRunId");
	});

	it("caps findings at 20 lines with an overflow row", async () => {
		const findings = Array.from({ length: 22 }, (_, i) => ({
			severity: "minor",
			taskId: "t1",
			detail: `d${i}`,
			suggestion: `s${i}`,
		}));
		const ctx = {
			sessionManager: { getEntries: () => [] },
			modelRegistry: {
				find: (p: string, m: string) => ({ provider: p, id: m }),
				hasConfiguredAuth: () => true,
				complete: async (_m: unknown, context: { messages: { content: unknown }[] }) => {
					if (JSON.stringify(context).includes("Run team-")) {
						return {
							content: [{ type: "text", text: JSON.stringify({ verdict: "needs_fix", findings }) }],
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						};
					}
					return { content: [{ type: "text", text: '{"summary":"did it"}' }] };
				},
			},
		} as unknown as ExtensionContext;
		const tool = createTeamworkToolDefinition("/work", {
			sessionManager: { appendCustomEntry: () => "e1" } as unknown as SessionManager,
			settingsManager: {
				getRoleModels: () => ({ worker1: { provider: "o", model: "m" }, reviewer: { provider: "o", model: "m" } }),
			} as unknown as SettingsManager,
		});
		const result = await tool.execute(
			"call-1",
			{ goal: "build", tasks: [{ id: "t1", title: "a", goal: "g", role: "worker1", successCriteria: ["c"] }] },
			undefined,
			undefined,
			ctx,
		);
		const text = (result.content as { text: string }[]).map((c) => c.text).join("\n");
		expect(text).toContain("Review: needs_fix (22 findings)");
		expect(text).toContain("…2 more, see teamwork-run");
		expect(text).not.toContain("d21");
	});
});
