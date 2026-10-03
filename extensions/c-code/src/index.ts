/**
 * C-code 品牌 extension：开局扫描线动效 + 中文 slash 命令 + agent 三模式。
 *
 * Tab/Shift+Tab 改键在 ~/.c-code/agent/keybindings.json 配（Tab=思考循环，
 * 补全改 ctrl+space，shift+tab 空出来给模式轮转）。
 * 动效播完即停并常驻为静态 banner；dispose 清 timer。
 * 约束：extension 截获不到原始按键，故动效无"按键跳过"（固定约 1.1s 播完）。
 *
 * 安装（二选一）：
 * - 常驻：ln -s <本目录> ~/.c-code/agent/extensions/c-code
 * - 临时：c-code --extension <本目录>/src/index.ts
 */

import { VERSION, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MODE,
	decideToolCall,
	modeColor,
	nextMode,
	themeForMode,
	toolsForMode,
	MODE_ORDER,
	type AgentMode,
} from "./agent-modes.ts";
import { TOTAL_FRAMES, bootScale, greenHot, greenMain, renderBootFrame } from "./boot-frames.ts";
import { runAddModelFlow } from "./model-entry.ts";
import { registerZhCommands } from "./zh-commands.ts";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const FRAME_MS = 70;
const MODE_STATUS_KEY = "c-code-mode";

interface ModeUI {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	setTheme(theme: string): { success: boolean; error?: string };
	theme: { fg(name: string, text: string): string };
}

export default function cCodeExtension(pi: ExtensionAPI) {
	registerZhCommands(pi, VERSION);

	let mode: AgentMode = DEFAULT_MODE;
	let toolsBeforePlan: string[] | undefined;
	let modelId: string | undefined;
	let requestRender: (() => void) | undefined;

	function paintStatus(theme: { fg(name: string, text: string): string }, next: AgentMode): string {
		return theme.fg(modeColor(next), `● ${next}`);
	}

	/** bak 式页眉状态行：`C-code · 模型 · 模式`，模式三色随 shift+tab 变。 */
	function statusLine(theme: { fg(name: string, text: string): string }): string {
		return `  C-code · ${modelId ?? "—"} · ${theme.fg(modeColor(mode), mode)}`;
	}

	function applyMode(ui: ModeUI, next: AgentMode): void {
		mode = next;
		if (mode === "plan") {
			if (toolsBeforePlan === undefined) toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(toolsForMode(mode, toolsBeforePlan));
		} else {
			pi.setActiveTools(toolsForMode(mode, toolsBeforePlan ?? pi.getActiveTools()));
			toolsBeforePlan = undefined;
		}
		const switched = ui.setTheme(themeForMode(mode));
		ui.setStatus(MODE_STATUS_KEY, paintStatus(ui.theme, mode));
		if (!switched.success) {
			ui.notify(`主题 ${themeForMode(mode)} 切换失败：${switched.error ?? "未知错误"}`, "warning");
		}
		ui.notify(`已切换到 ${mode} 模式`, "info");
	}

	async function cycleMode(ctx: { ui: ModeUI }): Promise<void> {
		applyMode(ctx.ui, nextMode(mode));
	}

	pi.registerShortcut("shift+tab", {
		description: "切换 agent 模式 plan/build/yolo",
		handler: async (ctx) => cycleMode(ctx),
	});

	pi.registerCommand("模式", {
		description: "切换 agent 模式（plan/build/yolo）",
		getArgumentCompletions: (prefix: string) => {
			const matched = MODE_ORDER.filter((m) => m.startsWith(prefix));
			return matched.length > 0 ? matched.map((m) => ({ value: m, label: m })) : null;
		},
		handler: async (args, ctx) => {
			const target = args.trim() as AgentMode;
			if (MODE_ORDER.includes(target)) {
				applyMode(ctx.ui, target);
			} else {
				ctx.ui.notify(`当前 ${mode} 模式，用法：/模式 plan|build|yolo`, "info");
			}
		},
	});

	pi.registerCommand("加模型", {
		description: "交互式添加自定义模型商到 models.json",
		handler: async (_args, ctx) => {
			await runAddModelFlow({
				ui: ctx.ui,
				fs: {
					readFile: (path: string) => readFileSync(path, "utf8"),
					writeFile: (path: string, content: string) => writeFileSync(path, content),
					copyFile: (src: string, dst: string) => copyFileSync(src, dst),
				},
				agentDir: getAgentDir(),
			});
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const decision = decideToolCall(mode, event.toolName, event.input as Record<string, unknown>, ctx.hasUI);
		if (decision === "allow") return undefined;
		if (decision === "deny") {
			if (ctx.hasUI) ctx.ui.notify(`${mode} 模式下 ${event.toolName} 不可用`, "warning");
			return { block: true, reason: `${mode} 模式禁用 ${event.toolName}` };
		}
		const what =
			event.toolName === "bash"
				? `危险命令：\n\n  ${(event.input as { command?: string }).command ?? ""}`
				: `${mode} 模式写操作：${event.toolName}`;
		const choice = await ctx.ui.select(`${what}\n\n允许本次执行？`, ["允许", "拒绝"]);
		if (choice !== "允许") return { block: true, reason: "用户拒绝本次执行" };
		return undefined;
	});

	pi.on("turn_start", async (_event, ctx) => {
		const next = ctx.model?.id;
		if (next !== modelId) {
			modelId = next;
			requestRender?.();
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (ctx.model?.id) modelId = ctx.model.id;
		if (ctx.hasUI) ctx.ui.setStatus(MODE_STATUS_KEY, paintStatus(ctx.ui.theme, mode));
		ctx.ui.setHeader((tui, theme) => {
			let frame = 0;
			let timer: ReturnType<typeof setInterval> | null = null;
			let disposed = false;
			requestRender = () => tui.requestRender();
			const paint = {
				main: (text: string, row?: number) => greenMain(text, row),
				hot: (text: string) => greenHot(text),
				dim: (text: string) => theme.fg("dim", text),
				muted: (text: string) => theme.fg("muted", text),
			};
			return {
				render(width: number): string[] {
					// render 内起 timer：header 工厂没有独立挂载钩子，
					// 以首次渲染为起点播完 16 帧即停；dispose 后不再重起。
					if (!disposed && timer === null && frame < TOTAL_FRAMES) {
						timer = setInterval(() => {
							frame += 1;
							if (frame >= TOTAL_FRAMES && timer !== null) {
								clearInterval(timer);
								timer = null;
							}
							tui.requestRender();
						}, FRAME_MS);
					}
					return [...renderBootFrame(paint, VERSION, frame, bootScale(width)), statusLine(theme)];
				},
				invalidate() {},
				dispose() {
					disposed = true;
					requestRender = undefined;
					if (timer !== null) {
						clearInterval(timer);
						timer = null;
					}
				},
			};
		});
	});
}
