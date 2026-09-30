import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("roleModels settings", () => {
	it("round-trips a role to model binding", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getRoleModels()).toBeUndefined();
		manager.setRoleModel("worker", { provider: "openai", model: "gpt-5" });
		expect(manager.getRoleModels()).toEqual({ worker: { provider: "openai", model: "gpt-5" } });
		manager.clearRoleModel("worker");
		expect(manager.getRoleModels()).toEqual({});
	});
});
