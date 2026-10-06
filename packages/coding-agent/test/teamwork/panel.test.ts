import { describe, expect, it } from "vitest";
import { applyTeamworkEvent, initPanelState, settlePanelState } from "../../src/core/teamwork/panel.ts";
import type { TeamRoster, TeamworkEvent } from "../../src/core/teamwork/types.ts";

const team: TeamRoster = {
	leader: { provider: "openai", model: "gpt-5" },
	workers: [
		{ roleId: "worker-a", provider: "openai", model: "gpt-5-mini" },
		{ roleId: "worker-b", provider: "anthropic", model: "claude-sonnet-4-5" },
	],
	reviewer: { provider: "anthropic", model: "claude-sonnet-4-5" },
};

function startedA(): TeamworkEvent {
	return {
		type: "member.started",
		runId: "run-1",
		roleId: "worker-a",
		provider: "openai",
		model: "gpt-5-mini",
		taskId: "t1",
		taskTitle: "Build API",
	};
}

describe("teamwork panel reducer", () => {
	it("init builds leader/worker/reviewer rows with pending statuses", () => {
		const state = initPanelState("run-1", "ship it", team);
		expect(state.runId).toBe("run-1");
		expect(state.goal).toBe("ship it");
		expect(state.phase).toBe("pending");
		expect(state.members).toHaveLength(4);
		expect(state.members[0]).toMatchObject({ kind: "leader", provider: "openai", model: "gpt-5", status: "working" });
		expect(state.members[1]).toMatchObject({ kind: "worker", roleId: "worker-a", status: "pending" });
		expect(state.members[2]).toMatchObject({ kind: "worker", roleId: "worker-b", status: "pending" });
		expect(state.members[3]).toMatchObject({
			kind: "reviewer",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			status: "pending",
		});

		const noLeader = initPanelState("run-9", "goal", { workers: [], reviewer: team.reviewer });
		expect(noLeader.members[0]).toMatchObject({ kind: "leader", provider: "—", model: "—", status: "working" });
	});

	it("started→completed sequence drives working→completed with summary", () => {
		let state = initPanelState("run-1", "ship it", team);
		state = applyTeamworkEvent(state, startedA());
		expect(state.members[1]).toMatchObject({ status: "working", taskTitle: "Build API" });
		state = applyTeamworkEvent(state, {
			type: "member.completed",
			runId: "run-1",
			roleId: "worker-a",
			provider: "openai",
			model: "gpt-5-mini",
			taskId: "t1",
			summary: "API done",
		});
		expect(state.members[1]).toMatchObject({ status: "completed", summary: "API done" });
	});

	it("stores real usage from member.completed and review.completed", () => {
		let state = initPanelState("run-1", "ship it", team);
		state = applyTeamworkEvent(state, startedA());
		const usage = { input: 100, output: 40, cacheRead: 10, cacheWrite: 2, total: 152 };
		state = applyTeamworkEvent(state, {
			type: "member.completed",
			runId: "run-1",
			roleId: "worker-a",
			provider: "openai",
			model: "gpt-5-mini",
			taskId: "t1",
			summary: "API done",
			usage,
		});
		expect(state.members[1]).toMatchObject({ status: "completed", usage });
		const reviewUsage = { input: 50, output: 20, cacheRead: 5, cacheWrite: 0, total: 75 };
		state = applyTeamworkEvent(state, {
			type: "review.completed",
			runId: "run-1",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			verdict: "pass",
			usage: reviewUsage,
		});
		expect(state.members[3]).toMatchObject({ status: "completed", usage: reviewUsage });
	});

	it("out-of-order/duplicate events are idempotent", () => {
		let state = initPanelState("run-1", "ship it", team);
		state = applyTeamworkEvent(state, startedA());
		const done: TeamworkEvent = {
			type: "member.completed",
			runId: "run-1",
			roleId: "worker-a",
			provider: "openai",
			model: "gpt-5-mini",
			taskId: "t1",
			summary: "API done",
		};
		const once = applyTeamworkEvent(state, done);
		const twice = applyTeamworkEvent(once, done);
		expect(twice).toEqual(once);
		expect(twice.members).toHaveLength(once.members.length);
	});

	it("foreign runId ignored", () => {
		const before = initPanelState("run-1", "ship it", team);
		const after = applyTeamworkEvent(before, { ...startedA(), runId: "run-other" });
		expect(after).toBe(before);
	});

	it("review failure marks needs_fix; teamwork.completed keeps failed/needs_fix", () => {
		let state = initPanelState("run-1", "ship it", team);
		state = applyTeamworkEvent(state, startedA());
		state = applyTeamworkEvent(state, {
			type: "member.completed",
			runId: "run-1",
			roleId: "worker-a",
			provider: "openai",
			model: "gpt-5-mini",
			taskId: "t1",
			summary: "API done",
		});
		state = applyTeamworkEvent(state, {
			type: "member.failed",
			runId: "run-1",
			roleId: "worker-b",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			taskId: "t2",
			error: "boom",
		});
		expect(state.members[2]).toMatchObject({ status: "failed", summary: "Error: boom" });
		state = applyTeamworkEvent(state, {
			type: "review.started",
			runId: "run-1",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
		expect(state.members[3]).toMatchObject({ status: "reviewing" });
		state = applyTeamworkEvent(state, {
			type: "review.completed",
			runId: "run-1",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			verdict: "needs_fix",
			failedTaskIds: ["t1"],
		});
		expect(state.verdict).toBe("needs_fix");
		expect(state.members[1]).toMatchObject({ status: "needs_fix" });
		expect(state.members[2]).toMatchObject({ status: "failed" });
		expect(state.members[3]).toMatchObject({ status: "completed" });

		state = applyTeamworkEvent(state, { type: "teamwork.completed", runId: "run-1", phase: "done" });
		expect(state.phase).toBe("done");
		expect(state.members[0]).toMatchObject({ status: "completed" });
		expect(state.members[1]).toMatchObject({ status: "needs_fix" });
		expect(state.members[2]).toMatchObject({ status: "failed" });
		expect(state.members[3]).toMatchObject({ status: "completed" });
	});
});

describe("settlePanelState", () => {
	it("lands lingering working and reviewing members as completed", () => {
		const started = applyTeamworkEvent(initPanelState("run-1", "ship it", team), startedA());
		const settled = settlePanelState(started);
		expect(settled.members.find((m) => m.kind === "worker" && m.roleId === "worker-a")?.status).toBe("completed");
		expect(settled.members.find((m) => m.kind === "leader")?.status).toBe("completed");
	});

	it("leaves terminal members and run metadata untouched", () => {
		const started = applyTeamworkEvent(initPanelState("run-1", "ship it", team), startedA());
		const settled = settlePanelState(started);
		expect(settled.runId).toBe("run-1");
		expect(settled.phase).toBe(started.phase);
		expect(settled.members.find((m) => m.kind === "worker" && m.roleId === "worker-b")?.status).toBe("pending");
	});
});
