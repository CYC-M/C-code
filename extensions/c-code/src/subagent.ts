/**
 * 子代理：派生独立 pi 进程完成只读调研任务（进程级隔离，官方 examples/extensions/subagent 同款路线）。
 *
 * 安全契约（改动前先读 agent-modes.ts 的 SUBAGENT_TOOLS 注释）：
 * - 工具白名单由子进程 CLI 的 --tools 强制：read,grep,find,ls。写工具在子进程里根本不存在，
 *   不依赖 LLM 自觉，也不依赖事件拦截（同进程嵌套 Agent 的门控盲区在这里不存在）。
 * - --no-extensions：子进程不加载任何扩展（含本扩展）→ 没有 task 工具，递归深度恒为 1。
 * - 环境变量 C_CODE_SUBAGENT=1 为双重保险：万一将来去掉 -ne，本扩展在子进程中会锁只读 profile。
 * - --no-session：子代理不落盘会话，不污染用户会话列表。
 * - abort/超时：SIGTERM → 5s 后无条件 SIGKILL（幂等）；默认总超时 10 分钟。
 * - 模型可见输出截断 50KB、stderr 截断 20KB，防止撑爆主会话上下文或内存。
 *
 * 参数拼装 / 事件解析 / 命令解析 / 结果文案均为纯函数，流程层注入 spawn 便于单测。
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";

/** 子代理可用工具白名单（唯一真源：CLI --tools 参数）。 */
export const SUBAGENT_READONLY_TOOLS = "read,grep,find,ls";
export const SUBAGENT_OUTPUT_LIMIT = 50_000;
export const SUBAGENT_STDERR_LIMIT = 20_000;
export const SUBAGENT_PROFILE_ENV = "C_CODE_SUBAGENT";
export const SUBAGENT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;

/**
 * 子进程参数（纯函数）：只读白名单 + 无扩展 + 无会话 + JSON 事件流。
 *
 * 安全细节：prompt 以 `--` 终止符 + "Task: " 前缀传入——
 * - `--` 之后宿主 CLI 不再解析旗标，prompt 里即便出现 "--tools bash,edit" 也只是文本；
 *   （宿主 args.ts 对重复旗标是"后者覆盖"，裸位置参数以 - 开头会被当旗标，可击穿白名单）
 * - "Task: " 前缀避免 prompt 以 `@` 开头被误路由为 fileArgs（官方示例同款前缀）。
 */
export function buildSubagentArgs(opts: { prompt: string; model?: string; thinkingLevel?: string }): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--tools", SUBAGENT_READONLY_TOOLS];
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
	args.push("--", `Task: ${opts.prompt}`);
	return args;
}

/** 从一条 JSON 事件里取 assistant 文本（message_end 事件，非 assistant 返回 undefined）。 */
function assistantTextOf(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const e = event as { type?: unknown; message?: { role?: unknown; content?: unknown } };
	if (e.type !== "message_end" || e.message?.role !== "assistant") return undefined;
	const content = e.message.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const p = part as { type?: unknown; text?: unknown };
		if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	return parts.join("");
}

/** 取子代理的模型层错误（stopReason==="error" 或 errorMessage），无则 undefined。 */
export function extractSubagentError(lines: string[]): string | undefined {
	let error: string | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		if (typeof event !== "object" || event === null) continue;
		const e = event as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
		if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
		if (e.message.stopReason === "error") {
			error = typeof e.message.errorMessage === "string" && e.message.errorMessage ? e.message.errorMessage : "模型返回错误";
		}
	}
	return error;
}

/** JSON 事件行 → 最后一条 assistant 文本（子代理最终答复）。坏行忽略。 */
export function extractFinalOutput(lines: string[]): string {
	let last = "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		const text = assistantTextOf(event);
		if (text !== undefined) last = text;
	}
	return last;
}

/** 硬上限截断：输出总长不超过 limit，标记文本计入配额。 */
export function truncateOutput(text: string, limit = SUBAGENT_OUTPUT_LIMIT): string {
	if (text.length <= limit) return text;
	const note = `\n\n…（子代理输出超 ${limit} 字符已截断，原始长度 ${text.length}）`;
	return text.slice(0, Math.max(0, limit - note.length)) + note;
}

