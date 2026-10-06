import { Container, MouseRegion, Text, type TUI } from "@earendil-works/pi-tui";
import { formatWorkerLabel } from "../../../core/teamwork/naming.ts";
import {
	applyTeamworkEvent,
	initPanelState,
	type PanelMember,
	settlePanelState,
	type TeamworkPanelState,
} from "../../../core/teamwork/panel.ts";
import type { TeamMemberStatus, TeamUsage, TeamworkEvent } from "../../../core/teamwork/types.ts";
import { theme } from "../theme/theme.ts";

export interface FormatPanelOptions {
	expandedRoleIds: Set<string>;
	maxWorkers?: number;
}

const DEFAULT_MAX_WORKERS = 12;
const SUMMARY_LINE_LIMIT = 5;

function statusGlyph(status: TeamMemberStatus): string {
	switch (status) {
		case "working":
			return "●";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "needs_fix":
			return "!";
		default:
			return "○";
	}
}

function formatStatus(status: TeamMemberStatus): string {
	switch (status) {
		case "pending":
			return "Pending";
		case "working":
			return "Working";
		case "completed":
			return "Completed";
		case "failed":
			return "Failed";
		case "reviewing":
			return "Reviewing";
		case "needs_fix":
			return "Needs fix";
	}
}

function leaderLabel(status: TeamMemberStatus): string {
	if (status === "working") return "Planning";
	if (status === "completed") return "Done";
	return formatStatus(status);
}

function headerLine(state: TeamworkPanelState): string {
	const done = state.members.filter((m) => m.status === "completed").length;
	return `Teamwork ${done}/${state.members.length} · ${state.phase}`;
}

function leaderRow(state: TeamworkPanelState): string | undefined {
	const leader = state.members.find((m) => m.kind === "leader");
	if (!leader) return undefined;
	return `Leader · ${leader.provider}/${leader.model} · ${leaderLabel(leader.status)}`;
}

function workerRow(
	roleId: string,
	provider: string,
	model: string,
	status: TeamMemberStatus,
	description?: string,
): string {
	return `${formatWorkerLabel(roleId, description)} · ${provider}/${model} · ${statusGlyph(status)} ${formatStatus(status)}`;
}

export function formatTokensShort(usage: TeamUsage | undefined): string {
	if (!usage) return "tokens: —";
	return `tokens: in ${usage.input} · out ${usage.output} · total ${usage.total}`;
}

export function formatTokensCache(usage: TeamUsage | undefined): string | undefined {
	if (!usage) return undefined;
	return `cache: read ${usage.cacheRead} · write ${usage.cacheWrite}`;
}

function tokenLine(usage: TeamUsage | undefined): string {
	return `  ${formatTokensShort(usage)}`;
}

function styleRow(text: string, status: TeamMemberStatus): string {
	switch (status) {
		case "working":
		case "reviewing":
			return theme.bold(theme.fg("accent", text));
		case "failed":
			return theme.fg("error", text);
		case "needs_fix":
			return theme.fg("warning", text);
		case "pending":
			return theme.fg("dim", text);
		default:
			return text;
	}
}

function styleDim(text: string): string {
	return theme.fg("dim", text);
}

function workerDetailLines(
	taskTitle: string | undefined,
	taskId: string | undefined,
	provider: string,
	model: string,
	status: TeamMemberStatus,
	summary: string | undefined,
): string[] {
	const lines = [
		`  Task: ${taskTitle ?? taskId ?? "—"}`,
		`  Model: ${provider}/${model}`,
		`  Status: ${formatStatus(status)}`,
	];
	if (summary !== undefined) {
		const summaryLines = summary.split("\n").slice(0, SUMMARY_LINE_LIMIT);
		for (const [index, line] of summaryLines.entries()) {
			lines.push(index === 0 ? `  Summary: ${line}` : `  ${line}`);
		}
	}
	return lines;
}

function reviewerRow(state: TeamworkPanelState): string | undefined {
	const reviewer = state.members.find((m) => m.kind === "reviewer");
	if (!reviewer) return undefined;
	return `Reviewer · ${reviewer.provider}/${reviewer.model} · ${statusGlyph(reviewer.status)} ${formatStatus(reviewer.status)}`;
}

export function formatPanelLines(state: TeamworkPanelState | undefined, opts: FormatPanelOptions): string[] {
	if (!state) return [];
	const maxWorkers = opts.maxWorkers ?? DEFAULT_MAX_WORKERS;
	const lines: string[] = [headerLine(state)];
	const leader = leaderRow(state);
	if (leader) lines.push(leader);
	lines.push("│");
	lines.push("▼");
	lines.push("Workers");
	const workers = state.members.filter((m) => m.kind === "worker");
	const shown = workers.slice(0, maxWorkers);
	for (const w of shown) {
		lines.push(workerRow(w.roleId ?? "?", w.provider, w.model, w.status, w.description));
		lines.push(tokenLine(w.usage));
		if (w.roleId && opts.expandedRoleIds.has(w.roleId)) {
			lines.push(...workerDetailLines(w.taskTitle, w.taskId, w.provider, w.model, w.status, w.summary));
			const cache = formatTokensCache(w.usage);
			if (cache !== undefined) lines.push(`  ${cache}`);
		}
	}
	if (workers.length > shown.length) lines.push(`…${workers.length - shown.length} more`);
	lines.push("│");
	lines.push("▼");
	const reviewer = reviewerRow(state);
	if (reviewer) {
		lines.push(reviewer);
		const reviewerMember = state.members.find((m) => m.kind === "reviewer");
		lines.push(tokenLine(reviewerMember?.usage));
		if (opts.expandedRoleIds.has("reviewer")) {
			const cache = formatTokensCache(reviewerMember?.usage);
			if (cache !== undefined) lines.push(`  ${cache}`);
		}
	}
	return lines;
}

