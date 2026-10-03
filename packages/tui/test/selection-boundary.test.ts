import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { findSelectionBoundaryAt, SelectionBoundary } from "../src/components/selection-boundary.ts";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("SelectionBoundary", () => {
	it("finds the innermost boundary box at a point", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TuiAltScreen(terminal);
		const side = new SelectionBoundary();
		tui.setLayoutRoot(
			new HStack([
				{ component: new Text("main", 0, 0), basis: 20 },
				{ component: side, basis: 20 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		const frame = (tui as unknown as { currentLayout: Parameters<typeof findSelectionBoundaryAt>[0] }).currentLayout;
		assert.ok(frame);
		const hit = findSelectionBoundaryAt(frame, 25, 0);
		assert.ok(hit);
		assert.strictEqual(hit.x, 20);
		assert.strictEqual(findSelectionBoundaryAt(frame, 5, 0), undefined);
		tui.stop();
	});

	it("clips a sidebar selection so it never copies main-area text", async () => {
		const copied: string[] = [];
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		// Rebuild with real side content inside the boundary.
		tui.setLayoutRoot(
			new HStack([
				{ component: new Text("main-aaaa\nmain-bbbb", 0, 0), basis: 20 },
				{
					component: (() => {
						const boundary = new SelectionBoundary();
						boundary.addChild(new Text("side-xxxx\nside-yyyy", 0, 0));
						return boundary;
					})(),
					basis: 20,
				},
			]),
		);
		tui.start();
		await terminal.waitForRender();

		// Press inside the sidebar, drag left into the main area and down.
		terminal.sendInput("\x1b[<0;21;1M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["side-xxxx\n"]);
		assert.ok(!copied[0]?.includes("main"));
		tui.stop();
	});

	it("leaves selections outside any boundary unclamped", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.setLayoutRoot(
			new HStack([
				{ component: new Text("main-aaaa\nmain-bbbb", 0, 0), basis: 20 },
				{ component: new Text("side-xxxx\nside-yyyy", 0, 0), basis: 20 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;21;1M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();

		assert.strictEqual(copied.length, 1);
		assert.ok(copied[0]?.includes("main-"));
		assert.ok(copied[0]?.includes("side-xxxx"));
		tui.stop();
	});
});
