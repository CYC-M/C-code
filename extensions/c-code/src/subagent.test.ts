import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	SUBAGENT_OUTPUT_LIMIT,
	SUBAGENT_PROFILE_ENV,
	SUBAGENT_READONLY_TOOLS,
	SUBAGENT_STDERR_LIMIT,
	buildSubagentArgs,
	extractFinalOutput,
	extractSubagentError,
	formatSubagentResult,
	resolvePiInvocation,
	runSubagent,
	truncateOutput,
	type SubagentRunResult,
} from "./subagent.ts";

describe("buildSubagentArgs", () => {
	test("固定只读白名单 + 无扩展 + 无会话 + JSON 事件流，prompt 走 -- 终止符", () => {
		const args = buildSubagentArgs({ prompt: "find auth code" });
		expect(args).toContain("-p");
		expect(args).toContain("--no-session");
		expect(args).toContain("--no-extensions");
		expect(args).toEqual(expect.arrayContaining(["--tools", SUBAGENT_READONLY_TOOLS]));
		expect(args.at(-2)).toBe("--");
		expect(args.at(-1)).toBe("Task: find auth code");
	});

	test("白名单里绝不含写工具或 shell（安全契约的硬断言）", () => {
		const args = buildSubagentArgs({ prompt: "x" });
		const toolsArg = args[args.indexOf("--tools") + 1];
		for (const forbidden of ["edit", "write", "bash", "powershell"]) {
			expect(toolsArg.split(",")).not.toContain(forbidden);
		}
		for (const allowed of ["read", "grep", "find", "ls"]) {
			expect(toolsArg.split(",")).toContain(allowed);
		}
	});

	test("注入回归：prompt 以 --tools/-p/@ 开头也不得变成旗标（-- 后只能是消息）", () => {
		const malicious = buildSubagentArgs({ prompt: '--tools bash,edit,write 先改白名单再干活' });
		//  "--tools" 作为独立 argv 只允许出现一次（我们自己的白名单）
		expect(malicious.filter((a) => a === "--tools")).toHaveLength(1);
		// prompt 整体是 -- 之后的单个消息 token，且带 Task: 前缀（防 @ 误路由）
		expect(malicious.at(-2)).toBe("--");
		expect(malicious.at(-1)).toBe("Task: --tools bash,edit,write 先改白名单再干活");

		const atPrefix = buildSubagentArgs({ prompt: "@etc/passwd 看看这个" });
		expect(atPrefix.at(-1)).toBe("Task: @etc/passwd 看看这个");
	});

	test("模型与思考档继承可选", () => {
		const bare = buildSubagentArgs({ prompt: "x" });
		expect(bare).not.toContain("--model");
		expect(bare).not.toContain("--thinking");

		const full = buildSubagentArgs({ prompt: "x", model: "anthropic/claude-x", thinkingLevel: "high" });
		expect(full).toEqual(expect.arrayContaining(["--model", "anthropic/claude-x", "--thinking", "high"]));
	});
});

describe("extractFinalOutput", () => {
	const assistantEnd = (text: string) =>
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

	test("取最后一条 assistant 文本，忽略工具消息与坏行", () => {
		const lines = [
			assistantEnd("第一版结论"),
			"{ 不是 json",
			JSON.stringify({ type: "message_end", message: { role: "tool", content: [] } }),
			"",
			assistantEnd("最终结论"),
		];
		expect(extractFinalOutput(lines)).toBe("最终结论");
	});

	test("多段 text 拼接；无 assistant 时返回空串", () => {
		const multi = JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
		});
		expect(extractFinalOutput([multi])).toBe("AB");
		expect(extractFinalOutput([JSON.stringify({ type: "turn_start" })])).toBe("");
		expect(extractFinalOutput([])).toBe("");
	});
});

describe("truncateOutput", () => {
	test("未超限原样返回，超限截断为硬上限并标注", () => {
		expect(truncateOutput("短输出")).toBe("短输出");
		const long = "x".repeat(SUBAGENT_OUTPUT_LIMIT + 10);
		const cut = truncateOutput(long);
		expect(cut.length).toBeLessThanOrEqual(SUBAGENT_OUTPUT_LIMIT);
		expect(cut.startsWith(long.slice(0, SUBAGENT_OUTPUT_LIMIT - 60))).toBe(true);
		expect(cut).toContain("已截断");
		expect(cut).toContain(String(long.length));
		expect(truncateOutput("abc", 3)).toBe("abc");
	});
});

