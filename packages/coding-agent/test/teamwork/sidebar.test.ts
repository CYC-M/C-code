import { beforeAll, describe, expect, it } from "vitest";
import {
	formatTeamworkSidebarRows,
	TeamworkSidebarComponent,
	toTeamworkMemberStatuses,
} from "../../src/modes/interactive/components/teamwork-sidebar.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

const base = {
	sessionLine: "my-session (main)",
	contextLine: "12.4k tokens · 20% used",
	modelLine: "(ollama) qwen3.5:9b · medium",
	roleModels: {
		leader: { provider: "x", model: "lead" },
		"worker-a": { provider: "o", model: "same" },
		"worker-b": { provider: "p", model: "other" },
		reviewer: { provider: "a", model: "rev" },
	},
	sessionModel: { provider: "o", id: "s" },
	spinning: false,
};

describe("teamwork sidebar formatTeamworkSidebarRows", () => {
	it("orders sections with one row per worker", () => {
		expect(formatTeamworkSidebarRows(base).map((row) => row.text)).toEqual([
			"会话",
			"· my-session (main)",
			"Context",
			"· 12.4k tokens · 20% used",
			"模型",
			"· (ollama) qwen3.5:9b · medium",
			"Leader",
			"· x/lead · off",
			"Workers",
			"· worker-a(o/same · off)",
			"· worker-b(p/other · off)",
			"Reviewer",
			"· a/rev · off",
		]);
	});

	it("hides the run row while idle instead of showing a placeholder under Reviewer", () => {
		const lines = formatTeamworkSidebarRows(base).map((row) => row.text);
		expect(lines).not.toContain("· 暂无任务，直接输入目标开始");
		expect(lines).not.toContain("任务");
	});

	it("marks team rows clickable with their role ids", () => {
		const roles = new Map(
			formatTeamworkSidebarRows(base)
				.filter((row) => row.role !== undefined)
				.map((row) => [row.text, row.role] as const),
		);
		expect(roles.get("· x/lead · off")).toBe("leader");
		expect(roles.get("· worker-a(o/same · off)")).toBe("worker-a");
		expect(roles.get("· worker-b(p/other · off)")).toBe("worker-b");
		expect(roles.get("· a/rev · off")).toBe("reviewer");
	});

	it("shows empty states for workers, reviewer, and extensions", () => {
		const lines = formatTeamworkSidebarRows({
			...base,
			roleModels: undefined,
			extensionLines: [],
		}).map((row) => row.text);
		expect(lines).toContain("· o/s · off");
		expect(lines).toContain("· 暂无（/teamwork bind …）");
		expect(lines).toContain("· 未配置");
		expect(lines).not.toContain("扩展");
	});

	it("shows thinking suffixes when roles configure them", () => {
		const lines = formatTeamworkSidebarRows({
			...base,
			roleModels: {
				leader: { provider: "x", model: "lead", thinkingLevel: "medium" },
				"worker-a": { provider: "o", model: "same", thinkingLevel: "high" },
				reviewer: { provider: "a", model: "rev" },
			},
		}).map((row) => row.text);
		expect(lines).toContain("· x/lead · medium");
		expect(lines).toContain("· worker-a(o/same · high)");
		expect(lines).toContain("· a/rev · off");
	});

	it("folds worker rows beyond four entries", () => {
		const roleModels: Record<string, { provider: string; model: string }> = {};
		for (let i = 1; i <= 6; i++) roleModels[`worker-${i}`] = { provider: "o", model: "m" };
		const lines = formatTeamworkSidebarRows({ ...base, roleModels }).map((row) => row.text);
		expect(lines).toContain("· worker-4(o/m · off)");
		expect(lines.join("\n")).not.toContain("worker-5(");
		expect(lines).toContain("…2 more");
	});

	it("marks only the working members active", () => {
		const rows = formatTeamworkSidebarRows({
			...base,
			statuses: {
				leader: "working",
				workers: { "worker-a": "working", "worker-b": "completed" },
				reviewer: "pending",
			},
		});
		expect(rows.filter((row) => row.active).map((row) => row.text)).toEqual([
			"· x/lead · off",
			"· worker-a(o/same · off)",
		]);
	});

	it("marks the reviewer active while reviewing", () => {
		const rows = formatTeamworkSidebarRows({
			...base,
			statuses: {
				leader: "completed",
				workers: { "worker-a": "completed", "worker-b": "completed" },
				reviewer: "reviewing",
			},
		});
		expect(rows.filter((row) => row.active).map((row) => row.text)).toEqual(["· a/rev · off"]);
	});

	it("appends the run line as its own section plus extension statuses", () => {
		const lines = formatTeamworkSidebarRows({
			...base,
			runLine: "· run-1 运行中",
			extensionLines: ["originkit Connected"],
		}).map((row) => row.text);
		expect(lines).toContain("任务");
		expect(lines).toContain("· run-1 运行中");
		expect(lines).toContain("扩展");
		expect(lines).toContain("· originkit Connected");
	});
});

