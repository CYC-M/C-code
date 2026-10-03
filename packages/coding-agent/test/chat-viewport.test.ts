import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	createChatViewport,
	TEAMWORK_SIDE_FULL_WIDTH,
	TEAMWORK_SIDE_NARROW_WIDTH,
	TEAMWORK_SIDE_WIDTH_MAX,
	teamworkSideWidth,
} from "../src/modes/interactive/chat-viewport.ts";

describe("teamwork side column width", () => {
	test("hides below 90 columns and uses a narrow column below 120", () => {
		expect(teamworkSideWidth(85)).toBeUndefined();
		expect(teamworkSideWidth(89)).toBeUndefined();
		expect(teamworkSideWidth(90)).toBe(TEAMWORK_SIDE_NARROW_WIDTH);
		expect(teamworkSideWidth(100)).toBe(TEAMWORK_SIDE_NARROW_WIDTH);
		expect(teamworkSideWidth(119)).toBe(TEAMWORK_SIDE_NARROW_WIDTH);
		expect(TEAMWORK_SIDE_FULL_WIDTH).toBe(120);
	});

	test("scales with the terminal once fully expanded", () => {
		expect(teamworkSideWidth(120)).toBeGreaterThanOrEqual(TEAMWORK_SIDE_NARROW_WIDTH);
		expect(teamworkSideWidth(160)!).toBeGreaterThan(teamworkSideWidth(120)!);
		expect(teamworkSideWidth(200)).toBe(TEAMWORK_SIDE_WIDTH_MAX);
		expect(teamworkSideWidth(400)).toBe(TEAMWORK_SIDE_WIDTH_MAX);
	});

	test("re-evaluates the width on every render so it follows a resize", () => {
		let terminalColumns = 120;
		const rendered: number[] = [];
		const side = {
			render: (width: number) => {
				rendered.push(width);
				return ["side"];
			},
		};
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			side: side as never,
			sideWidth: () => teamworkSideWidth(terminalColumns),
			sideVisible: () => true,
		});

		viewport.root.render(120);
		expect(rendered.at(-1)).toBe(teamworkSideWidth(120));

		terminalColumns = 200;
		viewport.root.render(200);
		expect(rendered.at(-1)).toBe(TEAMWORK_SIDE_WIDTH_MAX);
	});
});

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});
});
