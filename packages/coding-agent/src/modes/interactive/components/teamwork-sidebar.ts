import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	Container,
	Loader,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { VERSION } from "../../../config.ts";
import type { McpServerStatus } from "../../../core/mcp-manager.ts";
import { compareWorkerRoleIds, formatWorkerLabel } from "../../../core/teamwork/naming.ts";
import type { TeamworkPanelState } from "../../../core/teamwork/panel.ts";
import type { RoleModelRef, TeamMemberStatus } from "../../../core/teamwork/types.ts";
import { resolveEffectiveLeader } from "../teamwork-wizard.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import type { TeamworkPanelComponent } from "./teamwork-panel.ts";

export interface TeamworkSidebarData {
	sessionLine: string;
	contextLine: string;
	modelLine: string;
	roleModels: Record<string, RoleModelRef> | undefined;
	sessionModel: { provider: string; id: string; thinkingLevel?: ThinkingLevel };
	runLine?: string;
	extensionLines?: string[];
	/**
	 * Core MCP servers. Always rendered as a permanent "MCP" group, even when
	 * empty (placeholder row). Undefined is treated as no servers.
	 */
	mcpServers?: McpServerStatus[];
	/** Config-level MCP failure (unreadable mcp.json). Rendered as an err row. */
	mcpError?: string;
	/** Work descriptions by worker role id, as named by the leader (`worker1` → `UI designer`). */
	workerDescriptions?: Record<string, string>;
	/**
	 * Rows the sidebar may occupy. Workers are folded to fit instead of being clipped, so
	 * the reviewer row, the run line and the brand row always stay visible. When absent,
	 * {@link MAX_SIDEBAR_WORKERS} applies.
	 */
	viewportHeight?: number;
	/** True while a task is working: the brand spinner animates, otherwise it stays still. */
	spinning: boolean;
	/** Live per-member statuses from the run panel. Absent while idle. */
	statuses?: TeamworkMemberStatuses;
}

/** Worker rows shown when the available height is unknown. */
export const MAX_SIDEBAR_WORKERS = 4;

/**
 * Ceiling for height-driven folding: past this many workers the roster stops being the
 * useful part of the sidebar, and the fold row reports the remainder.
 */
export const MAX_SIDEBAR_WORKERS_CEILING = 12;

/** Breathing frames for the per-member working indicator. */
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_INTERVAL_MS = 80;

/** The frame gutter every sidebar line carries. */
const GUTTER = "│ ";
const GUTTER_CONTINUATION = "│   ";

/** Narrowest inner text width; below this wrapping would be one character per line. */
const MIN_INNER_WIDTH = 12;

/** Rows reserved for the embedded run panel when folding workers. */
const RUN_PANEL_RESERVE = 5;

function formatSidebarBinding(ref: RoleModelRef): string {
	return `${ref.provider}/${ref.model} · ${ref.thinkingLevel ?? "off"}`;
}

export interface TeamworkMemberStatuses {
	leader: TeamMemberStatus;
	workers: Record<string, TeamMemberStatus>;
	reviewer: TeamMemberStatus;
	/** Work descriptions by worker role id, from the live run. */
	descriptions?: Record<string, string>;
}

export function toTeamworkMemberStatuses(state: TeamworkPanelState): TeamworkMemberStatuses {
	const workers: Record<string, TeamMemberStatus> = {};
	const descriptions: Record<string, string> = {};
	for (const member of state.members) {
		if (member.kind === "worker" && member.roleId !== undefined) {
			workers[member.roleId] = member.status;
			if (member.description !== undefined) descriptions[member.roleId] = member.description;
		}
	}
	return {
		leader: state.members.find((member) => member.kind === "leader")?.status ?? "pending",
		workers,
		reviewer: state.members.find((member) => member.kind === "reviewer")?.status ?? "pending",
		...(Object.keys(descriptions).length === 0 ? {} : { descriptions }),
	};
}

export interface TeamworkSidebarRow {
	text: string;
	/** Clickable reconfigure target. Absent for non-interactive rows. */
	role?: string;
	/** True while this member is actively working: render the spinning frame. */
	active: boolean;
	title?: boolean;
	dim?: boolean;
	/**
	 * Secondary content that may be shed when the height budget is tight:
	 * extension statuses first, then the remaining keyed rows (run, MCP).
	 * The roster always wins.
	 */
	key?: "extensions" | "run" | "mcp";
}

