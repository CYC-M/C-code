import { describe, expect, test } from "vitest";
import {
	buildProviderEntry,
	matchEnvRef,
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

describe("matchEnvRef", () => {
	test("识别 $VAR 与 ${VAR}，非引用返回 undefined", () => {
		expect(matchEnvRef("$MY_KEY")).toBe("MY_KEY");
		expect(matchEnvRef(" ${MY_KEY} ")).toBe("MY_KEY");
		expect(matchEnvRef("sk-plain")).toBeUndefined();
		expect(matchEnvRef("$1BAD")).toBeUndefined();
		expect(matchEnvRef("")).toBeUndefined();
	});
});

describe("runAddModelFlow", () => {
	function stubDeps(
		answers: (string | undefined)[],
		files: Record<string, string> = {},
		opts: { fs?: Partial<AddModelDeps["fs"]>; env?: (name: string) => string | undefined } = {},
	): {
		deps: AddModelDeps;
		written: Record<string, string>;
		notifies: string[];
		selects: string[];
	} {
		const written: Record<string, string> = {};
		const notifies: string[] = [];
		const selects: string[] = [];
		let i = 0;
		const deps: AddModelDeps = {
			ui: {
				input: async () => answers[i++],
				select: async (title: string) => {
					selects.push(title);
					return answers[i++];
				},
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
				...opts.fs,
			},
			agentDir: "/tmp/c-code-test-agent",
			env: opts.env,
		};
		return { deps, written, notifies, selects };
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

	test("名称含大写/特殊字符报错（对齐向导提示的命名规范）", async () => {
		const errors = validateProviderInput({
			name: "My API!",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			apiKey: "k",
			modelIds: ["m"],
		});
		expect(errors.join("\n")).toMatch(/名称/);
	});

	test("models.json 解析失败时中止且不写任何文件（原件未动）", async () => {
		const { deps, written, notifies } = stubDeps(
			["myapi", "https://api.example.com/v1", "openai-completions", "$MY_KEY", "m1", "确认写入"],
			{ "/tmp/c-code-test-agent/models.json": "{ corrupted" },
		);
		await runAddModelFlow(deps);
		expect(Object.keys(written)).toHaveLength(0);
		expect(notifies.join("\n")).toContain("解析失败");
		expect(notifies.join("\n")).toContain("原件未动");
	});

	test("providers 形状异常（数组）时按空配置处理，不崩溃", async () => {
		const { deps, written } = stubDeps(
			["myapi", "https://api.example.com/v1", "openai-completions", "$MY_KEY", "m1", "确认写入"],
			{ "/tmp/c-code-test-agent/models.json": JSON.stringify({ providers: [] }) },
		);
		await runAddModelFlow(deps);
		const saved = JSON.parse(written["/tmp/c-code-test-agent/models.json"]);
		expect(Array.isArray(saved.providers)).toBe(false);
		expect(saved.providers.myapi.models.map((m: { id: string }) => m.id)).toEqual(["m1"]);
	});

	test("备份失败中止写入，不动原件", async () => {
		const { deps, written, notifies } = stubDeps(
			["myapi", "https://api.example.com/v1", "openai-completions", "$MY_KEY", "m1", "确认写入"],
			{ "/tmp/c-code-test-agent/models.json": JSON.stringify({ providers: {} }) },
			{ fs: { copyFile: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } } },
		);
		await runAddModelFlow(deps);
		expect(written["/tmp/c-code-test-agent/models.json"]).toBeUndefined();
		expect(notifies.join("\n")).toContain("备份");
	});

	test("写盘失败时提示错误而非静默丢弃", async () => {
		const { deps, notifies } = stubDeps(
			["myapi", "https://api.example.com/v1", "openai-completions", "$MY_KEY", "m1", "确认写入"],
			{ "/tmp/c-code-test-agent/models.json": JSON.stringify({ providers: {} }) },
			{ fs: { writeFile: () => { throw new Error("ENOSPC: no space left on device"); } } },
		);
		await runAddModelFlow(deps);
		expect(notifies.join("\n")).toContain("写入 models.json 失败");
		expect(notifies.join("\n")).toContain("ENOSPC");
	});

	test("明文 Key 确认页警示；$VAR 引用缺失环境变量预警", async () => {
		const plain = stubDeps(
			["myapi", "https://api.example.com/v1", "openai-completions", "sk-plain-key", "m1", "确认写入"],
			{ "/tmp/c-code-test-agent/models.json": JSON.stringify({ providers: {} }) },
		);
		await runAddModelFlow(plain.deps);
		expect(plain.selects.join("\n")).toContain("明文");
		expect(plain.notifies.join("\n")).not.toContain("不存在");

		const ghost = stubDeps(
			["myapi", "https://api.example.com/v1", "openai-completions", "$GHOST_KEY", "m1", "确认写入"],
			{ "/tmp/c-code-test-agent/models.json": JSON.stringify({ providers: {} }) },
			{ env: () => undefined },
		);
		await runAddModelFlow(ghost.deps);
		expect(ghost.notifies.join("\n")).toContain("GHOST_KEY");
		expect(ghost.notifies.join("\n")).toContain("不存在");
	});
});
