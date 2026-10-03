import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * One child of the rendered message body. `key` identifies a slot across streaming
 * updates so its component can be updated in place instead of rebuilt.
 */
type ContentEntry =
	| { kind: "spacer"; key: string }
	| { kind: "markdown"; key: string; text: string; role: "assistant" | "thinking"; runIndex?: number }
	| { kind: "text"; key: string; text: string }
	| { kind: "thinking-toggle"; key: string; runIndex: number; text: string };

interface ContentSlot {
	markdown?: Markdown;
	text?: Text;
	/** Streaming state the Markdown transform was built with; a mismatch forces a rebuild. */
	streaming?: boolean;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	/**
	 * Slot components kept across streaming updates. Reusing them lets the Markdown
	 * render cache survive, so a delta only re-renders the block it belongs to.
	 */
	private readonly contentSlots = new Map<string, ContentSlot>();
	/** Shape of the current body; a change rebuilds the container instead of updating in place. */
	private contentShape = "";

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.contentShape = "";
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		// Padding is fixed at component construction, so cached slots cannot be reused.
		this.contentSlots.clear();
		this.contentShape = "";
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.hasToolCalls = message.content.some((c) => c.type === "toolCall");

		const entries = this.planContent(message, this.hasToolCalls);
		// Streaming state is part of the shape because Markdown transforms capture it,
		// so the final (non-streaming) update rebuilds once with the settled transform.
		const shape = `streaming:${this.isStreaming}|${entries.map((entry) => `${entry.kind}\u0000${entry.key}`).join("\u0001")}`;
		if (shape === this.contentShape) {
			this.updateSlotsInPlace(entries);
			return;
		}
		this.contentShape = shape;
		this.mountSlots(entries);
	}

	/** Update the text of already-mounted slots without touching the container structure. */
	private updateSlotsInPlace(entries: readonly ContentEntry[]): void {
		for (const entry of entries) {
			const slot = this.contentSlots.get(entry.key);
			if (entry.kind === "markdown") slot?.markdown?.setText(entry.text);
			else if (entry.kind === "text" || entry.kind === "thinking-toggle") slot?.text?.setText(entry.text);
		}
	}

	/** Mount the planned entries, reusing the component held by each matching slot. */
	private mountSlots(entries: readonly ContentEntry[]): void {
		this.contentContainer.clear();
		for (const entry of entries) {
			if (entry.kind === "spacer") {
				this.contentContainer.addChild(new Spacer(1));
				continue;
			}
			if (entry.kind === "markdown") {
				const slot = this.contentSlots.get(entry.key);
				const reusable = slot?.streaming === this.isStreaming ? slot.markdown : undefined;
				const markdown =
					reusable ??
					new Markdown(
						"",
						this.outputPad,
						0,
						this.markdownTheme,
						entry.role === "thinking"
							? { color: (text: string) => theme.fg("thinkingText", text), italic: true }
							: undefined,
						{
							transform: createMarkdownTransform(
								entry.role === "thinking" ? "assistant-thinking" : "assistant",
								this.isStreaming,
								this.markdownTransformers,
							),
						},
					);
				markdown.setText(entry.text);
				this.contentSlots.set(entry.key, { markdown, streaming: this.isStreaming });
				if (entry.kind === "markdown" && entry.role === "thinking" && entry.runIndex !== undefined) {
					const runIndex = entry.runIndex;
					this.contentContainer.addChild(
						new MouseRegion(markdown, (event) => {
							if (event.type !== "click" || event.button !== "left") return undefined;
							// This slot only exists while the run is visible, so the click collapses it.
							this.thinkingVisibilityOverrides.set(runIndex, true);
							if (this.lastMessage) this.updateContent(this.lastMessage);
							return { handled: true };
						}),
					);
					continue;
				}
				this.contentContainer.addChild(markdown);
				continue;
			}

			const slot = this.contentSlots.get(entry.key);
			const text = slot?.text ?? new Text("", this.outputPad, 0);
			text.setText(entry.text);
			this.contentSlots.set(entry.key, { text });
			if (entry.kind === "thinking-toggle") {
				const runIndex = entry.runIndex;
				this.contentContainer.addChild(
					new MouseRegion(text, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						// This slot only exists while the run is hidden, so the click expands it.
						this.thinkingVisibilityOverrides.set(runIndex, false);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				continue;
			}
			this.contentContainer.addChild(text);
		}
	}

	/** Describe the message body as ordered slots without creating anything. */
	private planContent(message: AssistantMessage, hasToolCalls: boolean): ContentEntry[] {
		const entries: ContentEntry[] = [];
		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			entries.push({ kind: "spacer", key: "spacer:head" });
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				entries.push({ kind: "markdown", key: `text:${i}`, text: content.text.trim(), role: "assistant" });
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				if (hidden) {
					entries.push({
						kind: "thinking-toggle",
						key: `thinking:${runIndex}:hidden`,
						runIndex,
						text: theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)),
					});
				} else {
					entries.push({
						kind: "markdown",
						key: `thinking:${runIndex}:visible`,
						text: thinkingBlocks.join("\n\n"),
						role: "thinking",
						runIndex,
					});
				}
				if (hasVisibleContentAfter) {
					entries.push({ kind: "spacer", key: `spacer:thinking:${runIndex}` });
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		if (message.stopReason === "length") {
			entries.push({ kind: "spacer", key: "spacer:notice" });
			entries.push({
				kind: "text",
				key: "notice:length",
				text: theme.fg("error", "Response was truncated before completion."),
			});
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				entries.push({ kind: "spacer", key: "spacer:notice" });
				entries.push({ kind: "text", key: "notice:aborted", text: theme.fg("error", abortMessage) });
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				entries.push({ kind: "spacer", key: "spacer:notice" });
				entries.push({ kind: "text", key: "notice:error", text: theme.fg("error", `Error: ${errorMsg}`) });
			}
		}

		return entries;
	}
}
