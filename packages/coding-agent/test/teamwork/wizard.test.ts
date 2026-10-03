import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { RoleModelRef } from "../../src/core/teamwork/types.ts";
import {
	buildRoleBindingSummary,
	ensureWorkerBindings,
	formatWorkerPlanPreview,
	resolveEffectiveLeader,
	runAddWorkers,
	runReconfigureRole,
	runSetThinkingOnly,
	runTeamworkInitialSetup,
	type TeamworkWizardDeps,
} from "../../src/modes/interactive/teamwork-wizard.ts";

function makeStore(initial: Record<string, RoleModelRef> = {}) {
	let store: Record<string, RoleModelRef> = { ...initial };
	return {
		getRoleModels: () => ({ ...store }),
		setRoleModel: (role: string, ref: RoleModelRef) => {
			store = { ...store, [role]: ref };
		},
		clearRoleModel: (role: string) => {
			const rest = { ...store };
			delete rest[role];
			store = rest;
		},
		snapshot: () => ({ ...store }),
	};
}

function makeDeps(
	store: ReturnType<typeof makeStore>,
	modelQueue: Array<{ provider: string; id: string }>,
	yesNoQueue: boolean[],
	thinkingQueue: (ThinkingLevel | undefined)[] = [],
	roleIdQueue: (string | undefined)[] = [],
): TeamworkWizardDeps {
	let pendingSelect: ((model: { provider: string; id: string }) => void) | undefined;
	return {
		showSelector: (render) => {
			let done = false;
			const selector = render(() => {
				done = true;
			});
			void selector;
			void done;
			const next = modelQueue.shift();
			if (next && pendingSelect) pendingSelect(next);
			pendingSelect = undefined;
		},
		createModelSelector: (onSelect) => {
			pendingSelect = onSelect;
			return {} as never;
		},
		settingsManager: store as never,
		notify: () => {},
		askYesNo: async () => yesNoQueue.shift() ?? false,
		selectThinking: async () => thinkingQueue.shift() ?? undefined,
		inputRoleId: async () => roleIdQueue.shift(),
	};
}

describe("teamwork wizard", () => {
	it("summarizes role bindings for confirmation", () => {
		expect(buildRoleBindingSummary({ worker: { provider: "o", model: "m" } })).toContain("worker");
		expect(buildRoleBindingSummary(undefined)).toContain("no roles");
	});
});

import {
	formatPoolBindings,
	isValidWorkerRoleId,
	suggestWorkerRoleId,
} from "../../src/modes/interactive/teamwork-wizard.ts";

describe("teamwork worker role ids", () => {
	it("accepts the canonical workerN form", () => {
		expect(isValidWorkerRoleId("worker1")).toBe(true);
		expect(isValidWorkerRoleId("worker2")).toBe(true);
		expect(isValidWorkerRoleId("worker12")).toBe(true);
		// Lenient about the casing and spacing the user types; the wizard stores workerN.
		expect(isValidWorkerRoleId("Worker 3")).toBe(true);
	});

	it("rejects names that are not worker plus a number", () => {
		expect(isValidWorkerRoleId("")).toBe(false);
		expect(isValidWorkerRoleId("worker")).toBe(false);
		expect(isValidWorkerRoleId("worker-a")).toBe(false);
		expect(isValidWorkerRoleId("worker-frontend")).toBe(false);
		expect(isValidWorkerRoleId("my worker")).toBe(false);
		expect(isValidWorkerRoleId("worker0")).toBe(false);
	});

	it("rejects empty, uppercase, underscored, and spaced ids", () => {
		expect(isValidWorkerRoleId("")).toBe(false);
		expect(isValidWorkerRoleId("Worker")).toBe(false);
		expect(isValidWorkerRoleId("my_worker")).toBe(false);
		expect(isValidWorkerRoleId("my worker")).toBe(false);
	});

	it("rejects reserved and already-used ids", () => {
		expect(isValidWorkerRoleId("leader")).toBe(false);
		expect(isValidWorkerRoleId("reviewer")).toBe(false);
		expect(isValidWorkerRoleId("worker1", ["worker1"])).toBe(false);
		expect(isValidWorkerRoleId("worker2", ["worker1"])).toBe(true);
	});

	it("suggests the next free worker number", () => {
		expect(suggestWorkerRoleId()).toBe("worker1");
		expect(suggestWorkerRoleId(["worker1"])).toBe("worker2");
		expect(suggestWorkerRoleId(["worker1", "worker2"])).toBe("worker3");
	});
});