export interface PiInvocationDeps {
	execPath: string;
	currentScript: string | undefined;
	exists(path: string): boolean;
}

/**
 * 解析 pi 进程启动方式（纯函数，与官方示例同策略）：
 * 1) 正常脚本启动：node <当前脚本> <args>
 * 2) bun 虚拟路径：回退到同名可执行文件
 * 3) 可执行文件本体启动：直接 <execPath> <args>
 * 4) 裸 node/bun 且脚本不可用：回退 PATH 里的 pi
 */
export function resolvePiInvocation(
	args: string[],
	deps: PiInvocationDeps,
): { command: string; args: string[] } {
	const script = deps.currentScript;
	const isBunVirtualScript = script?.startsWith("/$bunfs/root/") ?? false;
	if (script && !isBunVirtualScript && deps.exists(script)) {
		return { command: deps.execPath, args: [script, ...args] };
	}
	const execName = basename(deps.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: deps.execPath, args };
	}
	return { command: "pi", args };
}

export interface SubagentRunDeps {
	spawn: typeof spawn;
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** 每完成一轮 assistant 回合回调一次（用于向主会话流式透出进度）。 */
	onProgress?: (turns: number) => void;
}

export interface SubagentRunResult {
	exitCode: number;
	output: string;
	stderr: string;
	/** 模型层错误（stopReason==="error"），与进程退出码无关。 */
	error?: string;
	aborted: boolean;
	timedOut: boolean;
}

/** 派生子进程并收集 JSON 事件流。signal 触发或超时终止时置 aborted/timedOut。 */
export async function runSubagent(deps: SubagentRunDeps, signal?: AbortSignal): Promise<SubagentRunResult> {
	return new Promise<SubagentRunResult>((resolve) => {
		const proc = deps.spawn(deps.command, deps.args, {
			cwd: deps.cwd,
			env: deps.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const lines: string[] = [];
		let buffer = "";
		let stderr = "";
		let turns = 0;
		let aborted = false;
		let timedOut = false;
		let settled = false;

		// 宽限期后无条件 SIGKILL：proc.killed 只表示"发过信号"，
		// 子进程若忽略 SIGTERM，靠它判断会让 SIGKILL 永远发不出去 → 超时形同虚设
		const killProc = (): void => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				proc.kill("SIGKILL");
			}, KILL_GRACE_MS);
		};
		const onAbort = (): void => {
			aborted = true;
			killProc();
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			killProc();
		}, deps.timeoutMs ?? SUBAGENT_TIMEOUT_MS);
		const finish = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (buffer.trim()) lines.push(buffer);
			resolve({
				exitCode,
				output: truncateOutput(extractFinalOutput(lines)),
				stderr,
				error: extractSubagentError(lines),
				aborted,
				timedOut,
			});
		};
		const handleLine = (line: string): void => {
			lines.push(line);
			if (assistantTextOf(safeParse(line)) !== undefined) {
				turns += 1;
				deps.onProgress?.(turns);
			}
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				if (part.trim()) handleLine(part);
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length >= SUBAGENT_STDERR_LIMIT) return;
			stderr = (stderr + chunk.toString()).slice(0, SUBAGENT_STDERR_LIMIT);
		});
		proc.on("close", (code) => finish(code ?? 0));
		proc.on("error", () => finish(1));

		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function safeParse(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
}

/** 结果 → 给主模型看的文案（纯函数）。 */
export function formatSubagentResult(result: SubagentRunResult): string {
	if (result.aborted || result.timedOut) {
		const why = result.timedOut ? "超时被终止" : "被中止";
		return [`子代理${why}。`, result.output, result.error ? `错误：${result.error}` : "", result.stderr ? `stderr:\n${result.stderr}` : ""]
			.filter(Boolean)
			.join("\n");
	}
	if (result.exitCode !== 0) {
		return [`子代理异常退出（exit ${result.exitCode}）。`, result.output || result.stderr || "(无输出)"].join("\n");
	}
	if (result.output) return result.output;
	if (result.error) return `子代理未产出结论：${result.error}`;
	return "(子代理无输出)";
}