describe("resolvePiInvocation", () => {
	test("脚本可用：node <script> <args>", () => {
		const inv = resolvePiInvocation(["-p", "x"], {
			execPath: "/usr/bin/node",
			currentScript: "/repo/packages/coding-agent/src/cli.ts",
			exists: () => true,
		});
		expect(inv).toEqual({ command: "/usr/bin/node", args: ["/repo/packages/coding-agent/src/cli.ts", "-p", "x"] });
	});

	test("bun 虚拟路径不回退脚本，落到裸运行时分支", () => {
		const inv = resolvePiInvocation(["-p"], {
			execPath: "/opt/homebrew/bin/bun",
			currentScript: "/$bunfs/root/pi",
			exists: () => true,
		});
		expect(inv).toEqual({ command: "pi", args: ["-p"] });
	});

	test("可执行文件本体启动：直接 execPath", () => {
		const inv = resolvePiInvocation(["-p"], {
			execPath: "/usr/local/bin/c-code",
			currentScript: undefined,
			exists: () => false,
		});
		expect(inv).toEqual({ command: "/usr/local/bin/c-code", args: ["-p"] });
	});

	test("裸 node 且脚本不存在：回退 PATH 里的 pi", () => {
		const inv = resolvePiInvocation(["-p"], {
			execPath: "/usr/bin/node",
			currentScript: "/gone/cli.js",
			exists: () => false,
		});
		expect(inv).toEqual({ command: "pi", args: ["-p"] });
	});
});

describe("formatSubagentResult", () => {
	const base: SubagentRunResult = { exitCode: 0, output: "结论", stderr: "", aborted: false, timedOut: false };

	test("正常/异常退出/中止/超时四种文案", () => {
		expect(formatSubagentResult(base)).toBe("结论");
		expect(formatSubagentResult({ ...base, output: "", exitCode: 2, stderr: "boom" })).toContain("exit 2");
		expect(formatSubagentResult({ ...base, output: "", exitCode: 2, stderr: "boom" })).toContain("boom");
		expect(formatSubagentResult({ ...base, aborted: true })).toContain("被中止");
		expect(formatSubagentResult({ ...base, timedOut: true })).toContain("超时");
		expect(formatSubagentResult({ ...base, output: "" })).toContain("无输出");
	});

	test("exit 0 但模型层出错时透出错误而非'无输出'（有输出则以输出为准）", () => {
		const text = formatSubagentResult({ ...base, output: "", error: "模型返回错误" });
		expect(text).toContain("未产出结论");
		expect(text).toContain("模型返回错误");
		expect(formatSubagentResult({ ...base, output: "", error: "限流" })).toContain("限流");
		expect(formatSubagentResult({ ...base, error: "限流" })).toBe("结论");
	});
});

describe("extractSubagentError", () => {
	test("取 stopReason=error 的 errorMessage，正常流返回 undefined", () => {
		const err = JSON.stringify({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "rate limited", content: [] },
		});
		expect(extractSubagentError([err])).toBe("rate limited");
		expect(extractSubagentError([err.replace("rate limited", "")])).toBe("模型返回错误");
		expect(extractSubagentError([JSON.stringify({ type: "turn_start" })])).toBeUndefined();
	});
});