describe("teamwork toTeamworkMemberStatuses", () => {
	it("maps panel members to role statuses", () => {
		expect(
			toTeamworkMemberStatuses({
				runId: "run-1",
				goal: "g",
				phase: "collecting",
				members: [
					{ kind: "leader", provider: "o", model: "m", status: "working" },
					{ kind: "worker", roleId: "worker-a", provider: "o", model: "m", status: "working" },
					{ kind: "worker", roleId: "worker-b", provider: "o", model: "m", status: "pending" },
					{ kind: "reviewer", provider: "a", model: "r", status: "pending" },
				],
				verdict: undefined,
			}),
		).toEqual({
			leader: "working",
			workers: { "worker-a": "working", "worker-b": "pending" },
			reviewer: "pending",
		});
	});
});

describe("teamwork sidebar per-member spinners", () => {
	function spinData() {
		return {
			sessionLine: "s",
			contextLine: "c",
			modelLine: "m",
			roleModels: {
				"worker-a": { provider: "o", model: "same" },
				"worker-b": { provider: "p", model: "other" },
				reviewer: { provider: "a", model: "r" },
			},
			sessionModel: { provider: "o", id: "s" },
			spinning: false,
			statuses: {
				leader: "working" as const,
				workers: { "worker-a": "working" as const, "worker-b": "completed" as const },
				reviewer: "pending" as const,
			},
		};
	}

	it("spins exactly the working rows and reports them", () => {
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, spinData());
		expect(sidebar.getSpinningRoles().sort()).toEqual(["leader", "worker-a"]);
		const text = sidebar.render(60).join("\n");
		expect(text).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] worker-a\(/);
		expect(text).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] worker-b\(/);
		sidebar.dispose();
	});

	it("stays still with no statuses", () => {
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			...spinData(),
			statuses: undefined,
		});
		expect(sidebar.getSpinningRoles()).toEqual([]);
		const memberLines = sidebar
			.render(60)
			.join("\n")
			.split("\n")
			.filter((line) => line.includes("worker-") || line.includes("Reviewer") || line.includes("Leader"));
		expect(memberLines.join("\n")).not.toContain("⠋");
		sidebar.dispose();
	});
});

