import { afterEach, describe, expect, test, vi } from "vitest";
import { TOTAL_FRAMES } from "./boot-frames.ts";
import cCodeExtension from "./index.ts";

function stubPi() {
	const onCalls: { event: string; handler: (event: unknown, ctx: never) => Promise<unknown> }[] = [];
	const registered: string[] = [];
	const shortcuts: { id: string; handler: (ctx: never) => Promise<void> }[] = [];
	const commands: Record<string, { handler: (args: string, ctx: never) => Promise<void> }> = {};
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
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
	};
	return { pi, onCalls, registered, shortcuts, commands, getTools: () => activeTools };
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

async function mountHeader() {
	const { pi, onCalls } = stubPi();
	cCodeExtension(pi as never);
	const start = onCalls.find((c) => c.event === "session_start");
	let factory: ((tui: never, theme: never) => HeaderComponent) | undefined;
	const renders: number[] = [];
	await start?.handler({}, { mode: "tui", ui: { setHeader: (f: typeof factory) => (factory = f) } } as never);
	const component = factory?.({ requestRender: () => renders.push(1) } as never, stubTheme as never);
	return { component: component as HeaderComponent, renders };
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
		await start?.handler({}, { mode: "tui", ui: { setHeader: (f: unknown) => setHeaders.push(f) } } as never);
		expect(setHeaders).toHaveLength(1);

		const setHeaders2: unknown[] = [];
		await start?.handler({}, { mode: "print", ui: { setHeader: (f: unknown) => setHeaders2.push(f) } } as never);
		expect(setHeaders2).toHaveLength(0);
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
});
