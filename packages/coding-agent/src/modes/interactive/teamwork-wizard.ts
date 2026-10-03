import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "../../core/settings-manager.ts";
import {
	compareWorkerRoleIds,
	formatWorkerLabel,
	formatWorkerRoleId,
	parseWorkerRoleId,
} from "../../core/teamwork/naming.ts";
import type { RoleModelRef } from "../../core/teamwork/types.ts";
import type { ModelSelectorComponent } from "./components/model-selector.ts";

export function buildRoleBindingSummary(roleModels: Record<string, RoleModelRef> | undefined): string {
	if (!roleModels || Object.keys(roleModels).length === 0) return "teamwork: no roles configured yet";
	return Object.entries(roleModels)
		.map(([role, ref]) => `- ${role}: ${formatModelBinding(ref)}`)
		.join("\n");
}

export interface TeamworkWizardDeps {
	showSelector(render: (done: () => void) => { component: unknown; focus: () => void }): void;
	createModelSelector(
		onSelect: (model: { provider: string; id: string }) => void,
		onCancel: () => void,
		defaultModel?: { provider: string; id: string },
	): ModelSelectorComponent;
	settingsManager: SettingsManager;
	notify(message: string): void;
	askYesNo?(message: string): Promise<boolean>;
	inputRoleId?(suggestion: string): Promise<string | undefined>;
	selectThinking?(
		model: { provider: string; id: string },
		current?: ThinkingLevel,
	): Promise<ThinkingLevel | undefined>;
}

export function formatModelBinding(ref: RoleModelRef | undefined): string {
	if (!ref) return "not set";
	return `${ref.provider}/${ref.model} · ${ref.thinkingLevel ?? "off"}`;
}

const RESERVED_ROLE_IDS = new Set(["leader", "reviewer"]);

/**
 * Worker ids are canonical by rule: `worker1`, `worker2`, ... The leader names them this
 * way, the runtime derives them from whatever the leader proposed, and the user binds a
 * model per id, so an ad-hoc id would silently produce an unbound worker.
 */
export function isValidWorkerRoleId(id: string, existing: readonly string[] = []): boolean {
	if (parseWorkerRoleId(id) === undefined) return false;
	if (RESERVED_ROLE_IDS.has(id)) return false;
	return !existing.includes(id);
}

/** `worker1` when nothing is configured, otherwise the next free number. */
export function suggestWorkerRoleId(existing: readonly string[] = []): string {
	let index = 1;
	while (existing.includes(formatWorkerRoleId(index))) index++;
	return formatWorkerRoleId(index);
}

function listWorkerRoles(roleModels: Record<string, RoleModelRef> | undefined): string[] {
	return Object.keys(roleModels ?? {})
		.filter((role) => !RESERVED_ROLE_IDS.has(role))
		.sort(compareWorkerRoleIds);
}

export function formatPoolBindings(existing: Record<string, RoleModelRef> | undefined): string {
	const workers = listWorkerRoles(existing);
	if (workers.length === 0) return "teamwork: no workers configured yet";
	return workers.map((role) => `- ${role}: ${formatModelBinding(existing?.[role])}`).join("\n");
}

/**
 * Bind a model for each worker the leader proposed. Called by the teamwork tool while it
 * runs, so an unbound `workerN` becomes a one-question prompt instead of a failed run.
 */
function selectModel(
	deps: TeamworkWizardDeps,
	defaultRef: RoleModelRef | undefined,
): Promise<{ provider: string; id: string } | undefined> {
	return new Promise((resolve) => {
		let release = () => {};
		const selector = deps.createModelSelector(
			(model) => {
				release();
				resolve(model);
			},
			() => {
				release();
				resolve(undefined);
			},
			defaultRef ? { provider: defaultRef.provider, id: defaultRef.model } : undefined,
		);
		deps.showSelector((done) => {
			release = done;
			return { component: selector, focus: () => {} };
		});
	});
}

export function resolveEffectiveLeader(
	roleModels: Record<string, RoleModelRef> | undefined,
	sessionModel: { provider: string; id: string; thinkingLevel?: ThinkingLevel },
): RoleModelRef {
	const override = roleModels?.leader;
	if (override) return override;
	return {
		provider: sessionModel.provider,
		model: sessionModel.id,
		...(sessionModel.thinkingLevel === undefined || sessionModel.thinkingLevel === "off"
			? {}
			: { thinkingLevel: sessionModel.thinkingLevel }),
	};
}

