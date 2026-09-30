import { describe, expect, test } from "vitest";
import {
	buildProviderEntry,
	mergeProviderInto,
	runAddModelFlow,
	validateProviderInput,
	type AddModelDeps,
} from "./model-entry.ts";

describe("validateProviderInput", () => {
	test("合法输入零错误", () => {
		expect(
			validateProviderInput({
				name: "myapi",
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				apiKey: "$MY_KEY",
				modelIds: ["m1", "m2"],
			}),
		).toEqual([]);
	});

	test("空名/坏地址/空模型逐条报错", () => {
		const errors = validateProviderInput({
			name: "  ",
			baseUrl: "not-a-url",
			api: "openai-completions",
			apiKey: "k",
			modelIds: [],
		});
		expect(errors.length).toBeGreaterThanOrEqual(3);
		expect(errors.join("\n")).toMatch(/名称|地址|模型/);
	});

	test("不支持的协议报错", () => {
		const errors = validateProviderInput({
			name: "x",
			baseUrl: "https://api.example.com/v1",
			api: "weird-protocol",
			apiKey: "k",
			modelIds: ["m"],
		});
		expect(errors.join("\n")).toMatch(/协议/);
	});
});

describe("buildProviderEntry + mergeProviderInto", () => {
	test("构建 provider 条目", () => {
		expect(
			buildProviderEntry({
				name: "myapi",
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				apiKey: "$MY_KEY",
				modelIds: ["m1", "m2"],
			}),
		).toEqual({
			api: "openai-completions",
			apiKey: "$MY_KEY",
			baseUrl: "https://api.example.com/v1",
			models: [{ id: "m1" }, { id: "m2" }],
		});
	});

	test("合并：新商追加，同名模型覆盖，同商保留旧模型", () => {
		const existing = {
			providers: {
				myapi: {
					api: "openai-completions",
					apiKey: "old",
					baseUrl: "https://old.example/v1",
					models: [{ id: "m1" }, { id: "keep" }],
				},
			},
		};
		const merged = mergeProviderInto(
			existing,
			"myapi",
			buildProviderEntry({
				name: "myapi",
				baseUrl: "https://new.example/v1",
				api: "openai-completions",
				apiKey: "new",
				modelIds: ["m1", "m2"],
			}),
		);
		expect(merged.providers.myapi.baseUrl).toBe("https://new.example/v1");
		expect(merged.providers.myapi.models.map((m) => m.id).sort()).toEqual(["keep", "m1", "m2"]);
	});
});

describe("runAddModelFlow", () => {
	function stubDeps(answers: (string | undefined)[], files: Record<string, string> = {}): {
		deps: AddModelDeps;
		written: Record<string, string>;
		notifies: string[];
	} {
		const written: Record<string, string> = {};
		const notifies: string[] = [];
		let i = 0;
		const deps: AddModelDeps = {
			ui: {
				input: async () => answers[i++],
				select: async () => answers[i++],
				notify: (msg: string) => {
					notifies.push(msg);
				},
			},
			fs: {
				readFile: (p: string) => {
					if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
					return files[p];
				},
				writeFile: (p: string, content: string) => {
					written[p] = content;
				},
				copyFile: (src: string, dst: string) => {
					written[dst] = files[src] ?? "";
				},
			},
			agentDir: "/tmp/c-code-test-agent",
		};
		return { deps, written, notifies };
	}

	test("完整向导写入 models.json 并备份", async () => {
		const { deps, written, notifies } = stubDeps(
			["myapi", "https://api.example.com/v1", "openai-completions", "$MY_KEY", "m1,m2", "确认写入"],
			{ "/tmp/c-code-test-agent/models.json": JSON.stringify({ providers: {} }) },
		);
		await runAddModelFlow(deps);
		const saved = JSON.parse(written["/tmp/c-code-test-agent/models.json"]);
		expect(saved.providers.myapi.models.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
		expect("/tmp/c-code-test-agent/models.json.bak" in written).toBe(true);
		expect(notifies.join("\n")).toContain("已加入 2 个模型");
	});

	test("中途取消不写文件", async () => {
		const { deps, written } = stubDeps([undefined], {
			"/tmp/c-code-test-agent/models.json": JSON.stringify({ providers: {} }),
		});
		await runAddModelFlow(deps);
		expect(Object.keys(written)).toHaveLength(0);
	});

	test("非法输入报错不写文件", async () => {
		const { deps, written, notifies } = stubDeps(["myapi", "not-a-url", "openai-completions", "k", "m", "确认写入"], {
			"/tmp/c-code-test-agent/models.json": JSON.stringify({ providers: {} }),
		});
		await runAddModelFlow(deps);
		expect(Object.keys(written)).toHaveLength(0);
		expect(notifies.join("\n")).toMatch(/地址/);
	});
});
