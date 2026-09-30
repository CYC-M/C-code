/**
 * /加模型 向导：纯函数（构建/校验/合并，可单测）+ 可注入 IO 的流程。
 * Key 支持 $VAR 引用，不存明文；写入前备份 models.json.bak。
 */

export const SUPPORTED_APIS = [
	"openai-completions",
	"anthropic-messages",
	"openai-responses",
	"google-generative-ai",
] as const;

export type ModelApi = (typeof SUPPORTED_APIS)[number] | (string & {});

export interface CustomProviderInput {
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	modelIds: string[];
}

export interface ProviderEntry {
	api: string;
	baseUrl: string;
	apiKey: string;
	models: { id: string }[];
}

export interface ModelsJson {
	providers: Record<string, ProviderEntry>;
}

export function validateProviderInput(input: CustomProviderInput): string[] {
	const errors: string[] = [];
	if (!input.name.trim() || /\s/.test(input.name.trim())) errors.push("名称不能为空且不能含空格");
	if (!/^https?:\/\/.+/.test(input.baseUrl.trim())) errors.push("地址必须以 http(s):// 开头");
	if (!(SUPPORTED_APIS as readonly string[]).includes(input.api)) {
		errors.push(`协议仅支持：${SUPPORTED_APIS.join(" / ")}`);
	}
	if (!input.apiKey.trim()) errors.push("Key 不能为空（可用 $VAR 引用环境变量）");
	if (input.modelIds.length === 0) errors.push("模型 id 至少填一个");
	return errors;
}

export function buildProviderEntry(input: CustomProviderInput): ProviderEntry {
	return {
		api: input.api,
		apiKey: input.apiKey.trim(),
		baseUrl: input.baseUrl.trim(),
		models: input.modelIds.map((id) => ({ id: id.trim() })).filter((m) => m.id),
	};
}

/** 合并：整商替换，同名模型覆盖，不同名旧模型保留。 */
export function mergeProviderInto(existing: ModelsJson, name: string, entry: ProviderEntry): ModelsJson {
	const prev = existing.providers[name];
	const prevModels = prev?.models ?? [];
	const incomingIds = new Set(entry.models.map((m) => m.id));
	return {
		providers: {
			...existing.providers,
			[name]: { ...entry, models: [...prevModels.filter((m) => !incomingIds.has(m.id)), ...entry.models] },
		},
	};
}

export interface AddModelUI {
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level?: string): void;
}

export interface AddModelFS {
	readFile(path: string): string;
	writeFile(path: string, content: string): void;
	copyFile(src: string, dst: string): void;
}

export interface AddModelDeps {
	ui: AddModelUI;
	fs: AddModelFS;
	agentDir: string;
}

export async function runAddModelFlow(deps: AddModelDeps): Promise<void> {
	const { ui, fs, agentDir } = deps;
	const modelsPath = `${agentDir}/models.json`;

	const name = (await ui.input("模型商名称（英文小写，如 myapi）"))?.trim();
	if (!name) return;
	const baseUrl = (await ui.input("接口地址（含 /v1，如 https://api.example.com/v1）"))?.trim();
	if (!baseUrl) return;
	const api = await ui.select("协议", [...SUPPORTED_APIS]);
	if (!api) return;
	const apiKey = (await ui.input("API Key（可用 $VAR 引用环境变量，不存明文）"))?.trim();
	if (!apiKey) return;
	const idsRaw = (await ui.input("模型 id（多个用逗号分隔）"))?.trim();
	if (!idsRaw) return;
	const modelIds = idsRaw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id);

	const input: CustomProviderInput = { name, baseUrl, api, apiKey, modelIds };
	const errors = validateProviderInput(input);
	if (errors.length > 0) {
		ui.notify(`加模型失败：\n${errors.join("\n")}`, "warning");
		return;
	}

	const entry = buildProviderEntry(input);
	const preview = [
		"即将写入：",
		`商：${name}（${api}）`,
		`地址：${entry.baseUrl}`,
		`模型：${entry.models.map((m) => m.id).join(", ")}`,
	].join("\n");
	const confirm = await ui.select(preview, ["确认写入", "取消"]);
	if (confirm !== "确认写入") return;

	let existing: ModelsJson = { providers: {} };
	try {
		existing = JSON.parse(fs.readFile(modelsPath)) as ModelsJson;
		if (!existing.providers) existing = { providers: {} };
	} catch {
		// 文件不存在就新建
	}
	try {
		fs.copyFile(modelsPath, `${modelsPath}.bak`);
	} catch {
		// 无旧文件可备，忽略
	}
	fs.writeFile(modelsPath, `${JSON.stringify(mergeProviderInto(existing, name, entry), null, 2)}\n`);
	ui.notify(`已加入 ${entry.models.length} 个模型。开 /model 即见（自动重载，无需重启）。`, "info");
}
