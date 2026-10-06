import { describe, expect, it } from "vitest";
import { initPanelState } from "../../src/core/teamwork/panel.ts";
import { shouldShowTeamSide } from "../../src/modes/interactive/chat-viewport.ts";
import { formatTeamworkStatusLines } from "../../src/modes/interactive/components/teamwork-status.ts";

const team = {
	leader: { provider: "kimi", model: "k3" },
	workers: [
		{ roleId: "worker1", provider: "kimi", model: "k3", description: "UI designer" },
		{ roleId: "worker2", provider: "deepseek", model: "v4.1-flash", description: "engineer" },
	],
	reviewer: { provider: "kimi", model: "k3" },
};

const roleModels = {
	leader: { provider: "kimi", model: "k3", thinkingLevel: "xhigh" as const },
	worker1: { provider: "kimi", model: "k3", thinkingLevel: "high" as const },
	worker2: { provider: "deepseek", model: "v4.1-flash", thinkingLevel: "xhigh" as const },
	reviewer: { provider: "kimi", model: "k3", thinkingLevel: "off" as const },
};

const sessionModel = { provider: "kimi", id: "k3", thinkingLevel: "xhigh" as const };

describe("formatTeamworkStatusLines", () => {
	it("shows only the leader while planning", () => {
		const lines = formatTeamworkStatusLines(initPanelState("r1", "goal", team), roleModels, sessionModel);
		expect(lines.map((l) => l.text)).toEqual(["【leader】kimi k3 xhigh"]);
	});

	it("suppresses the leader once a worker starts and lists parallel workers vertically", () => {
		const started = initPanelState("r1", "goal", team);
		const w1 = started.members.find((m) => m.roleId === "worker1")!;
		w1.status = "working";
		const w2 = started.members.find((m) => m.roleId === "worker2")!;
		w2.status = "working";
		const lines = formatTeamworkStatusLines(started, roleModels, sessionModel);
		expect(lines.map((l) => l.text)).toEqual([
			"【worker1-UI designer】kimi k3 high",
			"【worker2-engineer】deepseek v4.1-flash xhigh",
		]);
	});

	it("shows the reviewer in review format", () => {
		const state = initPanelState("r1", "goal", team);
		for (const m of state.members) m.status = "completed";
		const reviewer = state.members.find((m) => m.kind === "reviewer")!;
		reviewer.status = "reviewing";
		const lines = formatTeamworkStatusLines(state, roleModels, sessionModel);
		expect(lines.map((l) => l.text)).toEqual(["【reviewer】kimi k3 off"]);
	});

	it("returns empty when idle snapshot or done phase", () => {
		expect(formatTeamworkStatusLines(undefined, roleModels, sessionModel)).toEqual([]);
		const done = initPanelState("r1", "goal", team);
		done.phase = "done";
		expect(formatTeamworkStatusLines(done, roleModels, sessionModel)).toEqual([]);
	});

	it("stays visible on narrow screens where the sidebar is gated", () => {
		expect(shouldShowTeamSide(true, 80)).toBe(false);
		const started = initPanelState("r1", "goal", team);
		started.members.find((m) => m.roleId === "worker1")!.status = "working";
		const lines = formatTeamworkStatusLines(started, roleModels, sessionModel);
		expect(lines.map((l) => l.text)).toEqual(["【worker1-UI designer】kimi k3 high"]);
	});

	it("caps overflow at 4 lines with a …N more row", () => {
		const team5 = {
			leader: { provider: "kimi", model: "k3" },
			workers: [1, 2, 3, 4, 5].map((i) => ({
				roleId: `worker${i}`,
				provider: "kimi",
				model: "k3",
				description: `job${i}`,
			})),
			reviewer: { provider: "kimi", model: "k3" },
		};
		const state = initPanelState("r1", "goal", team5);
		for (const m of state.members) if (m.kind === "worker") m.status = "working";
		const lines = formatTeamworkStatusLines(state, undefined, { provider: "kimi", id: "k3" });
		expect(lines.map((l) => l.text)).toEqual([
			"【worker1-job1】kimi k3 off",
			"【worker2-job2】kimi k3 off",
			"【worker3-job3】kimi k3 off",
			"【worker4-job4】kimi k3 off",
			"…1 more",
		]);
		expect(lines[4]).toEqual({ text: "…1 more", active: false });
	});

	it("drops the reviewer, not a worker, when 4 workers fill the budget", () => {
		const team4 = {
			leader: { provider: "kimi", model: "k3" },
			workers: [1, 2, 3, 4].map((i) => ({
				roleId: `worker${i}`,
				provider: "kimi",
				model: "k3",
				description: `job${i}`,
			})),
			reviewer: { provider: "kimi", model: "k3" },
		};
		const state = initPanelState("r1", "goal", team4);
		for (const m of state.members) {
			if (m.kind === "worker") m.status = "working";
			if (m.kind === "reviewer") m.status = "reviewing";
		}
		const lines = formatTeamworkStatusLines(state, undefined, { provider: "kimi", id: "k3" });
		expect(lines.map((l) => l.text)).toEqual([
			"【worker1-job1】kimi k3 off",
			"【worker2-job2】kimi k3 off",
			"【worker3-job3】kimi k3 off",
			"【worker4-job4】kimi k3 off",
			"…1 more",
		]);
		expect(lines.some((l) => l.text.startsWith("【reviewer】"))).toBe(false);
	});

	it("renders — for a missing leader provider/model", () => {
		const lines = formatTeamworkStatusLines(initPanelState("r1", "goal", team), undefined, {
			provider: "?",
			id: "?",
		});
		expect(lines.map((l) => l.text)).toEqual(["【leader】— — off"]);
	});

	it("returns empty when the phase is failed", () => {
		const failed = initPanelState("r1", "goal", team);
		failed.phase = "failed";
		expect(formatTeamworkStatusLines(failed, roleModels, sessionModel)).toEqual([]);
	});

	it("falls back to off thinking when no level is bound", () => {
		const started = initPanelState("r1", "goal", team);
		started.members.find((m) => m.roleId === "worker1")!.status = "working";
		const lines = formatTeamworkStatusLines(started, undefined, { provider: "kimi", id: "k3" });
		expect(lines.map((l) => l.text)).toEqual(["【worker1-UI designer】kimi k3 off"]);
	});

	it("renders — for worker/reviewer with unknown provider/model", () => {
		const unknownTeam = {
			leader: { provider: "kimi", model: "k3" },
			workers: [{ roleId: "worker1", provider: "?", model: "?", description: "UI designer" }],
			reviewer: { provider: "?", model: "?" },
		};
		const started = initPanelState("r1", "goal", unknownTeam);
		started.members.find((m) => m.roleId === "worker1")!.status = "working";
		expect(formatTeamworkStatusLines(started, undefined, { provider: "kimi", id: "k3" }).map((l) => l.text)).toEqual([
			"【worker1-UI designer】— — off",
		]);
		const reviewing = initPanelState("r1", "goal", unknownTeam);
		for (const m of reviewing.members) m.status = "completed";
		reviewing.members.find((m) => m.kind === "reviewer")!.status = "reviewing";
		expect(
			formatTeamworkStatusLines(reviewing, undefined, { provider: "kimi", id: "k3" }).map((l) => l.text),
		).toEqual(["【reviewer】— — off"]);
	});
});
