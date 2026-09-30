import { Container, MouseRegion, Text, type TUI } from "@earendil-works/pi-tui";
import { applyTeamworkEvent, initPanelState, type TeamworkPanelState } from "../../../core/teamwork/panel.ts";
import type { TeamMemberStatus, TeamworkEvent } from "../../../core/teamwork/types.ts";

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

function workerRow(roleId: string, provider: string, model: string, status: TeamMemberStatus): string {
	return `${roleId} · ${provider}/${model} · ${statusGlyph(status)} ${formatStatus(status)}`;
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
	lines.push("Workers");
	const workers = state.members.filter((m) => m.kind === "worker");
	const shown = workers.slice(0, maxWorkers);
	for (const w of shown) {
		lines.push(workerRow(w.roleId ?? "?", w.provider, w.model, w.status));
		if (w.roleId && opts.expandedRoleIds.has(w.roleId)) {
			lines.push(...workerDetailLines(w.taskTitle, w.taskId, w.provider, w.model, w.status, w.summary));
		}
	}
	if (workers.length > shown.length) lines.push(`…${workers.length - shown.length} more`);
	const reviewer = reviewerRow(state);
	if (reviewer) lines.push(reviewer);
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

	private toggleWorker(roleId: string): void {
		if (this.expandedRoleIds.has(roleId)) this.expandedRoleIds.delete(roleId);
		else this.expandedRoleIds.add(roleId);
		this.rebuild();
		this.tui.requestRender();
	}

	private addWorkerRow(roleId: string, provider: string, model: string, status: TeamMemberStatus): void {
		const row = new Text(workerRow(roleId, provider, model, status), 0, 0);
		this.addChild(
			new MouseRegion(row, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.toggleWorker(roleId);
				return { handled: true };
			}),
		);
	}

	private rebuild(): void {
		this.clear();
		if (!this.state) return;
		const state = this.state;
		if (this.collapsed) {
			this.addChild(new Text(headerLine(state), 0, 0));
			return;
		}
		this.addChild(new Text(headerLine(state), 0, 0));
		const leader = leaderRow(state);
		if (leader) this.addChild(new Text(leader, 0, 0));
		this.addChild(new Text("Workers", 0, 0));
		const workers = state.members.filter((m) => m.kind === "worker");
		const shown = workers.slice(0, DEFAULT_MAX_WORKERS);
		for (const w of shown) {
			const roleId = w.roleId ?? "?";
			this.addWorkerRow(roleId, w.provider, w.model, w.status);
			if (w.roleId && this.expandedRoleIds.has(w.roleId)) {
				for (const line of workerDetailLines(w.taskTitle, w.taskId, w.provider, w.model, w.status, w.summary)) {
					this.addChild(new Text(line, 0, 0));
				}
			}
		}
		if (workers.length > shown.length) this.addChild(new Text(`…${workers.length - shown.length} more`, 0, 0));
		const reviewer = reviewerRow(state);
		if (reviewer) this.addChild(new Text(reviewer, 0, 0));
	}
}