describe("teamwork initial setup", () => {
	it("configures leader(follow)+reviewer without touching existing workers", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "m" } });
		const deps = makeDeps(store, [{ provider: "a", id: "r1" }], [true]);
		await runTeamworkInitialSetup(deps, store.getRoleModels());
		const snap = store.snapshot();
		expect(snap["worker-a"]).toEqual({ provider: "o", model: "m" });
		expect(snap.leader).toBeUndefined();
		expect(snap.reviewer).toEqual({ provider: "a", model: "r1" });
	});

	it("stores an independent leader when user declines follow-session", async () => {
		const store = makeStore();
		const deps = makeDeps(
			store,
			[
				{ provider: "o", id: "lead" },
				{ provider: "a", id: "rev" },
			],
			[false],
		);
		await runTeamworkInitialSetup(deps, store.getRoleModels());
		expect(store.snapshot().leader).toEqual({ provider: "o", model: "lead" });
		expect(store.snapshot().reviewer).toEqual({ provider: "a", model: "rev" });
	});
});

describe("teamwork lazy worker bindings", () => {
	it("binds missing roles, skips leader/reviewer, allows same-model reuse", async () => {
		const store = makeStore({ reviewer: { provider: "a", model: "rev" } });
		const deps = makeDeps(
			store,
			[
				{ provider: "o", id: "same" },
				{ provider: "o", id: "same" },
			],
			[],
		);
		await ensureWorkerBindings(deps, ["worker-a", "leader", "reviewer", "worker-b", "worker-a"]);
		const snap = store.snapshot();
		expect(snap["worker-a"]).toEqual({ provider: "o", model: "same" });
		expect(snap["worker-b"]).toEqual({ provider: "o", model: "same" });
	});

	it("keeps an existing worker binding on keep=yes", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "old" } });
		const deps = makeDeps(store, [], [true]);
		await ensureWorkerBindings(deps, ["worker-a"]);
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "old" });
	});
});

describe("teamwork thinking selection", () => {
	it("stores a picked non-off thinking level with the role", async () => {
		const store = makeStore({ reviewer: { provider: "a", model: "rev" } });
		const deps = makeDeps(store, [{ provider: "o", id: "new" }], [false], ["high"]);
		await ensureWorkerBindings(deps, ["worker-a"]);
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "new", thinkingLevel: "high" });
	});

	it("omits the field when off is picked", async () => {
		const store = makeStore();
		const deps = makeDeps(store, [{ provider: "o", id: "new" }], [], ["off"]);
		await ensureWorkerBindings(deps, ["worker-a"]);
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "new" });
	});

	it("keeps the existing level when the picker is cancelled", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "old", thinkingLevel: "medium" } });
		const deps = makeDeps(store, [{ provider: "o", id: "new" }], [false], [undefined]);
		await ensureWorkerBindings(deps, ["worker-a"]);
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "new", thinkingLevel: "medium" });
	});

	it("shows the thinking suffix in binding summaries", () => {
		expect(buildRoleBindingSummary({ worker: { provider: "o", model: "m", thinkingLevel: "high" } })).toContain(
			"o/m · high",
		);
	});
});

describe("teamwork sidebar reconfigure", () => {
	it("reselects model and thinking for a configured role", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "old" } });
		const deps = makeDeps(store, [{ provider: "p", id: "new" }], [], ["medium"]);
		await runReconfigureRole(deps, "worker-a");
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "p", model: "new", thinkingLevel: "medium" });
	});

	it("leaves an unconfigured role untouched", async () => {
		const store = makeStore();
		const deps = makeDeps(store, [], []);
		await runReconfigureRole(deps, "worker-a");
		expect(store.snapshot()["worker-a"]).toBeUndefined();
	});
});

describe("teamwork thinking top-up on keep", () => {
	it("offers and stores a level for a kept binding that lacks one", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "m" } });
		const deps = makeDeps(store, [], [true, true], ["high"]);
		await ensureWorkerBindings(deps, ["worker-a"]);
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "m", thinkingLevel: "high" });
	});

	it("leaves the binding alone when the offer is declined", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "m" } });
		const deps = makeDeps(store, [], [true, false], ["high"]);
		await ensureWorkerBindings(deps, ["worker-a"]);
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "m" });
	});

	it("does not offer when a level is already set", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "m", thinkingLevel: "medium" } });
		const thinkingQueue: (ThinkingLevel | undefined)[] = ["high"];
		const deps = makeDeps(store, [], [true], thinkingQueue);
		await ensureWorkerBindings(deps, ["worker-a"]);
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "m", thinkingLevel: "medium" });
		expect(thinkingQueue).toEqual(["high"]);
	});

	it("tops up the reviewer on mode entry when kept without a level", async () => {
		const store = makeStore({ reviewer: { provider: "a", model: "rev" } });
		const deps = makeDeps(store, [], [true, true, true], ["high"]);
		await runTeamworkInitialSetup(deps, store.getRoleModels());
		expect(store.snapshot().reviewer).toEqual({ provider: "a", model: "rev", thinkingLevel: "high" });
	});
});

