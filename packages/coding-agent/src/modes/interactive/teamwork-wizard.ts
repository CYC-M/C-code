import type { SettingsManager } from "../../core/settings-manager.ts";
import type { RoleModelRef } from "../../core/teamwork/types.ts";
import type { ModelSelectorComponent } from "./components/model-selector.ts";

export function buildRoleBindingSummary(roleModels: Record<string, RoleModelRef> | undefined): string {
	if (!roleModels || Object.keys(roleModels).length === 0) return "teamwork: no roles configured yet";
	return Object.entries(roleModels)
		.map(([role, ref]) => `- ${role}: ${ref.provider}/${ref.model}`)
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
	inputRoleId?(): Promise<string | undefined>;
}

const RESERVED_ROLE_IDS = new Set(["leader", "reviewer"]);

export function isValidWorkerRoleId(id: string, existing: readonly string[] = []): boolean {
	if (!/^[a-z0-9-]+$/.test(id)) return false;
	if (RESERVED_ROLE_IDS.has(id)) return false;
	return !existing.includes(id);
}

function formatBinding(ref: RoleModelRef | undefined): string {
	return ref ? `${ref.provider}/${ref.model}` : "not set";
}

function listWorkerRoles(roleModels: Record<string, RoleModelRef> | undefined): string[] {
	return Object.keys(roleModels ?? {}).filter((role) => !RESERVED_ROLE_IDS.has(role));
}

export function formatPoolBindings(existing: Record<string, RoleModelRef> | undefined): string {
	const workers = listWorkerRoles(existing);
	if (workers.length === 0) return "teamwork: no workers configured yet";
	return workers.map((role) => `- ${role}: ${formatBinding(existing?.[role])}`).join("\n");
}

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

async function configureLeader(deps: TeamworkWizardDeps, current: RoleModelRef | undefined): Promise<void> {
	deps.notify(`Leader (display only, brain is always the session model). Current: ${formatBinding(current)}`);
	const selected = await selectModel(deps, current);
	if (!selected) return;
	deps.settingsManager.setRoleModel("leader", { provider: selected.provider, model: selected.id });
	deps.notify(`teamwork: leader → ${selected.provider}/${selected.id}`);
}

async function configureRole(deps: TeamworkWizardDeps, role: string, opts: { removable: boolean }): Promise<void> {
	const current = deps.settingsManager.getRoleModels()?.[role];
	deps.notify(`Role ${role}. Current: ${formatBinding(current)}`);
	if (current) {
		if ((await deps.askYesNo?.(`Keep ${role} (${formatBinding(current)})?`)) ?? true) return;
		if (opts.removable && ((await deps.askYesNo?.(`Remove role ${role}?`)) ?? false)) {
			deps.settingsManager.clearRoleModel(role);
			deps.notify(`teamwork: ${role} removed`);
			return;
		}
	}
	const selected = await selectModel(deps, current);
	if (!selected) return;
	deps.settingsManager.setRoleModel(role, { provider: selected.provider, model: selected.id });
	deps.notify(`teamwork: ${role} → ${selected.provider}/${selected.id}`);
}

async function promptWorkerRoleId(deps: TeamworkWizardDeps, used: readonly string[]): Promise<string | undefined> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const raw = await deps.inputRoleId?.();
		if (raw === undefined) return undefined;
		const id = raw.trim();
		if (isValidWorkerRoleId(id, used)) return id;
		deps.notify(
			`Invalid role id "${id}". Use lowercase letters, numbers, dashes; not leader/reviewer or an existing role.`,
		);
	}
	deps.notify("Too many invalid role ids; stopping worker setup.");
	return undefined;
}

export async function runTeamworkSetupWizard(
	deps: TeamworkWizardDeps,
	existing: Record<string, RoleModelRef> | undefined,
): Promise<void> {
	const readCurrent = (): Record<string, RoleModelRef> => deps.settingsManager.getRoleModels() ?? existing ?? {};
	await configureLeader(deps, readCurrent().leader);
	deps.notify(`Workers pool:\n${formatPoolBindings(readCurrent())}`);
	for (const role of listWorkerRoles(readCurrent())) {
		await configureRole(deps, role, { removable: true });
	}
	while ((await deps.askYesNo?.("Add another worker?")) ?? false) {
		const role = await promptWorkerRoleId(deps, listWorkerRoles(readCurrent()));
		if (role === undefined) break;
		const selected = await selectModel(deps, undefined);
		if (!selected) continue;
		deps.settingsManager.setRoleModel(role, { provider: selected.provider, model: selected.id });
		deps.notify(`teamwork: ${role} → ${selected.provider}/${selected.id}`);
	}
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
