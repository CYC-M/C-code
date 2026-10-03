import type { TeamTask } from "./types.ts";

/**
 * Canonical worker naming.
 *
 * The leader (a model) proposes the split, so its role names are untrusted input: it may
 * emit `worker 1`, `Worker2`, `worker3（UI designer）`, or an ad-hoc name like
 * `ui designer`. The team runtime keys model bindings by role id, so names must be
 * canonical or the run fails with "unknown role" no matter how the user configured the
 * team. Everything in this module exists to turn any proposal into `worker<N>` plus an
 * optional description, deterministically and without rejecting the leader's output.
 */
export const LEADER_ROLE_ID = "leader";
export const REVIEWER_ROLE_ID = "reviewer";

/** Roles that are never workers. */
export const RESERVED_ROLE_IDS: ReadonlySet<string> = new Set([LEADER_ROLE_ID, REVIEWER_ROLE_ID]);

/** `worker3`, `Worker 3`, `worker03` — the id form, without a description. */
const WORKER_ROLE_PATTERN = /^worker\s*0*([0-9]+)$/i;

/** `worker3`, `worker3（UI designer）`, `worker3(UI designer)` — the display form. */
const WORKER_NAME_PATTERN = /^worker\s*0*([0-9]+)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?$/i;

/** The canonical id for a 1-based worker index. */
export function formatWorkerRoleId(index: number): string {
	return `worker${index}`;
}

/** The worker index of a canonical id, or undefined for anything else. */
export function parseWorkerRoleId(role: string): number | undefined {
	const match = WORKER_ROLE_PATTERN.exec(role.trim());
	if (!match) return undefined;
	const index = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}

export function isWorkerRoleId(role: string): boolean {
	return parseWorkerRoleId(role) !== undefined;
}

/** Natural worker order: `worker2` sorts before `worker10`. */
export function compareWorkerRoleIds(left: string, right: string): number {
	const leftIndex = parseWorkerRoleId(left);
	const rightIndex = parseWorkerRoleId(right);
	if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
	if (leftIndex !== undefined) return -1;
	if (rightIndex !== undefined) return 1;
	return left.localeCompare(right);
}

/**
 * Split a leader-supplied role name into a canonical id and its description.
 *
 * Returns undefined for names that do not mention a worker number; callers then keep the
 * name as the description and allocate the next free index.
 */
export function parseWorkerRoleName(raw: string): { roleId: string; description?: string } | undefined {
	const match = WORKER_NAME_PATTERN.exec(raw.trim());
	if (!match) return undefined;
	const index = Number.parseInt(match[1], 10);
	if (!Number.isSafeInteger(index) || index <= 0) return undefined;
	const description = match[2]?.trim();
	return {
		roleId: formatWorkerRoleId(index),
		...(description ? { description } : {}),
	};
}

/** `worker1（UI designer）` when a description is known, otherwise the bare id. */
export function formatWorkerLabel(roleId: string, description?: string): string {
	const trimmed = description?.trim();
	return trimmed ? `${roleId}（${trimmed}）` : roleId;
}

/**
 * Canonicalize the roles of a task list.
 *
 * - `worker3` / `worker 3` / `worker3（UI designer）` keep their number, and a description
 *   in parentheses becomes the worker's description.
 * - Any other name is treated as a description and receives the next free worker index.
 *   The same name always maps to the same worker, so several tasks can share one worker.
 * - An explicit `roleDescription` wins over one parsed from the name.
 *
 * Stable across re-sends of the same proposal, so bindings the user configured for
 * `worker1…workerN` keep applying when the leader retries.
 */
export function canonicalizeWorkerTaskRoles(
	tasks: readonly TeamTask[],
	options: { knownRoles?: readonly string[] } = {},
): TeamTask[] {
	const known = new Set(options.knownRoles ?? []);
	const byRawName = new Map<string, string>();
	const descriptions = new Map<string, string>();
	const used = new Set(known);
	let nextIndex = 1;

	const allocate = (): string => {
		while (used.has(formatWorkerRoleId(nextIndex))) nextIndex++;
		const roleId = formatWorkerRoleId(nextIndex);
		used.add(roleId);
		return roleId;
	};

	return tasks.map((task) => {
		const raw = task.role.trim();
		if (RESERVED_ROLE_IDS.has(raw)) {
			return { ...task, role: raw, roleDescription: undefined };
		}
		if (known.has(raw)) {
			const knownDescription = task.roleDescription?.trim();
			return { ...task, role: raw, ...(knownDescription ? { roleDescription: knownDescription } : {}) };
		}

		const parsed = parseWorkerRoleName(raw);
		let roleId: string;
		let description = task.roleDescription?.trim() || parsed?.description;
		if (parsed) {
			roleId = parsed.roleId;
			used.add(roleId);
		} else {
			const existing = byRawName.get(raw.toLowerCase());
			if (existing) {
				roleId = existing;
			} else {
				roleId = allocate();
				byRawName.set(raw.toLowerCase(), roleId);
				if (description === undefined && raw) description = raw;
			}
		}
		if (description === undefined) {
			description = descriptions.get(roleId);
		} else {
			descriptions.set(roleId, description);
		}
		return { ...task, role: roleId, ...(description ? { roleDescription: description } : {}) };
	});
}

/** The distinct worker roles a task list uses, in natural order. */
export function workerRolesInTasks(tasks: readonly TeamTask[]): string[] {
	const roles = new Set<string>();
	for (const task of tasks) {
		if (isWorkerRoleId(task.role)) roles.add(task.role);
	}
	return [...roles].sort(compareWorkerRoleIds);
}

/** Descriptions by worker role id, taken from the first task that names one. */
export function workerDescriptionsInTasks(tasks: readonly TeamTask[]): Record<string, string> {
	const descriptions: Record<string, string> = {};
	for (const task of tasks) {
		const description = task.roleDescription?.trim();
		if (description && descriptions[task.role] === undefined) descriptions[task.role] = description;
	}
	return descriptions;
}
