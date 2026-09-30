import { describe, expect, test } from "vitest";
import { createZhCommands, registerZhCommands } from "./zh-commands.ts";

const CJK = /[\u4e00-\u9fff]/;

function stubCtx() {
	const calls: { notify: string[]; setHeader: unknown[] } = { notify: [], setHeader: [] };
	const ctx = {
		ui: {
			notify: (msg: string, _level: string) => {
				calls.notify.push(msg);
			},
			setHeader: (factory: unknown) => {
				calls.setHeader.push(factory);
			},
		},
	};
	return { ctx, calls };
}

describe("createZhCommands", () => {
	test("三个中文命令：帮助/模型/关于，描述为中文", () => {
		const cmds = createZhCommands("0.87.1");
		expect(cmds.map((c) => c.name)).toEqual(["帮助", "模型", "关于"]);
		for (const cmd of cmds) {
			expect(cmd.description).toMatch(CJK);
		}
	});

	test("/帮助 输出中文速查（含其他命令）", async () => {
		const cmds = createZhCommands("0.87.1");
		const help = cmds.find((c) => c.name === "帮助");
		const { ctx, calls } = stubCtx();
		await help?.handler("", ctx as never);
		expect(calls.notify).toHaveLength(1);
		expect(calls.notify[0]).toContain("/模型");
		expect(calls.notify[0]).toContain("/模式");
		expect(calls.notify[0]).toContain("/加模型");
		expect(calls.notify[0]).toContain("/关于");
		expect(calls.notify[0]).not.toContain("/恢复页眉");
	});

	test("/关于 输出版本号且不提 pi", async () => {
		const cmds = createZhCommands("0.87.1");
		const about = cmds.find((c) => c.name === "关于");
		const { ctx, calls } = stubCtx();
		await about?.handler("", ctx as never);
		expect(calls.notify[0]).toContain("0.87.1");
		expect(calls.notify[0]).toMatch(CJK);
		expect(calls.notify[0]).not.toContain("pi v");
	});
});

describe("registerZhCommands", () => {
	test("逐个注册到 pi", () => {
		const registered: string[] = [];
		const pi = {
			registerCommand: (name: string, _opts: unknown) => {
				registered.push(name);
			},
		};
		registerZhCommands(pi as never, "0.87.1");
		expect(registered).toEqual(["帮助", "模型", "关于"]);
	});
});
