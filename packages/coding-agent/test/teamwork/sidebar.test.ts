import { beforeAll, describe, expect, it } from "vitest";
import {
	formatMcpServerRow,
	formatTeamworkSidebarRows,
	TeamworkSidebarComponent,
	toTeamworkMemberStatuses,
} from "../../src/modes/interactive/components/teamwork-sidebar.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

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
			"Leader",
			"· x/lead · off",
			"Workers",
			"· worker-a(o/same · off)",
			"· worker-b(p/other · off)",
			"Reviewer",
			"· a/rev · off",
			"MCP",
			"○ 未配置（对话说“接上 originkit”）",
		]);
	});

	it("renders neither a model nor a mode section", () => {
		const lines = formatTeamworkSidebarRows(base).map((row) => row.text);
		expect(lines).not.toContain("模型");
		expect(lines).not.toContain("模式");
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

	it("renders ● lamp status lines without the default bullet", () => {
		const green = "[32m●[0m originkit 4 tools";
		const lines = formatTeamworkSidebarRows({
			...base,
			extensionLines: ["● originkit 4 tools", green, "plain status"],
		}).map((row) => row.text);
		expect(lines).toContain("扩展");
		expect(lines).toContain("● originkit 4 tools");
		expect(lines).toContain(green);
		expect(lines).toContain("· plain status");
		expect(lines).not.toContain("· ● originkit 4 tools");
	});

	it("always shows the MCP group, even with no servers", () => {
		const lines = formatTeamworkSidebarRows(base).map((row) => row.text);
		const mcpIndex = lines.indexOf("MCP");
		expect(mcpIndex).toBeGreaterThan(-1);
		expect(lines[mcpIndex + 1]).toContain("○ 未配置");
	});

	it("shows one lamp row per MCP server", () => {
		const lines = formatTeamworkSidebarRows({
			...base,
			mcpServers: [
				{ name: "originkit", state: "ok", toolCount: 4 },
				{ name: "broken", state: "err", toolCount: 0, error: "401" },
			],
		}).map((row) => row.text);
		expect(lines).toContain("MCP");
		expect(lines.some((line) => line.includes("originkit") && line.includes("4 tools"))).toBe(true);
		expect(lines.some((line) => line.includes("broken") && line.includes("err"))).toBe(true);
		expect(lines.some((line) => line.includes("○ 未配置"))).toBe(false);
	});

	it("shows config errors as an MCP err row", () => {
		const lines = formatTeamworkSidebarRows({ ...base, mcpError: "bad json" }).map((row) => row.text);
		expect(lines.some((line) => line.includes("配置读取失败"))).toBe(true);
	});

	it("formats MCP server rows with a leading lamp", () => {
		expect(formatMcpServerRow({ name: "o", state: "ok", toolCount: 2 })).toContain("o 2 tools");
		expect(
			formatMcpServerRow({ name: "o", state: "err", toolCount: 0 })
				.replace(/\[[0-9;]*m/g, "")
				.startsWith("●"),
		).toBe(true);
		expect(formatMcpServerRow({ name: "o", state: "connecting", toolCount: 0 })).toContain("connecting");
	});

	it("shows the MCP error reason on err rows instead of a bare err", () => {
		const withReason = formatMcpServerRow({
			name: "originkit",
			state: "err",
			toolCount: 0,
			error: "missing ORIGINKIT_API_KEY",
		}).replace(/\[[0-9;]*m/g, "");
		expect(withReason).toContain("originkit err: missing ORIGINKIT_API_KEY");
		const withoutReason = formatMcpServerRow({ name: "o", state: "err", toolCount: 0 }).replace(/\[[0-9;]*m/g, "");
		expect(withoutReason).toBe("● o err");
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

	it("keeps session info visible in the narrow column without hints crowding it", () => {
		const longSession = "a-very-long-session-name-that-must-stay-visible (main)";
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			sessionLine: longSession,
			contextLine: "c",
			modelLine: "unused",
			roleModels: undefined,
			sessionModel: { provider: "o", id: "s" },
			spinning: false,
		});
		const text = sidebar
			.render(30)
			.join("\n")
			.replace(/\u001b\[[0-9;]*m/g, "");
		// Session value wraps instead of being truncated away; the model section is gone.
		expect(text).toContain("会话");
		expect(text).not.toContain("模型");
		expect(text.replace(/[│\s]/g, "")).toContain("a-very-long-session-name-that-must-stay-visible(main)");
		// Narrow column drops the hints row to save height for session content.
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
			expect(flat).not.toContain("(ollama)qwen3.5:9b-q4_K_M·medium");
			expect(text).not.toContain("...");
			sidebar.dispose();
		}
	});
});

describe("teamwork sidebar working indicators", () => {
	it("highlights working rows with accent so the lamp is visible", () => {
		const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			sessionLine: "s",
			contextLine: "c",
			modelLine: "m",
			roleModels: {
				leader: { provider: "o", model: "lead" },
				worker1: { provider: "o", model: "same" },
				reviewer: { provider: "a", model: "r" },
			},
			sessionModel: { provider: "o", id: "s" },
			spinning: false,
			statuses: { leader: "working", workers: { worker1: "working" }, reviewer: "pending" },
		});
		const text = sidebar.render(60).join("\n");
		// Active rows carry ANSI styling (accent bold); idle bullets do not.
		const stripped = text.replace(/\u001b\[[0-9;]*m/g, "");
		expect(stripped).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] worker1\(/);
		const spinnerLine = text.split("\n").find((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line.replace(/\u001b\[[0-9;]*m/g, "")));
		expect(spinnerLine).toContain("\u001b");
		sidebar.dispose();
	});

	it("marks the fold row active when hidden workers are working", () => {
		const roleModels: Record<string, { provider: string; model: string }> = {};
		for (let i = 1; i <= 3; i++) roleModels[`worker${i}`] = { provider: "o", model: "m" };
		const rows = formatTeamworkSidebarRows(
			{
				...base,
				roleModels,
				statuses: {
					leader: "completed",
					workers: { worker1: "completed", worker2: "completed", worker3: "working" },
					reviewer: "pending",
				},
			},
			{ maxWorkers: 1 },
		);
		const fold = rows.find((row) => row.text.startsWith("…"));
		expect(fold?.active).toBe(true);
		expect(fold?.text).toContain("●");
	});
});

describe("teamwork sidebar breathing lamp", () => {
	it("exposes idle bullet rows for the wrapRow lamp", () => {
		const rows = formatTeamworkSidebarRows({ ...base, statuses: undefined });
		const workerRow = rows.find((row) => row.role === "worker-a");
		expect(workerRow?.active).toBe(false);
		expect(workerRow?.text.startsWith("· ")).toBe(true);
	});

	it("marks idle member rows with lamp text while keeping active flag false", () => {
		const rows = formatTeamworkSidebarRows({ ...base, statuses: undefined });
		const lampTargets = rows.filter((row) => !row.title && row.text.startsWith("· "));
		expect(lampTargets.length).toBeGreaterThan(0);
		for (const row of lampTargets) expect(row.active).toBe(false);
	});

	it("flags the working member active so wrapRow renders the spin frame", () => {
		const rows = formatTeamworkSidebarRows({
			...base,
			statuses: { leader: "pending", workers: { "worker-a": "working" }, reviewer: "pending" },
		});
		expect(rows.find((row) => row.role === "worker-a")?.active).toBe(true);
		expect(rows.find((row) => row.role === "worker-b")?.active).toBe(false);
	});

	it("renders idle lamps, active spin frames, and lamp-free titles", () => {
		const idle = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			...base,
			statuses: undefined,
		});
		const idleText = idle.render(60).join("\n");
		expect(idleText).toContain(theme.fg("dim", "●"));
		const strippedIdle = idleText.replace(/\[[0-9;]*m/g, "");
		expect(strippedIdle).toContain("● worker-a(");
		expect(strippedIdle).not.toContain("· worker-a(");
		const titleLine = strippedIdle.split("\n").find((line) => line.includes("Workers"));
		expect(titleLine).toBeDefined();
		expect(titleLine).not.toContain("●");
		idle.dispose();
		const active = new TeamworkSidebarComponent({ requestRender: () => {} } as never, {
			...base,
			statuses: { leader: "pending", workers: { "worker-a": "working" }, reviewer: "pending" },
		});
		const strippedActive = active
			.render(60)
			.join("\n")
			.replace(/\[[0-9;]*m/g, "");
		expect(strippedActive).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] worker-a\(/);
		active.dispose();
	});
});
