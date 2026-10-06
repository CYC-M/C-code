import { afterEach, describe, expect, test, vi } from "vitest";
import { TOTAL_FRAMES } from "./boot-frames.ts";
import cCodeExtension from "./index.ts";

function stubPi() {
	const onCalls: { event: string; handler: (event: unknown, ctx: never) => Promise<unknown> }[] = [];
	const registered: string[] = [];
	const shortcuts: { id: string; handler: (ctx: never) => Promise<void> }[] = [];
	const commands: Record<string, { handler: (args: string, ctx: never) => Promise<void> }> = {};
	const tools: Record<string, { name: string; executionMode?: string; parameters?: unknown }> = {};
	const entries: { customType: string; data: unknown }[] = [];
	let activeTools = ["read", "bash", "edit", "write", "grep"];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: never) => Promise<unknown>) => {
			onCalls.push({ event, handler });
			return () => {};
		},
		registerCommand: (
			name: string,
			opts: { handler: (args: string, ctx: never) => Promise<void> },
		) => {
			registered.push(name);
			commands[name] = opts;
		},
		registerShortcut: (id: string, opts: { handler: (ctx: never) => Promise<void> }) => {
			shortcuts.push({ id, handler: opts.handler });
		},
		registerTool: (tool: { name: string; executionMode?: string; parameters?: unknown }) => {
			tools[tool.name] = tool;
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
	};
	return { pi, onCalls, registered, shortcuts, commands, tools, entries, getTools: () => activeTools };
}

const stubTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

interface HeaderComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

async function mountHeader(reason: "startup" | "resume" | "new" | "fork" | "reload" = "startup", theme: { fg(name: string, text: string): string } = stubTheme) {
	const { pi, onCalls, shortcuts } = stubPi();
	cCodeExtension(pi as never);
	const start = onCalls.find((c) => c.event === "session_start");
	let factory: ((tui: never, theme: never) => HeaderComponent) | undefined;
	const renders: number[] = [];
	await start?.handler({ type: "session_start", reason }, { mode: "tui", ui: { setHeader: (f: typeof factory) => (factory = f) } } as never);
	const component = factory?.({ requestRender: () => renders.push(1) } as never, theme as never);
	return { component: component as HeaderComponent, renders, onCalls, shortcuts };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("cCodeExtension", () => {
	test("注册中文命令 + 订阅 session_start", () => {
		const { pi, onCalls, registered } = stubPi();
		cCodeExtension(pi as never);
		expect(registered).toEqual(["帮助", "模型", "关于", "模式", "加模型"]);
		expect(onCalls.map((c) => c.event)).toContain("session_start");
	});

	test("tui 会话挂像素头，非 tui 不挂", async () => {
		const { pi, onCalls } = stubPi();
		cCodeExtension(pi as never);
		const start = onCalls.find((c) => c.event === "session_start");
		const setHeaders: unknown[] = [];
		await start?.handler({ type: "session_start", reason: "startup" }, { mode: "tui", ui: { setHeader: (f: unknown) => setHeaders.push(f) } } as never);
		expect(setHeaders).toHaveLength(1);

		const setHeaders2: unknown[] = [];
		await start?.handler({ type: "session_start", reason: "startup" }, { mode: "print", ui: { setHeader: (f: unknown) => setHeaders2.push(f) } } as never);
		expect(setHeaders2).toHaveLength(0);
	});

	test(`仅冷启动播动画：resume/new/fork/reload 直接静态终帧，不启 timer`, async () => {
		vi.useFakeTimers();
		const { component, renders } = await mountHeader("resume");
		// 直接是完整 logo，无扫描线推进
		const done = component.render(100).join("\n");
		expect(done).toContain("█");
		expect(done).toContain("C-code");
		await vi.advanceTimersByTimeAsync(70 * TOTAL_FRAMES + 20);
		expect(renders.length).toBe(0);
		component.dispose?.();
	});

	test(`首帧空白，${TOTAL_FRAMES} 帧播完出现 logo + 版本并逐帧重绘`, async () => {
		vi.useFakeTimers();
		const { component, renders } = await mountHeader();
		expect(component.render(100).join("\n")).not.toContain("█");
		await vi.advanceTimersByTimeAsync(70 * TOTAL_FRAMES + 20);
		const done = component.render(100).join("\n");
		expect(done).toContain("█");
		expect(done).toContain("C-code");
		expect(renders.length).toBeGreaterThanOrEqual(TOTAL_FRAMES);
		component.dispose?.();
	});

	test("dispose 后 timer 停止，不再推进", async () => {
		vi.useFakeTimers();
		const { component, renders } = await mountHeader();
		component.render(100);
		await vi.advanceTimersByTimeAsync(70 * 5);
		component.dispose?.();
		const frozen = component.render(100).join("\n");
		const count = renders.length;
		await vi.advanceTimersByTimeAsync(70 * 30);
		expect(component.render(100).join("\n")).toBe(frozen);
		expect(renders.length).toBe(count);
	});

	test("末帧行尾是 bak 式状态行 C-code · 模型 · 模式", async () => {
		vi.useFakeTimers();
		const { component } = await mountHeader();
		await vi.advanceTimersByTimeAsync(70 * TOTAL_FRAMES + 20);
		const lines = component.render(100);
		expect(lines.at(-1)).toBe("  C-code · — · build");
		component.dispose?.();
	});

	test("turn_start 更新模型 id 并触发重绘；模式切换着色", async () => {
		vi.useFakeTimers();
		const colorTheme = { fg: (name: string, text: string) => `<${name}>${text}</>` };
		const { component, renders, onCalls, shortcuts } = await mountHeader("startup", colorTheme);
		const turnStart = onCalls.find((c) => c.event === "turn_start");
		await turnStart?.handler({}, { model: { id: "kimi-k2" } } as never);
		expect(component.render(100).at(-1)).toBe("  C-code · kimi-k2 · <accent>build</>");
		expect(renders).toHaveLength(1);

		const shortcut = shortcuts.find((s) => s.id === "shift+tab");
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: () => {},
				notify: () => {},
				select: async () => "拒绝",
				theme: colorTheme,
				setTheme: () => ({ success: true }),
			},
		};
		await shortcut?.handler(ctx as never); // build→yolo
		expect(component.render(100).at(-1)).toBe("  C-code · kimi-k2 · <error>yolo</>");
		component.dispose?.();
	});

	test("model_select 即时更新模型 id 并重绘（不等下一轮 turn）", async () => {
		vi.useFakeTimers();
		const { component, renders, onCalls } = await mountHeader();
		const modelSelect = onCalls.find((c) => c.event === "model_select");
		await modelSelect?.handler({}, { model: { id: "deepseek-v4" } } as never);
		expect(component.render(100).at(-1)).toBe("  C-code · deepseek-v4 · build");
		expect(renders).toHaveLength(1);
		// 同 id 不重复重绘
		await modelSelect?.handler({}, { model: { id: "deepseek-v4" } } as never);
		expect(renders).toHaveLength(1);
		component.dispose?.();
	});
});

