/**
 * /加模型 向导：纯函数（构建/校验/合并，可单测）+ 可注入 IO 的流程。
 * Key 支持 $VAR 引用（与宿主 resolve-config-value 语法一致），不存明文；
 * 写入前备份 models.json.bak，备份失败/解析失败一律中止，绝不静默覆盖。
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

/** "$VAR" / "${VAR}" 引用（与宿主 resolve-config-value 的变量名规则一致）。 */
const ENV_REF_RE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

/** 提取 "$VAR" / "${VAR}" 形式的环境变量名；非纯引用返回 undefined。 */
export function matchEnvRef(key: string): string | undefined {
	const m = ENV_REF_RE.exec(key.trim());
	return m?.[1] ?? m?.[2];
}

export function validateProviderInput(input: CustomProviderInput): string[] {
	const errors: string[] = [];
	if (!input.name.trim() || /\s/.test(input.name.trim())) {
		errors.push("名称不能为空且不能含空格");
	} else if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.name.trim())) {
		errors.push("名称仅支持小写英文/数字，可用 - 或 _ 分隔");
	}
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
	/** 环境变量读取（默认 process.env），用于 $VAR 引用的存在性预警。 */
	env?: (name: string) => string | undefined;
}

export async function runAddModelFlow(deps: AddModelDeps): Promise<void> {
	const { ui, fs, agentDir } = deps;
	const getEnv = deps.env ?? ((name: string) => process.env[name]);
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
	// 写入前预警，避免配置落盘后才发现失效/裸奔
	const envRef = matchEnvRef(entry.apiKey);
	if (envRef && !getEnv(envRef)) {
		ui.notify(`警告：环境变量 ${envRef} 当前不存在，该 Key 运行时会解析失败`, "warning");
	}
	const insecure = /^http:\/\//.test(entry.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(entry.baseUrl);
	const keyNote = envRef
		? `Key：${entry.apiKey}（运行时解析环境变量）`
		: "Key：将以【明文】存入 models.json（建议改用 $ENV_NAME 引用环境变量）";
	const preview = [
		"即将写入：",
		`商：${name}（${api}）`,
		`地址：${entry.baseUrl}${insecure ? "（明文 HTTP，Key 将未加密传输）" : ""}`,
		keyNote,
		`模型：${entry.models.map((m) => m.id).join(", ")}`,
	].join("\n");
	const confirm = await ui.select(preview, ["确认写入", "取消"]);
	if (confirm !== "确认写入") return;

	let existing: ModelsJson = { providers: {} };
	try {
		existing = JSON.parse(fs.readFile(modelsPath)) as ModelsJson;
	} catch (err) {
		// 解析失败 ≠ 文件不存在：中止写入，绝不静默覆盖用户手改的配置
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			ui.notify(`models.json 解析失败，已中止写入（原件未动）：${(err as Error).message}`, "error");
			return;
		}
	}
	if (typeof existing.providers !== "object" || existing.providers === null || Array.isArray(existing.providers)) {
		existing = { providers: {} };
	}
	try {
		fs.copyFile(modelsPath, `${modelsPath}.bak`);
	} catch (err) {
		// 无旧文件（ENOENT）属正常；其余备份失败一律中止，不留无备份的覆盖
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			ui.notify(`备份 models.json 失败，已中止写入：${(err as Error).message}`, "error");
			return;
		}
	}
	try {
		fs.writeFile(modelsPath, `${JSON.stringify(mergeProviderInto(existing, name, entry), null, 2)}\n`);
	} catch (err) {
		ui.notify(`写入 models.json 失败：${(err as Error).message}`, "error");
		return;
	}
	ui.notify(`已加入 ${entry.models.length} 个模型。开 /model 即见（自动重载，无需重启）。`, "info");
}
