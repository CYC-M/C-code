import { describe, expect, it } from "vitest";
import { applyTeamworkEvent, initPanelState } from "../../src/core/teamwork/panel.ts";
import type { TeamRoster } from "../../src/core/teamwork/types.ts";
import { formatPanelLines } from "../../src/modes/interactive/components/teamwork-panel.ts";

const team: TeamRoster = {
	leader: { provider: "openai", model: "gpt-5" },
	workers: [
		{ roleId: "worker-a", provider: "openai", model: "gpt-5-mini" },
		{ roleId: "worker-b", provider: "anthropic", model: "claude-sonnet-4-5" },
	],
	reviewer: { provider: "anthropic", model: "claude-sonnet-4-5" },
};

describe("teamwork panel formatPanelLines", () => {
	it("renders header + leader/worker/reviewer rows with status glyphs for a mid-run state", () => {
		let state = initPanelState("run-1", "ship it", team);
		state = applyTeamworkEvent(state, {
			type: "member.started",
			runId: "run-1",
			roleId: "worker-b",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			taskId: "t2",
			taskTitle: "Build UI",
		});
		state = applyTeamworkEvent(state, {
			type: "member.completed",
			runId: "run-1",
			roleId: "worker-a",
			provider: "openai",
			model: "gpt-5-mini",
			taskId: "t1",
			summary: "API done",
		});
		const lines = formatPanelLines(state, { expandedRoleIds: new Set() });
		expect(lines[0]).toBe("Teamwork 1/4 · pending");
		expect(lines).toContain("Leader · openai/gpt-5 · Planning");
		expect(lines).toContain("Workers");
		expect(lines).toContain("worker-a · openai/gpt-5-mini · ✓ Completed");
		expect(lines).toContain("worker-b · anthropic/claude-sonnet-4-5 · ● Working");
		expect(lines).toContain("Reviewer · anthropic/claude-sonnet-4-5 · ○ Pending");
	});

	it("caps worker rows at 12 with a more-line", () => {
		const bigTeam: TeamRoster = {
			leader: { provider: "openai", model: "gpt-5" },
			workers: Array.from({ length: 13 }, (_, i) => ({
				roleId: `worker-${i + 1}`,
				provider: "openai",
				model: "gpt-5-mini",
			})),
			reviewer: { provider: "anthropic", model: "claude-sonnet-4-5" },
		};
		const state = initPanelState("run-big", "big goal", bigTeam);
		const lines = formatPanelLines(state, { expandedRoleIds: new Set() });
		const workerRows = lines.filter((line) => line.startsWith("worker-"));
		expect(workerRows).toHaveLength(12);
		expect(lines).toContain("…1 more");
	});

	it("shows worker detail only when expanded, truncating summaries to 5 lines", () => {
		let state = initPanelState("run-1", "ship it", team);
		const longSummary = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
		state = applyTeamworkEvent(state, {
			type: "member.started",
			runId: "run-1",
			roleId: "worker-a",
			provider: "openai",
			model: "gpt-5-mini",
			taskId: "t1",
			taskTitle: "Build API",
		});
		state = applyTeamworkEvent(state, {
			type: "member.completed",
			runId: "run-1",
			roleId: "worker-a",
			provider: "openai",
			model: "gpt-5-mini",
			taskId: "t1",
			summary: longSummary,
		});
		const collapsed = formatPanelLines(state, { expandedRoleIds: new Set() });
		expect(collapsed.join("\n")).not.toContain("one");
		const expanded = formatPanelLines(state, { expandedRoleIds: new Set(["worker-a"]) });
		const text = expanded.join("\n");
		expect(text).toContain("Task: Build API");
		expect(text).toContain("Model: openai/gpt-5-mini");
		expect(text).toContain("Status: Completed");
		expect(text).toContain("five");
		expect(text).not.toContain("six");
	});

	it("returns zero lines for undefined state", () => {
		expect(formatPanelLines(undefined, { expandedRoleIds: new Set() })).toEqual([]);
	});
});
