import { describe, expect, it } from "vitest";
import { buildRoleBindingSummary } from "../../src/modes/interactive/teamwork-wizard.ts";

describe("teamwork wizard", () => {
	it("summarizes role bindings for confirmation", () => {
		expect(buildRoleBindingSummary({ worker: { provider: "o", model: "m" } })).toContain("worker");
		expect(buildRoleBindingSummary(undefined)).toContain("no roles");
	});
});

import { formatPoolBindings, isValidWorkerRoleId } from "../../src/modes/interactive/teamwork-wizard.ts";

describe("teamwork worker role ids", () => {
	it("accepts lowercase letters, numbers, and dashes", () => {
		expect(isValidWorkerRoleId("worker")).toBe(true);
		expect(isValidWorkerRoleId("worker-frontend")).toBe(true);
		expect(isValidWorkerRoleId("w2")).toBe(true);
	});

	it("rejects empty, uppercase, underscored, and spaced ids", () => {
		expect(isValidWorkerRoleId("")).toBe(false);
		expect(isValidWorkerRoleId("Worker")).toBe(false);
		expect(isValidWorkerRoleId("my_worker")).toBe(false);
		expect(isValidWorkerRoleId("my worker")).toBe(false);
	});

	it("rejects reserved and already-used ids", () => {
		expect(isValidWorkerRoleId("leader")).toBe(false);
		expect(isValidWorkerRoleId("reviewer")).toBe(false);
		expect(isValidWorkerRoleId("worker", ["worker"])).toBe(false);
		expect(isValidWorkerRoleId("fresh", ["worker"])).toBe(true);
	});
});

describe("teamwork pool summary", () => {
	it("lists worker bindings and skips leader/reviewer", () => {
		const text = formatPoolBindings({
			leader: { provider: "o", model: "m" },
			worker: { provider: "o", model: "m" },
			reviewer: { provider: "a", model: "c" },
		});
		expect(text).toContain("worker");
		expect(text).not.toContain("leader");
		expect(text).not.toContain("reviewer");
	});

	it("reports an empty pool", () => {
		expect(formatPoolBindings(undefined)).toContain("no workers");
		expect(formatPoolBindings({ reviewer: { provider: "a", model: "c" } })).toContain("no workers");
	});
});