/** Placeholder row shown when no worker is configured yet. */
const EMPTY_WORKERS_ROW = "· 暂无（/teamwork bind …）";

/** ANSI escape matcher for extension status text (themed lamps carry color codes). */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Extension status lines starting with a `●` lamp render without the default
 * `· ` bullet, so the lamp sits at the left edge of the row (MCP server
 * health: green = healthy, red = problem).
 */
export function isLampStatusLine(text: string): boolean {
	return text.replace(ANSI_PATTERN, "").startsWith("●");
}

/** Fold indicator for workers hidden by the height budget. */
function workerFoldRow(hidden: number, hiddenActive = false): TeamworkSidebarRow {
	if (hiddenActive) return { text: `…${hidden} more ●`, active: true, dim: false };
	return { text: `…${hidden} more`, active: false, dim: true };
}

export interface TeamworkSidebarSections {
	/** Rows above the worker roster. */
	before: TeamworkSidebarRow[];
	/** One row per configured worker, in natural worker order. */
	workers: TeamworkSidebarRow[];
	/** Rows below the worker roster. */
	after: TeamworkSidebarRow[];
}

/** Worker role ids from the configured bindings plus any role the live run reported. */
export function sidebarWorkerRoles(data: TeamworkSidebarData): string[] {
	const configured = Object.keys(data.roleModels ?? {}).filter((role) => role !== "leader" && role !== "reviewer");
	const live = Object.keys(data.statuses?.workers ?? {});
	const roles = new Set([...configured, ...live]);
	return [...roles].sort(compareWorkerRoleIds);
}

/**
 * One sidebar row per core MCP server. The `●` lamp leads the row (green =
 * healthy, red = problem, dim = transitional) so it sits at the left edge.
 * Error rows carry the (secret-free) reason so the sidebar alone is enough
 * to tell a missing key from a network or auth failure.
 */
export function formatMcpServerRow(server: McpServerStatus): string {
	switch (server.state) {
		case "ok":
			return `${theme.fg("success", "●")} ${server.name} ${server.toolCount} tools`;
		case "err": {
			const reason = server.error?.trim();
			const suffix = reason ? `: ${reason.slice(0, 80)}` : "";
			return `${theme.fg("error", "●")} ${server.name} err${suffix}`;
		}
		case "connecting":
			return `${theme.fg("dim", "●")} ${server.name} connecting`;
		case "off":
			return `${theme.fg("dim", "●")} ${server.name} off`;
	}
}

/**
 * Split the sidebar into its sections. The worker roster is separate because its length is
 * what adapts to the available height.
 */