async function configureLeaderChoice(deps: TeamworkWizardDeps, current: RoleModelRef | undefined): Promise<void> {
	deps.notify(`Leader (team coordinator, brain). Current: ${formatModelBinding(current)}`);
	if (deps.askYesNo) {
		const follow = await deps.askYesNo("Follow session model as leader? (recommended)");
		if (follow) {
			if (current) {
				deps.settingsManager.clearRoleModel("leader");
				deps.notify("teamwork: leader follows session model");
			} else {
				deps.notify("teamwork: leader follows session model");
			}
			return;
		}
	}
	const selected = await selectModel(deps, current);
	if (!selected) return;
	const thinkingLevel = await resolveThinkingLevel(deps, selected, current);
	const ref = toStoredRef(selected, thinkingLevel);
	deps.settingsManager.setRoleModel("leader", ref);
	deps.notify(`teamwork: leader → ${describeStoredRef(ref)}`);
}

export async function runTeamworkInitialSetup(
	deps: TeamworkWizardDeps,
	existing: Record<string, RoleModelRef> | undefined,
): Promise<void> {
	const readCurrent = (): Record<string, RoleModelRef> => deps.settingsManager.getRoleModels() ?? existing ?? {};
	await configureLeaderChoice(deps, readCurrent().leader);
	await configureRole(deps, "reviewer", { removable: false });
}

/**
 * Bind a model for each worker the leader proposed. Called by the teamwork tool while it
 * runs, so an unbound `workerN` becomes a one-question prompt instead of a failed run.
 */
export async function ensureWorkerBindings(
	deps: TeamworkWizardDeps,
	roles: readonly string[],
	labels: Record<string, string> = {},
): Promise<void> {
	const seen = new Set<string>();
	for (const role of roles) {
		if (role === "leader" || role === "reviewer" || seen.has(role)) continue;
		seen.add(role);
		await configureRole(deps, role, { removable: false, label: formatWorkerLabel(role, labels[role]) });
	}
}

function toStoredRef(
	selected: { provider: string; id: string },
	thinkingLevel: ThinkingLevel | undefined,
): RoleModelRef {
	return {
		provider: selected.provider,
		model: selected.id,
		...(thinkingLevel !== undefined && thinkingLevel !== "off" ? { thinkingLevel } : {}),
	};
}

function describeStoredRef(ref: RoleModelRef): string {
	return formatModelBinding(ref);
}

async function resolveThinkingLevel(
	deps: TeamworkWizardDeps,
	selected: { provider: string; id: string },
	current: RoleModelRef | undefined,
): Promise<ThinkingLevel | undefined> {
	if (!deps.selectThinking) return current?.thinkingLevel;
	const picked = await deps.selectThinking(selected, current?.thinkingLevel);
	return picked ?? current?.thinkingLevel;
}

async function configureRole(
	deps: TeamworkWizardDeps,
	role: string,
	opts: { removable: boolean; label?: string },
): Promise<void> {
	const current = deps.settingsManager.getRoleModels()?.[role];
	const label = opts.label ?? role;
	deps.notify(`Role ${label}. Current: ${formatModelBinding(current)}`);
	if (current) {
		if ((await deps.askYesNo?.(`Keep ${label} (${formatModelBinding(current)})?`)) ?? true) {
			await offerThinkingTopUp(deps, role, current);
			return;
		}
		if (opts.removable && ((await deps.askYesNo?.(`Remove role ${label}?`)) ?? false)) {
			deps.settingsManager.clearRoleModel(role);
			deps.notify(`teamwork: ${label} removed`);
			return;
		}
	}
	const selected = await selectModel(deps, current);
	if (!selected) {
		deps.notify(`teamwork: ${label} 未选择模型`);
		return;
	}
	const thinkingLevel = await resolveThinkingLevel(deps, selected, current);
	const ref = toStoredRef(selected, thinkingLevel);
	deps.settingsManager.setRoleModel(role, ref);
	deps.notify(`teamwork: ${label} → ${describeStoredRef(ref)}`);
}

/** One-shot offer to add a thinking level to a kept binding that lacks one. */
async function offerThinkingTopUp(deps: TeamworkWizardDeps, role: string, current: RoleModelRef): Promise<void> {
	if (current.thinkingLevel !== undefined || !deps.selectThinking) return;
	if (!((await deps.askYesNo?.(`Set a thinking level for ${role}?`)) ?? false)) return;
	const picked = await deps.selectThinking({ provider: current.provider, id: current.model }, undefined);
	if (picked === undefined || picked === "off") return;
	const ref = toStoredRef({ provider: current.provider, id: current.model }, picked);
	deps.settingsManager.setRoleModel(role, ref);
	deps.notify(`teamwork: ${role} → ${describeStoredRef(ref)}`);
}

