/**
 * C-code 品牌 extension：开局扫描线动效 + 中文 slash 命令 + agent 三模式 + 只读子代理。
 *
 * 子代理（task 工具）：派生独立 pi 进程跑只读调研（read/grep/find/ls），
 * 进程级隔离，写工具在子进程不存在；详见 subagent.ts 的安全契约。
 *
 * Tab/Shift+Tab 改键在 ~/.c-code/agent/keybindings.json 配（Tab=思考循环，
 * 补全改 ctrl+space，shift+tab 空出来给模式轮转）。
 * 动效播完即停并常驻为静态 banner；dispose 清 timer。
 * 仅冷启动（session_start reason=startup）播动画；/new、resume、fork、reload
 * 直接落静态终帧，避免每次切会话重播。
 * 约束：extension 截获不到原始按键，故动效无"按键跳过"（固定约 1.1s 播完）。
 *
 * 安装（二选一）：
 * - 常驻：ln -s <本目录> ~/.c-code/agent/extensions/c-code
 * - 临时：c-code --extension <本目录>/src/index.ts
 */

import { VERSION, getAgentDir, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MODE,
	decideToolCall,
	modeColor,
	nextMode,
	PLAN_DISABLED_TOOLS,
	SHELL_TOOLS,
	themeForMode,
	toolsForMode,
	WRITE_TOOLS,
	MODE_ORDER,
	type AgentMode,
} from "./agent-modes.ts";
import { TOTAL_FRAMES, bootScale, greenHot, greenMain, renderBootFrame } from "./boot-frames.ts";
import { runAddModelFlow } from "./model-entry.ts";
import {
	buildSubagentArgs,
	formatSubagentResult,
	resolvePiInvocation,
	runSubagent,
	SUBAGENT_PROFILE_ENV,
	SUBAGENT_TIMEOUT_MS,
} from "./subagent.ts";
import { registerZhCommands } from "./zh-commands.ts";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Type } from "typebox";

const FRAME_MS = 70;
const MODE_STATUS_KEY = "c-code-mode";

/** 宿主 UI 能力的结构子集（保持与 ExtensionUIContext 对齐，编译期跟随宿主演进）。 */
type ModeUI = Pick<ExtensionUIContext, "setStatus" | "notify" | "select" | "setTheme" | "theme">;