export function formatTeamworkSidebarSections(data: TeamworkSidebarData): TeamworkSidebarSections {
	const leader = resolveEffectiveLeader(data.roleModels, data.sessionModel);
	const workers = sidebarWorkerRoles(data);
	const reviewer = data.roleModels?.reviewer;
	const isActive = (role: string): boolean => {
		const statuses = data.statuses;
		if (!statuses) return false;
		if (role === "leader") return statuses.leader === "working";
		if (role === "reviewer") return statuses.reviewer === "reviewing";
		return statuses.workers[role] === "working";
	};
	const before: TeamworkSidebarRow[] = [
		{ text: "会话", active: false, title: true },
		{ text: `· ${data.sessionLine}`, active: false },
		{ text: "Context", active: false, title: true },
		{ text: `· ${data.contextLine}`, active: false },
		{ text: "Leader", active: false, title: true },
		{ text: `· ${formatSidebarBinding(leader)}`, active: isActive("leader"), role: "leader" },
		{ text: "Workers", active: false, title: true },
	];
	const workerRows: TeamworkSidebarRow[] = workers.map((role) => {
		const ref = data.roleModels?.[role];
		const description = data.workerDescriptions?.[role] ?? data.statuses?.descriptions?.[role];
		const label = formatWorkerLabel(role, description);
		const binding = ref ? formatSidebarBinding(ref) : "未绑定";
		return {
			// `worker1（UI designer）` keeps its parentheses, so bind them separately to avoid `((`.
			text: description ? `· ${label} · ${binding}` : `· ${label}(${binding})`,
			active: isActive(role),
			role,
		};
	});
	const after: TeamworkSidebarRow[] = [
		{ text: "Reviewer", active: false, title: true },
		{
			text: reviewer ? `· ${formatSidebarBinding(reviewer)}` : "· 未配置",
			active: isActive("reviewer"),
			role: "reviewer",
			dim: reviewer === undefined,
		},
	];
	after.push({ text: "MCP", active: false, title: true, key: "mcp" });
	if (data.mcpError !== undefined) {
		after.push({ text: `${theme.fg("error", "●")} 配置读取失败`, active: false, key: "mcp" });
	}
	const mcpServers = data.mcpServers ?? [];
	if (mcpServers.length === 0 && data.mcpError === undefined) {
		after.push({ text: "○ 未配置（对话说“接上 originkit”）", active: false, dim: true, key: "mcp" });
	}
	for (const server of mcpServers) {
		after.push({ text: formatMcpServerRow(server), active: false, key: "mcp" });
	}
	// The run row only exists while a run is active: an idle placeholder here
	// reads as a Reviewer item. It gets its own section so it is never
	// misattributed, and it is the first row shed when height runs out.
	if (data.runLine !== undefined) {
		after.push({ text: "任务", active: false, title: true, key: "run" });
		after.push({ text: data.runLine, active: false, key: "run" });
	}
	if (data.extensionLines && data.extensionLines.length > 0) {
		after.push({ text: "扩展", active: false, title: true, key: "extensions" });
		for (const text of data.extensionLines) {
			after.push({ text: isLampStatusLine(text) ? text : `· ${text}`, active: false, key: "extensions" });
		}
	}
	return { before, workers: workerRows, after };
}

export function formatTeamworkSidebarRows(
	data: TeamworkSidebarData,
	options: { maxWorkers?: number } = {},
): TeamworkSidebarRow[] {
	const sections = formatTeamworkSidebarSections(data);
	const maxWorkers = options.maxWorkers ?? MAX_SIDEBAR_WORKERS;
	const rows = [...sections.before];
	if (sections.workers.length === 0) {
		rows.push({ text: EMPTY_WORKERS_ROW, active: false, dim: true });
	} else {
		rows.push(...sections.workers.slice(0, maxWorkers));
		if (sections.workers.length > maxWorkers) {
			const hiddenActive = sections.workers.slice(maxWorkers).some((row) => row.active);
			rows.push(workerFoldRow(sections.workers.length - maxWorkers, hiddenActive));
		}
	}
	rows.push(...sections.after);
	return rows;
}

function sidebarHeader(width?: number): string {
	if (width !== undefined && width < 36) return theme.bold(theme.fg("accent", "【teamwork】"));
	return theme.bold(theme.fg("accent", "【teamwork】· Esc×2退出"));
}

function sidebarHints(): string {
	return theme.fg("dim", "bind · exit · 双Esc退出");
}

/**
 * Framed sidebar panel for teamwork mode: Leader / Workers / Reviewer top-to-bottom, plus
 * an optional run-status line and hints.
 *
 * The column is narrow by design, so text wraps instead of being truncated: at any width
 * every value stays readable, continuation lines keep the frame gutter, and the worker
 * roster folds only when the height budget runs out.
 */
export class TeamworkSidebarComponent extends VStack {
	private readonly tui: TUI;
	private readonly brand: Loader;
	private runPanel: TeamworkPanelComponent | undefined = undefined;
	private onSelectRole: ((role: string) => void) | undefined;
	private currentData: TeamworkSidebarData | undefined = undefined;
	private spinTimer: ReturnType<typeof setInterval> | undefined = undefined;
	private spinFrame = 0;
	private lastRenderWidth = 0;

	constructor(tui: TUI, data: TeamworkSidebarData, onSelectRole?: (role: string) => void) {
		super();
		this.tui = tui;
		this.onSelectRole = onSelectRole;
		this.brand = new Loader(
			tui,
			(text) => theme.fg("accent", text),
			(text) => theme.fg("dim", text),
			`C-code v${VERSION}`,
		);
		this.setData(data);
	}

	/** Stop all animations; call before dropping the sidebar. */
	dispose(): void {
		this.stopSpinTimer();
		this.brand.stop();
	}