describe("teamwork guided worker setup", () => {
	it("adds workers with model and thinking until declined", async () => {
		const store = makeStore();
		const deps = makeDeps(
			store,
			[
				{ provider: "o", id: "m1" },
				{ provider: "o", id: "m2" },
			],
			[true, true, false],
			["high", "off"],
			["worker1", "worker2"],
		);
		await runAddWorkers(deps);
		expect(store.snapshot().worker1).toEqual({ provider: "o", model: "m1", thinkingLevel: "high" });
		expect(store.snapshot().worker2).toEqual({ provider: "o", model: "m2" });
	});

	it("adds nothing when declined immediately", async () => {
		const store = makeStore();
		const deps = makeDeps(store, [], [false]);
		await runAddWorkers(deps);
		expect(store.snapshot()).toEqual({});
	});
});

describe("teamwork thinking-only change", () => {
	it("updates only the thinking level, keeping the model", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "m" } });
		const deps = makeDeps(store, [], [], ["high"]);
		await runSetThinkingOnly(deps, "worker-a");
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "m", thinkingLevel: "high" });
	});

	it("clears the level back to off", async () => {
		const store = makeStore({ "worker-a": { provider: "o", model: "m", thinkingLevel: "high" } });
		const deps = makeDeps(store, [], [], ["off"]);
		await runSetThinkingOnly(deps, "worker-a");
		expect(store.snapshot()["worker-a"]).toEqual({ provider: "o", model: "m" });
	});

	it("leaves unconfigured roles untouched", async () => {
		const store = makeStore();
		const deps = makeDeps(store, [], [], ["high"]);
		await runSetThinkingOnly(deps, "worker-a");
		expect(store.snapshot()).toEqual({});
	});
});

describe("teamwork effective leader", () => {
	it("follows the session model when no override is stored", () => {
		expect(resolveEffectiveLeader(undefined, { provider: "o", id: "s" })).toEqual({
			provider: "o",
			model: "s",
		});
		expect(resolveEffectiveLeader({ reviewer: { provider: "a", model: "r" } }, { provider: "o", id: "s" })).toEqual({
			provider: "o",
			model: "s",
		});
	});

	it("uses the stored override when present", () => {
		expect(resolveEffectiveLeader({ leader: { provider: "x", model: "lead" } }, { provider: "o", id: "s" })).toEqual({
			provider: "x",
			model: "lead",
		});
	});
});
describe("teamwork pool summary", () => {
	it("lists worker bindings and skips leader/reviewer", () => {
		const text = formatPoolBindings({
			leader: { provider: "o", model: "m" },
			worker: { provider: "o", model: "m" },
			reviewer: { provider: "a", model: "c" },
		});
		expect(text).toContain("worker");
		expect(text).not.toContain("leader");
		expect(text).not.toContain("reviewer");
	});

	it("reports an empty pool", () => {
		expect(formatPoolBindings(undefined)).toContain("no workers");
		expect(formatPoolBindings({ reviewer: { provider: "a", model: "c" } })).toContain("no workers");
	});
});

describe("teamwork worker plan preview", () => {
	it("formats one block per station with title, goal, and criteria", () => {
		const text = formatWorkerPlanPreview([
			{
				role: "worker1",
				label: "worker1（UI designer）",
				title: "Login page",
				goal: "Build the login form",
				successCriteria: ["renders", "validates input"],
			},
		]);
		expect(text).toContain("worker1（UI designer）");
		expect(text).toContain("Login page");
		expect(text).toContain("Build the login form");
		expect(text).toContain("renders");
	});

	it("shows the preview before configuring each station in turn", async () => {
		const store = makeStore({ reviewer: { provider: "a", model: "rev" } });
		const seen: string[] = [];
		const baseDeps = makeDeps(
			store,
			[
				{ provider: "o", id: "one" },
				{ provider: "o", id: "two" },
			],
			[],
		);
		const deps: TeamworkWizardDeps = { ...baseDeps, notify: (message: string) => seen.push(message) };
		await ensureWorkerBindings(
			deps,
			["worker1", "worker2"],
			{ worker1: "UI designer", worker2: "Back-end architect" },
			[
				{ role: "worker1", label: "worker1（UI designer）", title: "Login page", goal: "Build it" },
				{ role: "worker2", label: "worker2（Back-end architect）", title: "API", goal: "Serve it" },
			],
		);
		expect(seen[0]).toContain("分工预览");
		expect(seen[0]).toContain("worker1（UI designer）");
		expect(seen[0]).toContain("Login page");
		expect(store.snapshot().worker1).toEqual({ provider: "o", model: "one" });
		expect(store.snapshot().worker2).toEqual({ provider: "o", model: "two" });
	});
});