describe("teamwork sidebar brand row", () => {
	it("renders the C-code brand with version at the bottom", () => {
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			sessionLine: "s",
			contextLine: "c",
			modelLine: "m",
			roleModels: undefined,
			sessionModel: { provider: "o", id: "s" },
			spinning: false,
		});
		const text = sidebar.render(60).join("\n");
		expect(text).toContain("C-code v");
		sidebar.dispose();
	});

	it("marks clickable rows with an affordance only when a handler is set", () => {
		const withHandler = new TeamworkSidebarComponent(
			{ requestRender: () => {} } as never,
			{
				sessionLine: "s",
				contextLine: "c",
				modelLine: "m",
				roleModels: { reviewer: { provider: "a", model: "r" } },
				sessionModel: { provider: "o", id: "s" },
				spinning: false,
			},
			() => {},
		);
		const marked = withHandler.render(60).join("\n");
		expect(marked).toContain("↻");
		withHandler.dispose();
		const plain = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			sessionLine: "s",
			contextLine: "c",
			modelLine: "m",
			roleModels: undefined,
			sessionModel: { provider: "o", id: "s" },
			spinning: false,
		});
		expect(plain.render(60).join("\n")).not.toContain("↻");
		plain.dispose();
	});

	it("wraps long values at narrow widths instead of dropping them", () => {
		const data = {
			sessionLine: "a-very-long-session-name-that-keeps-going (main)",
			contextLine: "12.4k tokens · 20% used",
			modelLine: "(ollama) qwen3.5:9b-q4_K_M · medium",
			roleModels: {
				worker1: { provider: "o", model: "same" },
				worker2: { provider: "p", model: "other" },
			},
			sessionModel: { provider: "o", id: "s" },
			spinning: false,
		} as const;
		const wide = new TeamworkSidebarComponent({ requestRender: () => {} } as never, { ...data });
		const narrow = new TeamworkSidebarComponent({ requestRender: () => {} } as never, { ...data });
		const wideLines = wide.render(200);
		const narrowLines = narrow.render(28);
		// Narrower columns need more rows: the text wraps rather than being truncated.
		expect(narrowLines.length).toBeGreaterThan(wideLines.length);
		// Nothing is lost on the way: the full session name survives the wrap.
		const flatten = (lines: string[]): string =>
			lines
				.join("")
				.replace(/\u001b\[[0-9;]*m/g, "")
				.replace(/[│\s]/g, "");
		expect(flatten(narrowLines)).toContain("a-very-long-session-name-that-keeps-going(main)");
		wide.dispose();
		narrow.dispose();
	});

	it("shows the leader's work description next to each worker", () => {
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			...base,
			roleModels: {
				leader: { provider: "x", model: "lead" },
				worker1: { provider: "o", model: "same" },
				worker2: { provider: "p", model: "other" },
				reviewer: { provider: "a", model: "rev" },
			},
			workerDescriptions: { worker1: "UI designer", worker2: "Back-end architect" },
		});
		const text = sidebar.render(200).join("\n");
		expect(text).toContain("worker1（UI designer）");
		expect(text).toContain("worker2（Back-end architect）");
		sidebar.dispose();
	});

	it("folds workers by available height and keeps the reviewer row visible", () => {
		const roleModels: Record<string, { provider: string; model: string }> = {};
		for (let i = 1; i <= 8; i++) roleModels[`worker${i}`] = { provider: "o", model: "m" };
		const short = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			...base,
			roleModels,
			viewportHeight: 18,
		});
		const tall = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			...base,
			roleModels,
			viewportHeight: 60,
		});
		const shortText = short.render(40).join("\n");
		expect(shortText).toContain("…");
		expect(shortText).toContain("Reviewer");
		// Enough height shows the whole roster instead of folding it.
		const tallText = tall.render(40).join("\n");
		expect(tallText).toContain("worker8");
		expect(tallText).not.toContain("more");
		short.dispose();
		tall.dispose();
	});

	it("never folds the roster away, even when the height is tight", () => {
		const roleModels: Record<string, { provider: string; model: string }> = {
			leader: { provider: "x", model: "lead" },
			reviewer: { provider: "a", model: "rev" },
		};
		for (let i = 1; i <= 5; i++) roleModels[`worker${i}`] = { provider: "o", model: "m" };
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			...base,
			roleModels,
			viewportHeight: 12,
		});
		const text = sidebar.render(40).join("\n");
		expect(text).toContain("worker1");
		expect(text).toContain("…4 more");
		sidebar.dispose();
	});

	it("pins the brand row as the last line", () => {
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			sessionLine: "s",
			contextLine: "c",
			modelLine: "m",
			roleModels: undefined,
			sessionModel: { provider: "o", id: "s" },
			spinning: false,
		});
		const lines = sidebar.render(60);
		const brandIndex = lines.findIndex((line) => line.includes("C-code v"));
		expect(brandIndex).toBeGreaterThan(-1);
		expect(
			lines.slice(brandIndex + 1).every((line) => line.trim() === ""),
			"brand must be the last content row",
		).toBe(true);
		sidebar.dispose();
	});

	it("keeps model info visible in the narrow column without hints crowding it", () => {
		const longModel = "(very-long-provider-name) extremely-long-model-id-that-must-stay-visible · high";
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			sessionLine: "s",
			contextLine: "c",
			modelLine: longModel,
			roleModels: undefined,
			sessionModel: { provider: "o", id: "s" },
			spinning: false,
		});
		const text = sidebar
			.render(30)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");
		// Model value wraps instead of being truncated away.
		expect(text).toContain("模型");
		expect(text.replace(/[│\s]/g, "")).toContain("extremely-long-model-id-that-must-stay-visible".replace(/\s/g, ""));
		// Narrow column drops the hints row to save height for model/session content.
		expect(text).not.toContain("双Esc退出");
		sidebar.dispose();
	});

	it("shows full worker and reviewer bindings at narrow widths instead of ...", () => {
		const data = {
			sessionLine: "~/Desktop/C-code (main)",
			contextLine: "0 tokens · 0.0% used",
			modelLine: "(ollama) qwen3.5:9b-q4_K_M · medium",
			roleModels: {
				leader: { provider: "ollama", model: "qwen3.5:9b-q4_K_M", thinkingLevel: "medium" as const },
				"worker-a": { provider: "ollama", model: "qwen3.5:9b-q4_K_M", thinkingLevel: "medium" as const },
				reviewer: { provider: "xiaomi-token-plan-cn", model: "mimo-v2.6-flash" },
			},
			sessionModel: { provider: "ollama", id: "qwen3.5:9b-q4_K_M" },
			runLine: "· run-1 运行中",
			viewportHeight: 60,
			spinning: false,
		} as const;
		for (const width of [30, 40]) {
			const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, { ...data }, () => {});
			const text = sidebar
				.render(width)
				.join("\n")
				.replace(/\u001b\[[0-9;]*m/g, "");
			// Values wrap across physical lines; strip gutters/affordances and
			// the text must reassemble to the full bindings.
			const flat = text.replace(/[│↻\s]/g, "");
			expect(flat).toContain("worker-a(ollama/qwen3.5:9b-q4_K_M·medium)");
			expect(flat).toContain("xiaomi-token-plan-cn/mimo-v2.6-flash·off");
			expect(flat).toContain("(ollama)qwen3.5:9b-q4_K_M·medium");
			expect(text).not.toContain("...");
			sidebar.dispose();
		}
	});
});
