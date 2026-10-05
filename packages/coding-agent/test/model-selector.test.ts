import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const runtime = harness.session.modelRuntime;
		const makeSelector = () =>
			new ModelSelectorComponent(
				createFakeTui(),
				currentModel,
				runtime,
				[],
				() => {},
				() => {},
			);
		const typeFilter = (selector: { handleInput(data: string): void }, text: string) => {
			for (const ch of text) selector.handleInput(ch);
		};

		const getModelRow = (selector: { render(width: number): string[] }, id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		const current = makeSelector();
		typeFilter(current, "current-model");
		expect(getModelRow(current, "current-model")).toBe(`→ ✓ current-model [${currentModel.provider}]`);
		current.dispose();

		const browsed = makeSelector();
		typeFilter(browsed, "browsed-model");
		expect(getModelRow(browsed, "browsed-model")).toBe(`→   browsed-model [${currentModel.provider}]`);
		browsed.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		for (const ch of currentModel.id) selector.handleInput(ch);
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	it("marks models from unauthenticated providers with a key hint", async () => {
		harness = await createHarness({
			models: [{ id: "zz-locked-zz-model", name: "Locked Model", reasoning: true }],
		});
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		for (const ch of "zz-locked-zz-model") selector.handleInput(ch);
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("zz-locked-zz-model");
		expect(rendered).toContain("[需填Key]");
		selector.dispose();
	});

	it("routes unauthenticated selection to onNeedAuth instead of onSelect", async () => {
		harness = await createHarness({
			models: [{ id: "zz-locked-zz-model", name: "Locked Model", reasoning: true }],
		});
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		const onSelect = vi.fn();
		const onNeedAuth = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
			undefined,
			undefined,
			undefined,
			onNeedAuth,
		);

		for (const ch of "zz-locked-zz-model") selector.handleInput(ch);
		selector.handleInput("\r");
		expect(onSelect).not.toHaveBeenCalled();
		expect(onNeedAuth).toHaveBeenCalledTimes(1);
		expect(onNeedAuth.mock.calls[0]?.[0]).toMatchObject({ id: "zz-locked-zz-model" });
		selector.dispose();
	});

	it("routes authenticated selection to onSelect", async () => {
		harness = await createHarness({
			models: [{ id: "open-model", name: "Open Model", reasoning: true }],
		});
		const onSelect = vi.fn();
		const onNeedAuth = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
			undefined,
			undefined,
			undefined,
			onNeedAuth,
		);

		for (const ch of "open-model") selector.handleInput(ch);
		selector.handleInput("\r");
		expect(onNeedAuth).not.toHaveBeenCalled();
		expect(onSelect).toHaveBeenCalledTimes(1);
		selector.dispose();
	});

	it("lists recently used models before other models", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "recent-model", name: "Recent Model", reasoning: true },
				{ id: "other-model", name: "Other Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const recent = harness.getModel("recent-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			[{ provider: recent.provider, id: recent.id }],
		);
		const order = stripAnsi(selector.render(120).join("\n"));
		const rows = order.split("\n");
		expect(rows.findIndex((line) => line.includes("current-model ["))).toBeLessThan(
			rows.findIndex((line) => line.includes("recent-model [")),
		);
		// other-model sorts after the visible window: recent outranks it.
		expect(order).not.toContain("other-model [");
		selector.dispose();
	});
});