export class TeamworkPanelComponent extends Container {
	private state: TeamworkPanelState | undefined;
	private readonly tui: TUI;
	private readonly expandedRoleIds = new Set<string>();
	private collapsed = false;

	constructor(initialState: TeamworkPanelState | undefined, tui: TUI) {
		super();
		this.state = initialState;
		this.tui = tui;
		this.rebuild();
	}

	getRunId(): string | undefined {
		return this.state?.runId;
	}

	getSnapshot(): TeamworkPanelState | undefined {
		return this.state;
	}

	updateFromEvent(event: TeamworkEvent): void {
		if (this.state === undefined) {
			if (event.type !== "teamwork.started") return;
			this.state = initPanelState(event.runId, event.goal, event.team);
		} else {
			this.state = applyTeamworkEvent(this.state, event);
		}
		this.rebuild();
		this.tui.requestRender();
	}

	setFinalState(state: TeamworkPanelState): void {
		this.state = state;
		this.rebuild();
		this.tui.requestRender();
	}

	collapse(): void {
		this.collapsed = true;
		this.rebuild();
		this.tui.requestRender();
	}

	/** Land lingering in-flight members when a run ends without a terminal event. */
	settle(): void {
		if (!this.state) return;
		this.state = settlePanelState(this.state);
		this.rebuild();
		this.tui.requestRender();
	}

	private toggleWorker(roleId: string): void {
		if (this.expandedRoleIds.has(roleId)) this.expandedRoleIds.delete(roleId);
		else this.expandedRoleIds.add(roleId);
		this.rebuild();
		this.tui.requestRender();
	}

	private addMemberRow(member: PanelMember, displayName: string): void {
		const text = workerRow(displayName, member.provider, member.model, member.status);
		const row = new Text(styleRow(text, member.status), 0, 0);
		const roleId = member.roleId ?? (member.kind === "reviewer" ? "reviewer" : displayName);
		this.addChild(
			new MouseRegion(row, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.toggleWorker(roleId);
				return { handled: true };
			}),
		);
	}

	private addTokenLine(usage: TeamUsage | undefined): void {
		this.addChild(new Text(styleDim(tokenLine(usage)), 0, 0));
	}

	private rebuild(): void {
		this.clear();
		if (!this.state) return;
		const state = this.state;
		if (this.collapsed) {
			this.addChild(new Text(headerLine(state), 0, 0));
			return;
		}
		this.addChild(new Text(styleDim(headerLine(state)), 0, 0));
		const leader = state.members.find((m) => m.kind === "leader");
		if (leader) {
			const text = `Leader · ${leader.provider}/${leader.model} · ${leaderLabel(leader.status)}`;
			this.addChild(new Text(styleRow(text, leader.status), 0, 0));
		}
		this.addChild(new Text(styleDim("│"), 0, 0));
		this.addChild(new Text(styleDim("▼"), 0, 0));
		this.addChild(new Text(styleDim("Workers"), 0, 0));
		const workers = state.members.filter((m) => m.kind === "worker");
		const shown = workers.slice(0, DEFAULT_MAX_WORKERS);
		for (const w of shown) {
			const roleId = w.roleId ?? "?";
			this.addMemberRow(w, roleId);
			this.addTokenLine(w.usage);
			if (w.roleId && this.expandedRoleIds.has(w.roleId)) {
				for (const line of workerDetailLines(w.taskTitle, w.taskId, w.provider, w.model, w.status, w.summary)) {
					this.addChild(new Text(styleDim(line), 0, 0));
				}
				const cache = formatTokensCache(w.usage);
				if (cache !== undefined) this.addChild(new Text(styleDim(`  ${cache}`), 0, 0));
			}
		}
		if (workers.length > shown.length)
			this.addChild(new Text(styleDim(`…${workers.length - shown.length} more`), 0, 0));
		this.addChild(new Text(styleDim("│"), 0, 0));
		this.addChild(new Text(styleDim("▼"), 0, 0));
		const reviewer = state.members.find((m) => m.kind === "reviewer");
		if (reviewer) {
			const text = `Reviewer · ${reviewer.provider}/${reviewer.model} · ${statusGlyph(reviewer.status)} ${formatStatus(reviewer.status)}`;
			const row = new Text(styleRow(text, reviewer.status), 0, 0);
			this.addChild(
				new MouseRegion(row, (event) => {
					if (event.type !== "click" || event.button !== "left") return undefined;
					this.toggleWorker("reviewer");
					return { handled: true };
				}),
			);
			this.addTokenLine(reviewer.usage);
			if (this.expandedRoleIds.has("reviewer")) {
				const cache = formatTokensCache(reviewer.usage);
				if (cache !== undefined) this.addChild(new Text(styleDim(`  ${cache}`), 0, 0));
			}
		}
	}
}
