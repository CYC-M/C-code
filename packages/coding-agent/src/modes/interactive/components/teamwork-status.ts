import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import type { TeamworkPanelState } from "../../../core/teamwork/panel.ts";
import type { RoleModelRef } from "../../../core/teamwork/types.ts";
import { resolveEffectiveLeader } from "../teamwork-wizard.ts";
import { theme } from "../theme/theme.ts";

export interface TeamworkStatusLine {
	text: string;
	active: boolean;
}

export interface TeamworkStatusSessionModel {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

const MAX_STATUS_LINES = 4;

function statusWorkerLabel(roleId: string, description?: string): string {
	const trimmed = description?.trim();
	return trimmed ? `${roleId}-${trimmed}` : roleId;
}

function thinkingFor(
	role: string,
	roleModels: Record<string, RoleModelRef> | undefined,
	sessionModel: TeamworkStatusSessionModel,
	isLeader: boolean,
): string {
	const bound = roleModels?.[role]?.thinkingLevel;
	if (bound) return bound;
	if (isLeader && sessionModel.thinkingLevel) return sessionModel.thinkingLevel;
	return "off";
}

export function formatTeamworkStatusLines(
	snapshot: TeamworkPanelState | undefined,
	roleModels: Record<string, RoleModelRef> | undefined,
	sessionModel: TeamworkStatusSessionModel,
): TeamworkStatusLine[] {
	if (!snapshot) return [];
	if (snapshot.phase === "done" || snapshot.phase === "failed") return [];
	const workersWorking = snapshot.members.filter((m) => m.kind === "worker" && m.status === "working");
	const reviewer = snapshot.members.find((m) => m.kind === "reviewer");
	const reviewerActive = reviewer?.status === "reviewing";
	const lines: TeamworkStatusLine[] = [];
	if (!reviewerActive && workersWorking.length === 0) {
		const leader = snapshot.members.find((m) => m.kind === "leader");
		if (leader && leader.status === "working") {
			const effective = resolveEffectiveLeader(roleModels, sessionModel);
			const thinking = thinkingFor("leader", roleModels, sessionModel, true);
			const lp = effective.provider === "?" ? "—" : effective.provider;
			const lm = effective.model === "?" ? "—" : effective.model;
			lines.push({ text: `【leader】${lp} ${lm} ${thinking}`, active: true });
		}
		return lines;
	}
	for (const w of workersWorking) {
		const roleId = w.roleId ?? "?";
		const ref = roleModels?.[roleId];
		const provider = ref?.provider ?? w.provider ?? "—";
		const model = ref?.model ?? w.model ?? "—";
		lines.push({
			text: `【${statusWorkerLabel(roleId, w.description)}】${provider} ${model} ${thinkingFor(roleId, roleModels, sessionModel, false)}`,
			active: true,
		});
	}
	if (reviewerActive && reviewer) {
		const ref = roleModels?.reviewer;
		const provider = ref?.provider ?? reviewer.provider ?? "—";
		const model = ref?.model ?? reviewer.model ?? "—";
		lines.push({
			text: `【reviewer】${provider} ${model} ${thinkingFor("reviewer", roleModels, sessionModel, false)}`,
			active: true,
		});
	}
	if (lines.length > MAX_STATUS_LINES) {
		// Budget: 4 lines; workers first, reviewer may drop in large teams (by design).
		return [...lines.slice(0, MAX_STATUS_LINES), { text: `…${lines.length - MAX_STATUS_LINES} more`, active: false }];
	}
	return lines;
}

export class TeamworkStatusComponent extends Container {
	private empty = true;
	private readonly tui: TUI;

	constructor(tui: TUI) {
		super();
		this.tui = tui;
	}

	isEmpty(): boolean {
		return this.empty;
	}

	setLines(lines: TeamworkStatusLine[]): void {
		this.clear();
		this.empty = lines.length === 0;
		for (const line of lines) {
			const row = `● ${line.text}`;
			this.addChild(new Text(line.active ? theme.bold(theme.fg("accent", row)) : theme.fg("dim", row), 0, 0));
		}
	}

	override clear(): void {
		super.clear();
		this.empty = true;
		this.tui.requestRender();
	}
}
