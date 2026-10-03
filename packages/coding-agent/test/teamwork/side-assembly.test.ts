import { Container, sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { createChatViewport, teamworkSideWidth } from "../../src/modes/interactive/chat-viewport.ts";
import { TeamworkSidebarComponent } from "../../src/modes/interactive/components/teamwork-sidebar.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

const data = {
	sessionLine: "~/Desktop/C-code (main)",
	contextLine: "0 tokens · 0.0% used",
	modelLine: "(ollama) qwen3.5:9b-q4_K_M · medium",
	roleModels: {
		leader: { provider: "ollama", model: "qwen3.5:9b-q4_K_M", thinkingLevel: "medium" as const },
		"worker-a": { provider: "ollama", model: "qwen3.5:9b-q4_K_M", thinkingLevel: "medium" as const },
		reviewer: { provider: "xiaomi-token-plan-cn", model: "mimo-v2.6-flash" },
	},
	sessionModel: { provider: "ollama", id: "qwen3.5:9b-q4_K_M" },
	runLine: "· run-1 运行中",
	viewportHeight: 60,
	spinning: false,
} as const;

function renderSideColumn(terminalWidth: number): string {
	const sideWidth = teamworkSideWidth(terminalWidth);
	expect(sideWidth).toBeDefined();
	const sidebar = new TeamworkSidebarComponent({ requestRender: () => {} } as never, { ...data }, () => {});
	const viewport = createChatViewport({
		document: new Container(),
		pendingMessages: new Container(),
		status: new Container(),
		editor: new Container(),
		footer: new Container(),
		side: sidebar as never,
		sideWidth: () => teamworkSideWidth(terminalWidth),
		sideVisible: () => true,
	});
	const lines = viewport.root.render(terminalWidth);
	sidebar.dispose();
	// The side column occupies the rightmost sideWidth columns (gap of 1 before it).
	const sideLines = lines.map((line) =>
		stripTerminalSequences(sliceByColumn(line, terminalWidth - sideWidth!, sideWidth!, false)),
	);
	return sideLines.join("\n");
}

describe("teamwork side assembly", () => {
	it.each([100, 130])("keeps full bindings visible at %i terminal columns", (terminalWidth) => {
		const text = renderSideColumn(terminalWidth);
		const flat = text.replace(/[│↻\s]/g, "");
		expect(flat).toContain("worker-a(ollama/qwen3.5:9b-q4_K_M·medium)");
		expect(flat).toContain("xiaomi-token-plan-cn/mimo-v2.6-flash·off");
		expect(flat).not.toContain("(ollama)qwen3.5:9b-q4_K_M·medium");
		expect(text).not.toContain("...");
	});
});