	/** Embed the live run panel between the roster and the bottom-pinned brand row. */
	setRunPanel(panel: TeamworkPanelComponent | undefined): void {
		this.runPanel = panel;
		this.rebuild();
	}

	setOnSelectRole(onSelectRole: ((role: string) => void) | undefined): void {
		this.onSelectRole = onSelectRole;
	}

	/** Rows currently rendered with a spinning indicator (for tests and debugging). */
	getSpinningRoles(): string[] {
		if (!this.currentData) return [];
		// Any working member animates the visible roster, even one folded out of view.
		return formatTeamworkSidebarRows(this.currentData, { maxWorkers: MAX_SIDEBAR_WORKERS_CEILING })
			.filter((row) => row.active && row.role !== undefined)
			.map((row) => row.role as string);
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		// The roster folds and rows wrap against the width the layout actually granted,
		// which changes on terminal resize.
		if (safeWidth !== this.lastRenderWidth) this.rebuild(safeWidth, false);
		return super.render(safeWidth);
	}

	/** Wrap one row to the column, keeping the frame gutter on every physical line. */
	private wrapRow(row: TeamworkSidebarRow, width: number): string[] {
		let text = row.text;
		if (row.active) {
			const folded = text.startsWith("…");
			text = folded
				? text.replace(/●?$/, `${SPIN_FRAMES[this.spinFrame % SPIN_FRAMES.length]}`)
				: text.replace(/^· /, `${SPIN_FRAMES[this.spinFrame % SPIN_FRAMES.length]} `);
		}
		// Titles follow the mode accent (plan黄/build绿/yolo红 via the active
		// theme); values stay default text so working rows stand out.
		const styled = row.active
			? theme.bold(theme.fg("accent", text))
			: row.title
				? theme.fg("accent", text)
				: row.dim
					? theme.fg("dim", text)
					: text;
		const clickable = row.role !== undefined && this.onSelectRole !== undefined;
		const inner = Math.max(MIN_INNER_WIDTH, width - GUTTER.length - (clickable ? 2 : 0));
		const wrapped = wrapTextWithAnsi(styled, inner);
		return wrapped.map((line, index) => {
			// Pin the reconfigure affordance to the last physical line: the first
			// line can be a lone bullet when a long value wraps immediately, and
			// stranding `↻` there wastes a row and reads as broken output.
			const isLast = index === wrapped.length - 1;
			const body = isLast && clickable ? `${line} ${theme.fg("dim", "↻")}` : line;
			// Indent continuations under the bullet so a wrapped value reads as one item.
			return `${index === 0 ? GUTTER : GUTTER_CONTINUATION}${body}`;
		});
	}

	private wrapRows(rows: readonly TeamworkSidebarRow[], width: number): string[][] {
		return rows.map((row) => this.wrapRow(row, width));
	}

