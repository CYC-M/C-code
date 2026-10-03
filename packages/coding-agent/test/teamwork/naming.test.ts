import { describe, expect, it } from "vitest";
import {
	canonicalizeWorkerTaskRoles,
	compareWorkerRoleIds,
	formatWorkerLabel,
	formatWorkerRoleId,
	isWorkerRoleId,
	parseWorkerRoleId,
	parseWorkerRoleName,
	workerDescriptionsInTasks,
	workerRolesInTasks,
} from "../../src/core/teamwork/naming.ts";
import type { TeamTask } from "../../src/core/teamwork/types.ts";

function task(role: string, overrides: Partial<TeamTask> = {}): TeamTask {
	return { id: `t-${role}`, title: role, goal: "g", role, successCriteria: ["c"], ...overrides };
}

describe("worker role ids", () => {
	it("recognizes the canonical workerN form only", () => {
		expect(isWorkerRoleId("worker1")).toBe(true);
		expect(isWorkerRoleId("worker42")).toBe(true);
		expect(parseWorkerRoleId("worker07")).toBe(7);
		expect(isWorkerRoleId("worker")).toBe(false);
		expect(isWorkerRoleId("worker-a")).toBe(false);
		expect(isWorkerRoleId("leader")).toBe(false);
	});

	it("orders workers numerically, not lexicographically", () => {
		expect(["worker10", "worker2", "worker1"].sort(compareWorkerRoleIds)).toEqual(["worker1", "worker2", "worker10"]);
	});

	it("formats and parses the display form", () => {
		expect(formatWorkerRoleId(3)).toBe("worker3");
		expect(formatWorkerLabel("worker1", "UI designer")).toBe("worker1（UI designer）");
		expect(formatWorkerLabel("worker1", "  ")).toBe("worker1");
		expect(parseWorkerRoleName("worker1（UI designer）")).toEqual({
			roleId: "worker1",
			description: "UI designer",
		});
		expect(parseWorkerRoleName("worker1(Back-end architect)")).toEqual({
			roleId: "worker1",
			description: "Back-end architect",
		});
		expect(parseWorkerRoleName("worker 2")).toEqual({ roleId: "worker2" });
		expect(parseWorkerRoleName("ui designer")).toBeUndefined();
	});
});

describe("canonicalizeWorkerTaskRoles", () => {
	it("keeps the number the leader used and takes the description from the name", () => {
		const tasks = canonicalizeWorkerTaskRoles([
			task("worker1（UI designer）"),
			task("worker 2（Back-end architect）"),
		]);
		expect(tasks.map((t) => t.role)).toEqual(["worker1", "worker2"]);
		expect(tasks.map((t) => t.roleDescription)).toEqual(["UI designer", "Back-end architect"]);
	});

	it("turns an ad-hoc name into the description of the next free worker", () => {
		const tasks = canonicalizeWorkerTaskRoles([task("ui designer"), task("backend")]);
		expect(tasks.map((t) => t.role)).toEqual(["worker1", "worker2"]);
		expect(tasks.map((t) => t.roleDescription)).toEqual(["ui designer", "backend"]);
	});

	it("maps the same name to the same worker so one worker can own several tasks", () => {
		const tasks = canonicalizeWorkerTaskRoles([task("ui designer"), task("Backend"), task("UI Designer")]);
		expect(tasks.map((t) => t.role)).toEqual(["worker1", "worker2", "worker1"]);
		expect(tasks[2].roleDescription).toBe("ui designer");
	});

	it("prefers an explicit roleDescription over one parsed from the name", () => {
		const tasks = canonicalizeWorkerTaskRoles([task("worker1（guess）", { roleDescription: "UI designer" })]);
		expect(tasks[0]).toMatchObject({ role: "worker1", roleDescription: "UI designer" });
	});

	it("preserves role ids the user already configured", () => {
		const tasks = canonicalizeWorkerTaskRoles([task("worker"), task("frontend")], {
			knownRoles: ["worker", "reviewer"],
		});
		// `worker` is configured, so it is used as-is; `frontend` takes the next free number.
		expect(tasks.map((t) => t.role)).toEqual(["worker", "worker1"]);
	});

	it("leaves reserved roles alone", () => {
		const tasks = canonicalizeWorkerTaskRoles([task("reviewer"), task("leader")]);
		expect(tasks.map((t) => t.role)).toEqual(["reviewer", "leader"]);
		expect(tasks.every((t) => t.roleDescription === undefined)).toBe(true);
	});

	it("is stable across a re-sent proposal, so bindings keep applying", () => {
		const first = canonicalizeWorkerTaskRoles([task("ui designer"), task("backend")]);
		const second = canonicalizeWorkerTaskRoles([task("ui designer"), task("backend")]);
		expect(second.map((t) => t.role)).toEqual(first.map((t) => t.role));
	});

	it("collects the roles and descriptions a task list uses", () => {
		const tasks = canonicalizeWorkerTaskRoles([
			task("worker2（API）"),
			task("worker1（UI）"),
			task("worker2（API）"),
		]);
		expect(workerRolesInTasks(tasks)).toEqual(["worker1", "worker2"]);
		expect(workerDescriptionsInTasks(tasks)).toEqual({ worker1: "UI", worker2: "API" });
	});
});
