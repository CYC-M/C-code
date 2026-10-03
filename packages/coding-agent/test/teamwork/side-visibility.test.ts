import { describe, expect, it } from "vitest";
import { shouldShowTeamSide } from "../../src/modes/interactive/chat-viewport.ts";

describe("teamwork side visibility gate", () => {
	it("shows the side in teamwork mode at 90+ columns", () => {
		expect(shouldShowTeamSide(true, 144)).toBe(true);
		expect(shouldShowTeamSide(true, 90)).toBe(true);
		expect(shouldShowTeamSide(true, 89)).toBe(false);
		expect(shouldShowTeamSide(true, 80)).toBe(false);
	});

	it("requires 100+ columns outside teamwork mode", () => {
		expect(shouldShowTeamSide(false, 144)).toBe(true);
		expect(shouldShowTeamSide(false, 100)).toBe(true);
		expect(shouldShowTeamSide(false, 99)).toBe(false);
	});
});