/** Thinking-only change for an already-bound role (no model step). */
export async function runSetThinkingOnly(deps: TeamworkWizardDeps, role: string): Promise<void> {
	const current = deps.settingsManager.getRoleModels()?.[role];
	if (!current) {
		deps.notify(`teamwork: ${role} is not configured yet`);
		return;
	}
	if (!deps.selectThinking) {
		deps.notify("teamwork: thinking picker unavailable");
		return;
	}
	const picked = await deps.selectThinking({ provider: current.provider, id: current.model }, current.thinkingLevel);
	const thinkingLevel = picked ?? current.thinkingLevel;
	const ref = toStoredRef({ provider: current.provider, id: current.model }, thinkingLevel);
	deps.settingsManager.setRoleModel(role, ref);
	deps.notify(`teamwork: ${role} → ${describeStoredRef(ref)}`);
}

/** Direct reselect for click-to-reconfigure flows (no keep prompt; the click is the intent). */
export async function runReconfigureRole(deps: TeamworkWizardDeps, role: string): Promise<void> {
	const current = deps.settingsManager.getRoleModels()?.[role];
	if (!current) {
		deps.notify(`teamwork: ${role} is not configured yet`);
		return;
	}
	const selected = await selectModel(deps, current);
	if (!selected) return;
	const thinkingLevel = await resolveThinkingLevel(deps, selected, current);
	const ref = toStoredRef(selected, thinkingLevel);
	deps.settingsManager.setRoleModel(role, ref);
	deps.notify(`teamwork: ${role} → ${describeStoredRef(ref)}`);
}

/** Re-run only the leader step (follow-session vs independent model + thinking). */
export async function runConfigureLeaderChoice(deps: TeamworkWizardDeps): Promise<void> {
	const current = deps.settingsManager.getRoleModels()?.leader;
	await configureLeaderChoice(deps, current);
}

async function promptWorkerRoleId(deps: TeamworkWizardDeps, used: readonly string[]): Promise<string | undefined> {
	const suggestion = suggestWorkerRoleId(used);
	for (let attempt = 0; attempt < 3; attempt++) {
		const raw = await deps.inputRoleId?.(suggestion);
		if (raw === undefined) return undefined;
		const id = raw.trim();
		if (isValidWorkerRoleId(id, used)) {
			// Store the canonical form so `Worker 2` binds the same role as `worker2`.
			const index = parseWorkerRoleId(id);
			return index === undefined ? id : formatWorkerRoleId(index);
		}
		if (parseWorkerRoleId(id) === undefined) {
			deps.notify(`Invalid worker id "${id}". Use the form worker1, worker2, ... (worker + number).`);
		} else if (RESERVED_ROLE_IDS.has(id)) {
			deps.notify(`"${id}" is reserved; pick another worker number.`);
		} else {
			deps.notify(`Worker ${id} already exists; pick another number (next free: ${suggestion}).`);
		}
	}
	deps.notify("Too many invalid worker ids; stopping worker setup.");
	return undefined;
}

/** Guided loop: name a worker role id, pick its model, then its thinking level. */
export async function runAddWorkers(deps: TeamworkWizardDeps): Promise<void> {
	const readWorkers = (): string[] => listWorkerRoles(deps.settingsManager.getRoleModels());
	while (
		(await deps.askYesNo?.(readWorkers().length === 0 ? "No workers yet. Add one now?" : "Add another worker?")) ??
		false
	) {
		const role = await promptWorkerRoleId(deps, readWorkers());
		if (role === undefined) break;
		const selected = await selectModel(deps, undefined);
		if (!selected) continue;
		const ref = toStoredRef(selected, await resolveThinkingLevel(deps, selected, undefined));
		deps.settingsManager.setRoleModel(role, ref);
		deps.notify(`teamwork: ${role} → ${describeStoredRef(ref)}`);
	}
}

export async function runTeamworkSetupWizard(
	deps: TeamworkWizardDeps,
	existing: Record<string, RoleModelRef> | undefined,
): Promise<void> {
	const readCurrent = (): Record<string, RoleModelRef> => deps.settingsManager.getRoleModels() ?? existing ?? {};
	await configureLeaderChoice(deps, readCurrent().leader);
	deps.notify(`Workers pool:\n${formatPoolBindings(readCurrent())}`);
	for (const role of listWorkerRoles(readCurrent())) {
		await configureRole(deps, role, { removable: true });
	}
	await runAddWorkers(deps);
	await configureRole(deps, "reviewer", { removable: false });
}

export async function runTeamworkConfigWizard(deps: TeamworkWizardDeps, roles: string[]): Promise<void> {
	for (const role of roles) {
		await new Promise<void>((resolve) => {
			let release = () => {};
			const selector = deps.createModelSelector(
				(model) => {
					deps.settingsManager.setRoleModel(role, { provider: model.provider, model: model.id });
					deps.notify(`teamwork: ${role} → ${model.provider}/${model.id}`);
					release();
					resolve();
				},
				() => {
					release();
					resolve();
				},
			);
			deps.showSelector((done) => {
				release = done;
				return { component: selector, focus: () => {} };
			});
		});
	}
}