	private wrapClickable(lines: string[], role: string): MouseRegion | Text {
		const block = new Text(lines.join("\n"), 0, 0);
		if (!this.onSelectRole) return block;
		const callback = this.onSelectRole;
		return new MouseRegion(block, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			callback(role);
			return { handled: true };
		});
	}

	private stopSpinTimer(): void {
		if (this.spinTimer !== undefined) {
			clearInterval(this.spinTimer);
			this.spinTimer = undefined;
		}
	}

	private syncSpinTimer(): void {
		const statuses = this.currentData?.statuses;
		const anyActive =
			statuses !== undefined &&
			(statuses.leader === "working" ||
				statuses.reviewer === "reviewing" ||
				Object.values(statuses.workers).some((status) => status === "working"));
		if (!anyActive) {
			this.stopSpinTimer();
			this.spinFrame = 0;
			return;
		}
		if (this.spinTimer !== undefined) return;
		this.spinTimer = setInterval(() => {
			this.spinFrame = (this.spinFrame + 1) % SPIN_FRAMES.length;
			this.rebuild();
			this.tui.requestRender();
		}, SPIN_INTERVAL_MS);
		this.spinTimer.unref();
	}

	setData(data: TeamworkSidebarData): void {
		this.currentData = data;
		this.syncSpinTimer();
		this.rebuild();
		if (data.spinning) this.brand.start();
		else this.brand.stop();
		this.tui.requestRender();
	}

	/**
	 * How many worker rows fit with `after` rendered: the height budget minus everything
	 * else that must stay visible (framing, the fixed sections, hints, brand, and room for
	 * the run panel).
	 */
	private workerCapacity(
		width: number,
		sections: TeamworkSidebarSections,
		after: readonly TeamworkSidebarRow[],
		viewportHeight: number,
	): number {
		const hintsLines = width < 36 ? 0 : 1;
		const fixedLines =
			this.wrapRows(sections.before, width).reduce((sum, lines) => sum + lines.length, 0) +
			this.wrapRows(after, width).reduce((sum, lines) => sum + lines.length, 0) +
			3 + // top border, header, section border
			hintsLines +
			1 + // brand
			(this.runPanel ? RUN_PANEL_RESERVE : 0);
		const budget = viewportHeight - fixedLines;
		const workerLines = this.wrapRows(sections.workers, width);
		let fit = 0;
		let used = 0;
		for (const lines of workerLines) {
			// Count the fold row while it is still needed, so folding never overflows.
			const foldLines = fit + 1 < workerLines.length ? 1 : 0;
			if (used + lines.length + foldLines > budget) break;
			used += lines.length;
			fit++;
		}
		return Math.min(MAX_SIDEBAR_WORKERS_CEILING, Math.max(0, fit));
	}

	/**
	 * Rows to render: the roster folds to the available height, and when not even one worker
	 * fits, secondary rows are shed before the roster is dropped.
	 */
	private layoutRows(width: number): TeamworkSidebarRow[] {
		const data = this.currentData;
		if (!data) return [];
		const sections = formatTeamworkSidebarSections(data);
		const compose = (after: readonly TeamworkSidebarRow[], limit: number): TeamworkSidebarRow[] => {
			const rows = [...sections.before];
			if (sections.workers.length === 0) {
				rows.push({ text: EMPTY_WORKERS_ROW, active: false, dim: true });
			} else {
				rows.push(...sections.workers.slice(0, limit));
				if (sections.workers.length > limit) {
					const hiddenActive = sections.workers.slice(limit).some((row) => row.active);
					rows.push(workerFoldRow(sections.workers.length - limit, hiddenActive));
				}
			}
			rows.push(...after);
			return rows;
		};

		const viewportHeight = data.viewportHeight;
		if (viewportHeight === undefined || viewportHeight <= 0) {
			return compose(sections.after, MAX_SIDEBAR_WORKERS);
		}
		const variants: TeamworkSidebarRow[][] = [
			sections.after,
			sections.after.filter((row) => row.key !== "extensions"),
			sections.after.filter((row) => row.key === undefined),
		];
		for (const after of variants) {
			const limit = this.workerCapacity(width, sections, after, viewportHeight);
			if (limit > 0 || sections.workers.length === 0) return compose(after, limit);
		}
		// No room even for the trimmed layout: keep one worker and let the tail clip.
		return compose(variants[variants.length - 1]!, 1);
	}

	private rebuild(width = this.lastRenderWidth || 40, requestRender = true): void {
		const data = this.currentData;
		if (!data) return;
		const safeWidth = Math.max(1, Math.floor(width));
		this.lastRenderWidth = safeWidth;
		this.clear();
		const rows = this.layoutRows(safeWidth);

		const content = new Container();
		const accentBorder = new DynamicBorder((text) => theme.fg("accent", text));
		content.addChild(accentBorder);
		content.addChild(new Text(sidebarHeader(safeWidth), 0, 0));
		content.addChild(accentBorder);
		for (const row of rows) {
			const lines = this.wrapRow(row, safeWidth);
			content.addChild(
				row.role === undefined ? new Text(lines.join("\n"), 0, 0) : this.wrapClickable(lines, row.role),
			);
		}
		// Narrow columns drop the hints row: model/session/worker content wins the height budget.
		if (safeWidth >= 36) {
			content.addChild(new Text(this.wrapRow({ text: sidebarHints(), active: false }, safeWidth).join("\n"), 0, 0));
		}
		this.addChild(content);
		if (this.runPanel) this.addChild(this.runPanel);
		this.addChild(new Spacer(1), { grow: 1 });
		this.addChild(this.brand);
		if (requestRender) this.tui.requestRender();
	}
}