describe("子代理 task 工具", () => {
	test("注册 task 工具，顺序执行，参数上限 20k", () => {
		const { pi, tools } = stubPi();
		cCodeExtension(pi as never);
		expect(Object.keys(tools)).toEqual(["task"]);
		expect(tools.task.executionMode).toBe("sequential");
		expect(tools.task.parameters).toBeDefined();
	});

	test("只读 profile（C_CODE_SUBAGENT=1）下不注册 task，写/shell 硬拒绝，read 放行", async () => {
		vi.stubEnv("C_CODE_SUBAGENT", "1");
		try {
			const { pi, tools, onCalls } = stubPi();
			cCodeExtension(pi as never);
			expect(Object.keys(tools)).toHaveLength(0);
			const call = onCalls.find((c) => c.event === "tool_call")?.handler;
			const ctx = {
				hasUI: true,
				ui: {
					setStatus: () => {},
					notify: () => {},
					select: async () => "允许",
					theme: stubTheme,
					setTheme: () => ({ success: true }),
				},
			};
			expect(await call?.({ toolName: "bash", input: { command: "ls -la" } }, ctx as never)).toEqual(
				expect.objectContaining({ block: true }),
			);
			expect(await call?.({ toolName: "edit", input: {} }, ctx as never)).toEqual(
				expect.objectContaining({ block: true }),
			);
			expect(await call?.({ toolName: "read", input: {} }, ctx as never)).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("非 profile 下 task 三档放行（只读契约）", async () => {
		const { pi, onCalls } = stubPi();
		cCodeExtension(pi as never);
		const call = onCalls.find((c) => c.event === "tool_call")?.handler;
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: () => {},
				notify: () => {},
				select: async () => "拒绝",
				theme: stubTheme,
				setTheme: () => ({ success: true }),
			},
		};
		expect(await call?.({ toolName: "task", input: { prompt: "调研 x" } }, ctx as never)).toBeUndefined();
	});
});

describe("agent 模式切换", () => {
	function stubModeCtx(selectAnswer = "拒绝", themeResult: { success: boolean } = { success: true }) {
		const status: { key: string; text: string | undefined }[] = [];
		const selects: string[] = [];
		const themes: string[] = [];
		const notifies: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus: (key: string, text: string | undefined) => status.push({ key, text }),
				notify: (msg: string, _level: string) => {
					notifies.push(msg);
				},
				select: async (msg: string, _opts: string[]) => {
					selects.push(msg);
					return selectAnswer;
				},
				theme: { fg: (name: string, text: string) => `<${name}>${text}</>` },
				setTheme: (name: string) => {
					themes.push(name);
					return themeResult;
				},
			},
		};
		return { ctx, status, selects, themes, notifies };
	}

	function mountModes() {
		const { pi, shortcuts, commands, onCalls, getTools } = stubPi();
		cCodeExtension(pi as never);
		const toolCalls = onCalls
			.filter((c) => c.event === "tool_call")
			.map((c) => c.handler);
		return { shortcuts, commands, toolCalls, getTools };
	}

	test("注册 shift+tab 快捷键与 /模式 命令", () => {
		const { shortcuts, commands } = mountModes();
		expect(shortcuts.map((s) => s.id)).toContain("shift+tab");
		expect(Object.keys(commands)).toContain("模式");
	});

	test("shift+tab 按 plan→build→yolo 循环並三色 setStatus（默认 build 起）", async () => {
		const { shortcuts } = mountModes();
		const shortcut = shortcuts.find((s) => s.id === "shift+tab");
		const { ctx, status } = stubModeCtx();
		await shortcut?.handler(ctx as never);
		expect(status.at(-1)?.text).toContain("yolo");
		expect(status.at(-1)?.text).toContain("<error>");
		await shortcut?.handler(ctx as never);
		expect(status.at(-1)?.text).toContain("plan");
		expect(status.at(-1)?.text).toContain("<warning>");
		await shortcut?.handler(ctx as never);
		expect(status.at(-1)?.text).toContain("build");
		expect(status.at(-1)?.text).toContain("<accent>");
	});

	test("plan 下 edit 工具被拿掉", async () => {
		const { shortcuts, getTools } = mountModes();
		const shortcut = shortcuts.find((s) => s.id === "shift+tab");
		const { ctx } = stubModeCtx();
		await shortcut?.handler(ctx as never); // build→yolo
		await shortcut?.handler(ctx as never); // yolo→plan
		expect(getTools()).not.toContain("edit");
		expect(getTools()).not.toContain("write");
	});

	test("build 下 edit 弹确认：选拒绝阻断，选允许放行", async () => {
		const { toolCalls } = mountModes();
		const call = toolCalls[0];
		const noCtx = stubModeCtx("拒绝");
		expect(await call({ toolName: "edit", input: {} }, noCtx.ctx as never)).toEqual(
			expect.objectContaining({ block: true }),
		);
		expect(noCtx.selects).toHaveLength(1);
		const yesCtx = stubModeCtx("允许");
		expect(await call({ toolName: "edit", input: {} }, yesCtx.ctx as never)).toBeUndefined();
	});

	test("headless（hasUI=false）build 下 edit 直接拒绝，不弹确认框", async () => {
		const { toolCalls } = mountModes();
		const ctx = {
			hasUI: false,
			ui: {
				select: async () => {
					throw new Error("headless 不应弹确认框");
				},
				notify: () => {},
			},
		};
		const result = await toolCalls[0]({ toolName: "edit", input: {} }, ctx as never);
		expect(result).toEqual(expect.objectContaining({ block: true }));
		expect(JSON.stringify(result)).toContain("yolo");
	});

	test("plan 下 shell 逐条确认（只读承诺覆盖 shell）", async () => {
		const { shortcuts, toolCalls } = mountModes();
		const shortcut = shortcuts.find((s) => s.id === "shift+tab");
		// build→yolo→plan
		const denyCtx = stubModeCtx("拒绝");
		await shortcut?.handler(denyCtx.ctx as never);
		await shortcut?.handler(denyCtx.ctx as never);
		// plan + 普通 bash：弹确认，拒绝即阻断
		const blocked = await toolCalls[0]({ toolName: "bash", input: { command: "ls" } }, denyCtx.ctx as never);
		expect(blocked).toEqual(expect.objectContaining({ block: true }));
		expect(denyCtx.selects).toHaveLength(1);
		// 选允许则放行
		const allowCtx = stubModeCtx("允许");
		await shortcut?.handler(allowCtx.ctx as never); // plan→build
		await shortcut?.handler(allowCtx.ctx as never); // build→yolo
		await shortcut?.handler(allowCtx.ctx as never); // yolo→plan
		expect(await toolCalls[0]({ toolName: "bash", input: { command: "ls" } }, allowCtx.ctx as never)).toBeUndefined();
		expect(allowCtx.selects).toHaveLength(1);
	});

	test("切到 yolo 后 edit 不再确认直接放行", async () => {
		const { shortcuts, toolCalls } = mountModes();
		const shortcut = shortcuts.find((s) => s.id === "shift+tab");
		const { ctx, selects } = stubModeCtx();
		await shortcut?.handler(ctx as never); // build→yolo
		expect(await toolCalls[0]({ toolName: "edit", input: {} }, ctx as never)).toBeUndefined();
		expect(selects).toHaveLength(0);
	});

	test("/模式 yolo 直接切换", async () => {
		const { commands, toolCalls } = mountModes();
		const { ctx, status } = stubModeCtx();
		await commands["模式"].handler("yolo", ctx as never);
		expect(status.at(-1)?.text).toContain("yolo");
		expect(await toolCalls[0]({ toolName: "write", input: {} }, ctx as never)).toBeUndefined();
	});

	test("切换模式同步切主题（plan黄/build绿/yolo红）", async () => {
		const { shortcuts } = mountModes();
		const shortcut = shortcuts.find((s) => s.id === "shift+tab");
		const { ctx, themes } = stubModeCtx();
		await shortcut?.handler(ctx as never); // build→yolo
		await shortcut?.handler(ctx as never); // yolo→plan
		expect(themes).toEqual(["c-code-red", "c-code-yellow"]);
	});

	test("主题切换失败时提示但不中断", async () => {
		const { shortcuts } = mountModes();
		const shortcut = shortcuts.find((s) => s.id === "shift+tab");
		const { ctx, notifies, status } = stubModeCtx("拒绝", { success: false });
		await shortcut?.handler(ctx as never);
		expect(notifies.some((m) => m.includes("主题"))).toBe(true);
		expect(status.at(-1)?.text).toContain("yolo");
	});

	test("plan→build 状态用新主题着色，不残留黄主题 accent（fixes build 变黄）", async () => {
		const { pi, shortcuts } = stubPi();
		cCodeExtension(pi as never);
		const shortcut = shortcuts.find((s) => s.id === "shift+tab");
		const themes: Record<string, { fg: (name: string, text: string) => string }> = {
			"c-code-green": { fg: (name: string, text: string) => `<green:${name}>${text}</>` },
			"c-code-yellow": { fg: (name: string, text: string) => `<yellow:${name}>${text}</>` },
			"c-code-red": { fg: (name: string, text: string) => `<red:${name}>${text}</>` },
		};
		const status: { key: string; text: string | undefined }[] = [];
		const ui = {
			setStatus: (key: string, text: string | undefined) => status.push({ key, text }),
			notify: () => {},
			select: async () => "拒绝",
			theme: themes["c-code-green"]!,
			setTheme: (name: string) => {
				ui.theme = themes[name]!;
				return { success: true };
			},
		};
		const ctx = { hasUI: true, ui };
		await shortcut?.handler(ctx as never); // build→yolo（red）
		await shortcut?.handler(ctx as never); // yolo→plan（yellow）
		await shortcut?.handler(ctx as never); // plan→build（green）
		expect(status.at(-1)?.text).toContain("build");
		expect(status.at(-1)?.text).toContain("<green:accent>");
	});

	test("session_start 静默套用默认 build 主题（fixes 启动颜色错乱）", async () => {
		const { pi, onCalls } = stubPi();
		cCodeExtension(pi as never);
		const start = onCalls.find((c) => c.event === "session_start");
		const { ctx, themes, notifies, status } = stubModeCtx();
		const ui = { ...ctx.ui, setHeader: () => {} };
		await start?.handler({}, { mode: "tui", model: { id: "m" }, hasUI: true, ui } as never);
		expect(themes).toEqual(["c-code-green"]);
		expect(notifies.some((m) => m.includes("已切换"))).toBe(false);
		expect(status.at(-1)?.text).toContain("build");
	});
});
