import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../src/core/slash-commands.ts";

describe("teamwork command first position", () => {
	it("is the default first slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS[0]?.name).toBe("teamwork");
	});
});
