import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

/**
 * Incremental rendering must be invisible: a Markdown component that grows one
 * delta at a time has to render exactly like a fresh component holding the same
 * text. These tests grow real documents prefix by prefix and compare both paths.
 */
const DOCUMENTS: Record<string, string> = {
	prose: [
		"# Heading",
		"",
		"A paragraph with **bold**, *italic*, `code` and a [link](https://example.com).",
		"",
		"Second paragraph that keeps going for a while so the live tail spans more than one block boundary.",
		"",
		"## Sub heading",
		"",
		"- first",
		"- second",
		"",
		"Closing paragraph.",
		"",
	].join("\n"),
	looseList: ["Intro paragraph.", "", "- alpha", "", "- beta", "", "- gamma", "", "Outro.", ""].join("\n"),
	nested: ["1. one", "2. two", "   - nested a", "   - nested b", "3. three", "", "Done.", ""].join("\n"),
	fencedCode: [
		"Before.",
		"",
		"```ts",
		"const a = 1;",
		"",
		"const b = 2;",
		"```",
		"",
		"After the fence.",
		"",
		"```",
		"still streaming?",
		"",
	].join("\n"),
	blockquoteAndTable: [
		"> quoted line one",
		"> quoted line two",
		"",
		"| a | b |",
		"| - | - |",
		"| 1 | 2 |",
		"",
		"Tail paragraph.",
		"",
	].join("\n"),
	headings: ["---", "", "# One", "", "## Two", "", "### Three", "", "Text.", ""].join("\n"),
};

function renderWidths(markdown: Markdown, widths: readonly number[]): string[][] {
	return widths.map((width) => markdown.render(width));
}

describe("Markdown incremental rendering", () => {
	for (const [name, document] of Object.entries(DOCUMENTS)) {
		it(`matches a fresh render while growing: ${name}`, () => {
			const width = 60;
			const incremental = new Markdown("", 2, 0, defaultMarkdownTheme);
			for (let length = 1; length <= document.length; length += 3) {
				const text = document.slice(0, length);
				incremental.setText(text);
				const growthOutput = incremental.render(width);
				const freshOutput = new Markdown(text, 2, 0, defaultMarkdownTheme).render(width);
				assert.deepStrictEqual(growthOutput, freshOutput, `mismatch at length ${length} for ${name}`);
			}
			// Full document, one more time, to cover the final prefix exactly.
			incremental.setText(document);
			assert.deepStrictEqual(
				incremental.render(width),
				new Markdown(document, 2, 0, defaultMarkdownTheme).render(width),
			);
		});
	}

	it("re-renders correctly after a width change", () => {
		const document = DOCUMENTS.prose;
		const incremental = new Markdown("", 2, 0, defaultMarkdownTheme);
		for (let length = 1; length <= document.length; length += 7) {
			incremental.setText(document.slice(0, length));
			incremental.render(60);
		}
		incremental.setText(document);
		assert.deepStrictEqual(
			renderWidths(incremental, [80])[0],
			new Markdown(document, 2, 0, defaultMarkdownTheme).render(80),
		);
		assert.deepStrictEqual(
			renderWidths(incremental, [40])[0],
			new Markdown(document, 2, 0, defaultMarkdownTheme).render(40),
		);
	});

	it("honors background styling and padding on the frozen prefix", () => {
		const document = [
			"First paragraph that is long enough to freeze once the tail grows past it.",
			"",
			"Second paragraph.",
			"",
			"Third paragraph that is still streaming.",
		].join("\n");
		const style = { bgColor: (text: string) => `\x1b[48;5;236m${text}\x1b[49m` };
		const incremental = new Markdown("", 1, 1, defaultMarkdownTheme, style);
		for (let length = 1; length <= document.length; length += 5) {
			incremental.setText(document.slice(0, length));
			incremental.render(50);
		}
		incremental.setText(document);
		assert.deepStrictEqual(
			incremental.render(50),
			new Markdown(document, 1, 1, defaultMarkdownTheme, style).render(50),
		);
	});

	it("re-renders correctly when the text is replaced instead of extended", () => {
		const incremental = new Markdown(DOCUMENTS.prose, 2, 0, defaultMarkdownTheme);
		incremental.render(60);
		incremental.setText("Completely different content.\n\nWith two paragraphs.\n");
		assert.deepStrictEqual(
			incremental.render(60),
			new Markdown("Completely different content.\n\nWith two paragraphs.\n", 2, 0, defaultMarkdownTheme).render(60),
		);
	});
});