export default function cCodeExtension(pi: ExtensionAPI) {
	registerZhCommands(pi, VERSION);

	/**
	 * 只读子代理 profile 标记（初始化时读一次）：由 task 工具派生的子进程带上。
	 * 当前子进程用 --no-extensions 不加载扩展，本标记是保险层——
	 * 若将来去掉 -ne，子进程内的本扩展也会锁死只读，不会退化成可写。
	 */
	const subagentProfile = process.env[SUBAGENT_PROFILE_ENV] === "1";

	let mode: AgentMode = DEFAULT_MODE;
	let toolsBeforePlan: string[] | undefined;
	let modelId: string | undefined;
	let requestRender: (() => void) | undefined;

	function paintStatus(theme: ModeUI["theme"], next: AgentMode): string {
		return theme.fg(modeColor(next), `● ${next}`);
	}

	/** bak 式页眉状态行：`C-code · 模型 · 模式`，模式三色随 shift+tab 变。 */
	function statusLine(theme: ModeUI["theme"]): string {
		return `  C-code · ${modelId ?? "—"} · ${theme.fg(modeColor(mode), mode)}`;
	}

	function applyMode(ui: ModeUI, next: AgentMode, options?: { silent?: boolean }): void {
		mode = next;
		if (mode === "plan") {
			if (toolsBeforePlan === undefined) toolsBeforePlan = pi.getActiveTools();
			pi.setActiveTools(toolsForMode(mode, toolsBeforePlan));
		} else {
			// 恢复 plan 前工具集，同时保留 plan 期间新启用（非写类）的工具
			const current = pi.getActiveTools();
			const base = toolsBeforePlan ?? current;
			pi.setActiveTools([...new Set([...base, ...current.filter((t) => !PLAN_DISABLED_TOOLS.includes(t))])]);
			toolsBeforePlan = undefined;
		}
		const switched = ui.setTheme(themeForMode(mode));
		ui.setStatus(MODE_STATUS_KEY, paintStatus(ui.theme, mode));
		if (!switched.success) {
			ui.notify(`主题 ${themeForMode(mode)} 切换失败：${switched.error ?? "未知错误"}`, "warning");
		}
		if (!options?.silent) ui.notify(`已切换到 ${mode} 模式`, "info");
	}

	pi.registerShortcut("shift+tab", {
		description: "切换 agent 模式 plan/build/yolo",
		handler: async (ctx) => applyMode(ctx.ui, nextMode(mode)),
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
				env: (name) => process.env[name],
			});
		},
	});

	interface TaskToolDetails {
		running?: boolean;
		exitCode?: number;
		durationMs?: number;
		aborted?: boolean;
		timedOut?: boolean;
	}

	const TaskParams = Type.Object({
		prompt: Type.String({
			minLength: 1,
			maxLength: 20_000,
			description: "交给子代理的完整任务描述（自包含：子代理看不到当前会话）",
		}),
	});

	if (!subagentProfile) {
		pi.registerTool<typeof TaskParams, TaskToolDetails>({
			name: "task",
			label: "子代理",
			description: [
				"把一个自包含的调研任务派给独立进程的只读子代理，返回它的结论。",
				"子代理只能读文件与检索代码（read/grep/find/ls），无法修改文件、无法执行命令。",
				"适用于大范围检索、跨文件调研、需要独立上下文的重活；不适合需要写文件的任务。",
			].join(""),
			parameters: TaskParams,
			// 每次调用会派生一个进程，禁止与其他工具并发执行，避免批量刷进程
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const args = buildSubagentArgs({
					prompt: params.prompt,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinkingLevel: ctx.thinkingLevel,
				});
				const invocation = resolvePiInvocation(args, {
					execPath: process.execPath,
					currentScript: process.argv[1],
					exists: existsSync,
				});
				const startedAt = Date.now();
				const result = await runSubagent(
					{
						spawn,
						command: invocation.command,
						args: invocation.args,
						cwd: ctx.cwd,
						env: { ...process.env, [SUBAGENT_PROFILE_ENV]: "1" },
						timeoutMs: SUBAGENT_TIMEOUT_MS,
						onProgress: (turns) => {
							onUpdate?.({
								content: [{ type: "text", text: `子代理运行中…（已完成 ${turns} 轮）` }],
								details: { running: true },
							});
						},
					},
					signal,
				);
				const durationMs = Date.now() - startedAt;
				pi.appendEntry("c-code-subagent", {
					exitCode: result.exitCode,
					durationMs,
					aborted: result.aborted,
					timedOut: result.timedOut,
					error: result.error,
				});
				return {
					content: [{ type: "text" as const, text: formatSubagentResult(result) }],
					details: {
						exitCode: result.exitCode,
						durationMs,
						aborted: result.aborted,
						timedOut: result.timedOut,
					},
				};
			},
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		// 保险层：只读子代理 profile 下写/shell 一律拒绝（当前子进程 -ne 不会走到这里）
		if (subagentProfile && (WRITE_TOOLS.includes(event.toolName) || SHELL_TOOLS.includes(event.toolName))) {
			return { block: true, reason: "只读子代理 profile：写操作与 shell 一律禁用" };
		}
		const decision = decideToolCall(mode, event.toolName, event.input as Record<string, unknown>, ctx.hasUI);
		if (decision === "allow") return undefined;
		if (decision === "deny") {
			const reason = ctx.hasUI
				? `${mode} 模式禁用 ${event.toolName}`
				: `headless 模式下 ${mode} 模式不允许 ${event.toolName}（无人可确认，需写入请用 yolo）`;
			if (ctx.hasUI) ctx.ui.notify(`${mode} 模式下 ${event.toolName} 不可用`, "warning");
			return { block: true, reason };
		}
		// event 为判别联合，此处已确认走 confirm 分支：shell 显示命令，plan 下强调只读语义
		let what: string;
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const command = event.input.command;
			what =
				mode === "plan"
					? `plan 模式只读，shell 命令需逐条确认：\n\n  ${command}`
					: `危险命令：\n\n  ${command}`;
		} else {
			what = `${mode} 模式写操作：${event.toolName}`;
		}
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

	// /model 切换即时刷新状态行（turn_start 要等下一轮，滞后）
	pi.on("model_select", async (_event, ctx) => {
		const next = ctx.model?.id;
		if (next !== undefined && next !== modelId) {
			modelId = next;
			requestRender?.();
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (ctx.model?.id) modelId = ctx.model.id;
		// 启动即对齐默认模式主题：只画状态不套主题会让全屏沿用旧主题色
		//（此前必须手动切一遍模式才正常）。静默走同一 applyMode。
		if (ctx.hasUI) applyMode(ctx.ui, mode, { silent: true });
		// 仅冷启动播扫描线；/new、resume、fork、reload 直接落终帧静态 banner
		const bootFrom = event.reason === "startup" ? 0 : TOTAL_FRAMES;
		ctx.ui.setHeader((tui, theme) => {
			let frame = bootFrom;
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
