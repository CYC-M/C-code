import type { RunPhase, TeamMemberStatus, TeamRoster, TeamUsage, TeamworkEvent } from "./types.ts";

export interface PanelMember {
	kind: "leader" | "worker" | "reviewer";
	roleId?: string;
	provider: string;
	model: string;
	status: TeamMemberStatus;
	/** Work description from the leader's task list, shown as `worker1（UI designer）`. */
	description?: string;
	taskId?: string;
	taskTitle?: string;
	summary?: string;
	usage?: TeamUsage;
}

export interface TeamworkPanelState {
	runId: string;
	goal: string;
	phase: RunPhase;
	members: PanelMember[];
	verdict?: "pass" | "needs_fix";
}

export function initPanelState(runId: string, goal: string, team: TeamRoster): TeamworkPanelState {
	return {
		runId,
		goal,
		phase: "pending",
		members: [
			{
				kind: "leader",
				provider: team.leader?.provider ?? "—",
				model: team.leader?.model ?? "—",
				status: "working",
			},
			...team.workers.map(
				(w): PanelMember => ({
					kind: "worker",
					roleId: w.roleId,
					provider: w.provider,
					model: w.model,
					status: "pending",
					...(w.description === undefined ? {} : { description: w.description }),
				}),
			),
			{ kind: "reviewer", provider: team.reviewer.provider, model: team.reviewer.model, status: "pending" },
		],
	};
}

function findWorkerIndex(members: PanelMember[], roleId: string): number {
	return members.findIndex((m) => m.kind === "worker" && m.roleId === roleId);
}

function withWorker(
	state: TeamworkPanelState,
	roleId: string,
	provider: string,
	model: string,
	update: (m: PanelMember) => PanelMember,
): TeamworkPanelState {
	const index = findWorkerIndex(state.members, roleId);
	if (index === -1) {
		const appended: PanelMember = update({ kind: "worker", roleId, provider, model, status: "pending" });
		return { ...state, members: [...state.members.map((m) => ({ ...m })), appended] };
	}
	return { ...state, members: state.members.map((m, i) => (i === index ? update({ ...m }) : { ...m })) };
}

function withReviewer(state: TeamworkPanelState, update: (m: PanelMember) => PanelMember): TeamworkPanelState {
	return { ...state, members: state.members.map((m) => (m.kind === "reviewer" ? update({ ...m }) : { ...m })) };
}

export function applyTeamworkEvent(state: TeamworkPanelState, event: TeamworkEvent): TeamworkPanelState {
	if (event.runId !== state.runId) {
		return state;
	}
	switch (event.type) {
		case "teamwork.started":
			return initPanelState(event.runId, event.goal, event.team);
		case "member.started":
			return withWorker(state, event.roleId, event.provider, event.model, (m) => ({
				...m,
				provider: event.provider,
				model: event.model,
				status: "working",
				taskId: event.taskId,
				taskTitle: event.taskTitle,
			}));
		case "member.completed":
			return withWorker(state, event.roleId, event.provider, event.model, (m) => ({
				...m,
				provider: event.provider,
				model: event.model,
				status: "completed",
				taskId: event.taskId,
				summary: event.summary,
				...(event.usage === undefined ? {} : { usage: event.usage }),
			}));
		case "member.failed":
			return withWorker(state, event.roleId, event.provider, event.model, (m) => ({
				...m,
				provider: event.provider,
				model: event.model,
				status: "failed",
				taskId: event.taskId,
				summary: `Error: ${event.error}`,
			}));
		case "review.started":
			return withReviewer(state, (m) => ({
				...m,
				provider: event.provider,
				model: event.model,
				status: "reviewing",
			}));
		case "review.completed": {
			const failed = new Set(event.failedTaskIds ?? []);
			return {
				...state,
				verdict: event.verdict,
				members: state.members.map((m) => {
					if (m.kind === "reviewer") {
						return {
							...m,
							provider: event.provider,
							model: event.model,
							status: "completed" as TeamMemberStatus,
							...(event.usage === undefined ? {} : { usage: event.usage }),
						};
					}
					if (
						m.kind === "worker" &&
						((m.taskId !== undefined && failed.has(m.taskId)) || (m.roleId !== undefined && failed.has(m.roleId)))
					) {
						return { ...m, status: "needs_fix" as TeamMemberStatus };
					}
					return { ...m };
				}),
			};
		}
		case "teamwork.completed":
			return {
				...state,
				phase: event.phase,
				members: state.members.map((m) =>
					m.status === "failed" || m.status === "needs_fix"
						? { ...m }
						: { ...m, status: "completed" as TeamMemberStatus },
				),
			};
	}
}