describe("runSubagent", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	interface FakeChild {
		child: ChildProcess;
		signals: string[];
		stdout: EventEmitter;
		stderr: EventEmitter;
		close: (code?: number | null) => void;
		fail: (err: Error) => void;
	}

	function makeChild(): FakeChild {
		const child = new EventEmitter() as unknown as ChildProcess;
		const signals: string[] = [];
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		Object.assign(child, {
			stdout,
			stderr,
			kill: (sig: NodeJS.Signals) => {
				signals.push(String(sig));
				return true;
			},
			killed: false,
		});
		return {
			child,
			signals,
			stdout,
			stderr,
			close: (code = 0) => child.emit("close", code),
			fail: (err: Error) => child.emit("error", err),
		};
	}

	const assistantEnd = (text: string) =>
		`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

	test("正常流程：JSON 事件解析出最终输出，exit 0", async () => {
		const fake = makeChild();
		const p = runSubagent({
			spawn: (() => fake.child) as typeof import("node:child_process").spawn,
			command: "pi",
			args: [],
			cwd: "/tmp",
			env: {},
		});
		fake.stdout.emit("data", Buffer.from(assistantEnd("结论A")));
		fake.close(0);
		const res = await p;
		expect(res.exitCode).toBe(0);
		expect(res.output).toBe("结论A");
		expect(res.aborted).toBe(false);
		expect(res.timedOut).toBe(false);
	});

	test("onProgress 逐轮回调；无尾换行的残留 buffer 也计入", async () => {
		const fake = makeChild();
		const turns: number[] = [];
		const p = runSubagent(
			{
				spawn: (() => fake.child) as typeof import("node:child_process").spawn,
				command: "pi",
				args: [],
				cwd: "/tmp",
				env: {},
				onProgress: (t) => turns.push(t),
			},
		);
		fake.stdout.emit("data", Buffer.from(assistantEnd("第一轮")));
		fake.stdout.emit("data", Buffer.from(assistantEnd("第二轮"))); // 无尾换行
		fake.close(0);
		await p;
		expect(turns).toEqual([1, 2]);
	});

	test("abort：发 SIGTERM 并置 aborted", async () => {
		const fake = makeChild();
		const ac = new AbortController();
		const p = runSubagent(
			{
				spawn: (() => fake.child) as typeof import("node:child_process").spawn,
				command: "pi",
				args: [],
				cwd: "/tmp",
				env: {},
			},
			ac.signal,
		);
		ac.abort();
		fake.close(null);
		const res = await p;
		expect(res.aborted).toBe(true);
		expect(fake.signals).toContain("SIGTERM");
	});

	test("超时后宽限期无条件 SIGKILL（子进程忽略 SIGTERM 也不能逃逸）", async () => {
		vi.useFakeTimers();
		const fake = makeChild();
		const p = runSubagent({
			spawn: (() => fake.child) as typeof import("node:child_process").spawn,
			command: "pi",
			args: [],
			cwd: "/tmp",
			env: {},
			timeoutMs: 100,
		});
		await vi.advanceTimersByTimeAsync(150);
		expect(fake.signals).toEqual(["SIGTERM"]);
		// 关键回归：killed 已为 true（发过 SIGTERM），仍必须补发 SIGKILL
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
		fake.close(null);
		const res = await p;
		expect(res.timedOut).toBe(true);
	});

	test("spawn error 视为 exit 1，stderr 有硬上限", async () => {
		const fake = makeChild();
		const p = runSubagent({
			spawn: (() => fake.child) as typeof import("node:child_process").spawn,
			command: "pi",
			args: [],
			cwd: "/tmp",
			env: {},
		});
		fake.stderr.emit("data", Buffer.from("y".repeat(SUBAGENT_STDERR_LIMIT + 999)));
		fake.fail(new Error("spawn failed"));
		const res = await p;
		expect(res.exitCode).toBe(1);
		expect(res.stderr.length).toBeLessThanOrEqual(SUBAGENT_STDERR_LIMIT);
		expect(res.output).toBe("");
	});
});

describe("profile 常量", () => {
	test("环境变量名稳定（子进程与父进程约定）", () => {
		expect(SUBAGENT_PROFILE_ENV).toBe("C_CODE_SUBAGENT");
	});
});

describe("truncateOutput 额外边界", () => {
	test(SUBAGENT_OUTPUT_LIMIT >= 60 ? "limit 内含标记配额" : "skip", () => {
		// 标记文本计入配额的回归（此前截断后总长反超上限）
		const cut = truncateOutput("x".repeat(SUBAGENT_OUTPUT_LIMIT + 1));
		expect(cut.length).toBeLessThanOrEqual(SUBAGENT_OUTPUT_LIMIT);
	});
});
