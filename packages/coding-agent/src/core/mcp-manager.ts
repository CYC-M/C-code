/**
 * Core MCP manager.
 *
 * Once-configure design: global `extensions/mcp.json` is the single source
 * (trusted project file only overrides same-name servers), secrets resolve
 * from env first then `auth.json`, and connections self-heal with timeout,
 * retry, and heartbeat. Reads `mcp.json` (explicit `C_CODE_MCP_CONFIG`
 * override, otherwise merged global + trusted project; falls back to the
 * built-in Originkit default), registers each MCP tool as
 * `mcp_<server>_<tool>`, and exposes a snapshot for the sidebar.
 *
 * Secrets: header values support `{env:VAR}` interpolation. Resolved values
 * are never logged, notified, or thrown; only the variable name is mentioned.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import type { ToolDefinition } from "./extensions/index.ts";

export const MCP_MANAGER_VERSION = "0.1.0";
export const MCP_ORIGINKIT_URL = "https://mcp.originkit.dev/mcp";
export const MCP_CONFIG_ENV = "C_CODE_MCP_CONFIG";
export const MCP_MAX_TEXT = 12000;
export const MCP_CONNECT_TIMEOUT_MS = 15000;
export const MCP_CONNECT_RETRIES = 2;
export const MCP_HEARTBEAT_MS = 60000;

/** Race a promise against a timeout (timer unrefed so tests/CLI can exit). */
export function withMcpTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
		if (typeof timer === "object" && typeof (timer as { unref?: unknown }).unref === "function") {
			(timer as unknown as { unref: () => void }).unref();
		}
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (typeof timer === "object" && typeof (timer as { unref?: unknown }).unref === "function") {
			(timer as unknown as { unref: () => void }).unref();
		}
	});
}

export interface McpRemoteServerConfig {
	type: "remote";
	url: string;
	headers?: Record<string, string>;
}

export interface McpStdioServerConfig {
	type: "local";
	command: string[];
	env?: Record<string, string>;
}

export type McpServerConfig = McpRemoteServerConfig | McpStdioServerConfig;

export interface McpFileConfig {
	servers?: Record<string, McpServerConfig>;
}

export type McpServerState = "connecting" | "ok" | "err" | "off";

export interface McpServerStatus {
	name: string;
	state: McpServerState;
	toolCount: number;
	error?: string;
}

export interface McpSnapshot {
	servers: McpServerStatus[];
	/** Config-level failure (unreadable mcp.json). Shown instead of servers. */
	error?: string;
}

export interface McpManagerEvents {
	/** Called with the full rebuilt tool list after (re)connects. */
	onToolsChanged: (tools: ToolDefinition[]) => void;
	/** Called on every state transition (sidebar/footer refresh). */
	onStateChanged: () => void;
}

interface ListedMcpTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

interface ServerRuntime {
	config: McpServerConfig;
	client?: Client;
	transport?: StreamableHTTPClientTransport;
	state: McpServerState;
	toolCount: number;
	error?: string;
	defs: ToolDefinition[];
}

/** Auth.json path for persistent MCP keys (once-configure, survives shell restarts). */
export function getMcpAuthPath(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "auth.json");
}

/** `ORIGINKIT_API_KEY` -> `mcp-originkit`, `MY_SERVICE_TOKEN` -> `mcp-my-service`. */
export function mcpEnvVarToProviderId(envVar: string): string {
	const stripped = envVar.replace(/_(API_KEY|TOKEN|KEY)$/, "");
	const slug = stripped
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `mcp-${slug || "key"}`;
}

/** Sync read of one MCP key from auth.json (no throw, returns undefined when absent). */
export function readMcpAuthValue(name: string, agentDir?: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(getMcpAuthPath(agentDir), "utf-8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const data = parsed as Record<string, unknown>;
	const service = name.replace(/_(API_KEY|TOKEN|KEY)$/, "").toLowerCase();
	const candidates: string[] = [];
	for (const key of [name, name.toLowerCase(), mcpEnvVarToProviderId(name), service]) {
		if (!candidates.includes(key)) candidates.push(key);
	}
	for (const key of candidates) {
		const entry = data[key];
		if (typeof entry === "string") {
			if (entry !== "") return entry;
			continue;
		}
		if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
			const cred = entry as Record<string, unknown>;
			if (cred.type === "api_key" && typeof cred.key === "string" && cred.key !== "") return cred.key;
		}
	}
	return undefined;
}

/** Env first, auth.json fallback. Empty string counts as missing. */
export function resolveMcpEnvValue(name: string, agentDir?: string): string | undefined {
	const fromEnv = process.env[name];
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	return readMcpAuthValue(name, agentDir);
}

/** Persist one MCP key to auth.json (mode 600). Returns the provider id used. */
export function persistMcpEnvValue(name: string, value: string, agentDir?: string): string {
	const authPath = getMcpAuthPath(agentDir);
	const providerId = mcpEnvVarToProviderId(name);
	let data: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			data = parsed as Record<string, unknown>;
		}
	} catch {
		// Missing or corrupt file starts fresh (never throws for a key save).
	}
	mkdirSync(join(authPath, ".."), { recursive: true, mode: 0o700 });
	data[providerId] = { type: "api_key", key: value };
	writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	return providerId;
}

/** Copy live env keys into auth.json when auth has no value yet (best-effort). */
export function migrateEnvKeysToAuth(servers: Record<string, McpServerConfig>, agentDir?: string): string[] {
	const migrated: string[] = [];
	const seen = new Set<string>();
	const collect = (value: string): void => {
		for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
			const varName = match[1];
			if (varName === undefined || seen.has(varName)) continue;
			seen.add(varName);
			try {
				const live = process.env[varName];
				if (live === undefined || live === "") continue;
				if (readMcpAuthValue(varName, agentDir) !== undefined) continue;
				persistMcpEnvValue(varName, live, agentDir);
				migrated.push(varName);
			} catch {
				// Best-effort migration never breaks connects.
			}
		}
	};
	for (const server of Object.values(servers)) {
		if (server.type === "remote") {
			collect(server.url);
			for (const header of Object.values(server.headers ?? {})) collect(header);
		}
	}
	return migrated;
}

/** Replace `{env:VAR}` with env value, falling back to auth.json (empty string when unset). */
export function interpolateEnv(value: string, agentDir?: string): string {
	return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		return resolveMcpEnvValue(name, agentDir) ?? "";
	});
}

/** Name the first `{env:VAR}` whose variable is missing from both env and auth.json, if any. */
export function missingEnvName(value: string, agentDir?: string): string | undefined {
	for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
		const name = match[1];
		if (name === undefined) continue;
		const current = resolveMcpEnvValue(name, agentDir);
		if (current === undefined || current === "") return name;
	}
	return undefined;
}

/** `mcp_<server>_<tool>`, lowercase alnum/underscore, max 64 chars. */
export function normalizeMcpToolName(server: string, tool: string): string {
	const clean = (part: string): string =>
		part
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, "_")
			.replace(/_+/g, "_")
			.replace(/^_+|_+$/g, "");
	const name = `mcp_${clean(server)}_${clean(tool)}`;
	if (name === "mcp__") return "mcp_tool";
	return name.slice(0, 64);
}

function textOption(schema: Record<string, unknown>): { description?: string; default?: unknown } {
	const options: { description?: string; default?: unknown } = {};
	if (typeof schema.description === "string") options.description = schema.description;
	if (schema.default !== undefined) options.default = schema.default;
	return options;
}

/**
 * Convert a JSON Schema fragment to TypeBox. Covers the subset MCP servers
 * (including Originkit) use: objects, strings, numbers, integers, booleans,
 * arrays, enums, null, and `type: [...]` unions. Anything else degrades to
 * `Type.Unknown()` rather than failing the whole tool registration.
 */
export function jsonSchemaToTypeBox(schema: unknown): TSchema {
	if (typeof schema !== "object" || schema === null) return Type.Unknown();
	const node = schema as Record<string, unknown>;

	if (Array.isArray(node.enum)) {
		const literals: Array<ReturnType<typeof Type.Literal>> = [];
		for (const value of node.enum) {
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				literals.push(Type.Literal(value));
			}
		}
		if (literals.length === 0) return Type.Unknown();
		if (literals.length === 1) return literals[0];
		return Type.Union(literals);
	}

	const rawType = node.type;
	if (Array.isArray(rawType)) {
		const variants: TSchema[] = [];
		for (const item of rawType) {
			variants.push(jsonSchemaToTypeBox({ ...node, type: item }));
		}
		if (variants.length === 0) return Type.Unknown();
		if (variants.length === 1) return variants[0];
		return Type.Union(variants);
	}

	switch (rawType) {
		case "string":
			return Type.String(textOption(node));
		case "number":
			return Type.Number(textOption(node));
		case "integer":
			return Type.Integer(textOption(node));
		case "boolean":
			return Type.Boolean(textOption(node));
		case "null":
			return Type.Null();
		case "array": {
			const items = jsonSchemaToTypeBox(node.items);
			return Type.Array(items, textOption(node));
		}
		case "object":
		case undefined: {
			const properties = node.properties;
			if (typeof properties !== "object" || properties === null) return Type.Unknown();
			const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
			const out: Record<string, TSchema> = {};
			for (const key of Object.keys(properties)) {
				const inner = jsonSchemaToTypeBox((properties as Record<string, unknown>)[key]);
				out[key] = required.has(key) ? inner : Type.Optional(inner);
			}
			const options = textOption(node);
			if (node.additionalProperties === false) {
				return Type.Object(out, { ...options, additionalProperties: false });
			}
			return Type.Object(out, options);
		}
		default:
			return Type.Unknown();
	}
}

/** Top-level tool schemas must be objects; `registerTool` rejects the rest. */
export function ensureObjectSchema(schema: TSchema): TSchema {
	const kind = (schema as { type?: unknown }).type;
	return kind === "object" ? schema : Type.Object({});
}

/** Flatten MCP content blocks to text; images/audio become placeholders. */
export function mcpContentToText(result: unknown): { text: string; truncated: boolean } {
	const content = (result as { content?: unknown } | null | undefined)?.content;
	const parts: string[] = [];
	if (Array.isArray(content)) {
		for (const entry of content) {
			if (typeof entry !== "object" || entry === null) continue;
			const block = entry as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			} else if ((block.type === "image" || block.type === "audio") && typeof block.mimeType === "string") {
				parts.push(`[${String(block.type)}: ${block.mimeType}]`);
			} else if (block.type === "resource") {
				parts.push(JSON.stringify(block.resource ?? block));
			} else {
				parts.push(JSON.stringify(block));
			}
		}
	}
	const full = parts.join("\n");
	if (full.length === 0) return { text: "(empty result)", truncated: false };
	if (full.length <= MCP_MAX_TEXT) return { text: full, truncated: false };
	return {
		text: `${full.slice(0, MCP_MAX_TEXT)}\n…[truncated ${full.length - MCP_MAX_TEXT} chars, 精简参数后重试]`,
		truncated: true,
	};
}

/** Error text safe for UI: never carries header secrets. */
export function sanitizeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 300);
}

export function defaultMcpConfig(): McpFileConfig {
	return {
		servers: {
			originkit: {
				type: "remote",
				url: MCP_ORIGINKIT_URL,
				headers: { Authorization: "Bearer {env:ORIGINKIT_API_KEY}" },
			},
		},
	};
}

/** First existing config path, or undefined for the built-in default. */
export function resolveMcpConfigPath(
	cwd: string,
	options?: { agentDir?: string; projectTrusted?: boolean },
): string | undefined {
	const envPath = process.env[MCP_CONFIG_ENV];
	if (envPath) return envPath;
	if (options?.projectTrusted !== false) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "mcp.json");
		if (existsSync(projectPath)) return projectPath;
	}
	const globalPath = join(options?.agentDir ?? getAgentDir(), "extensions", "mcp.json");
	if (existsSync(globalPath)) return globalPath;
	return undefined;
}

export function loadMcpConfigFile(path: string): McpFileConfig {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`MCP config ${path} must be an object with a "servers" map`);
	}
	return parsed as McpFileConfig;
}

export interface McpMergedConfig {
	config: McpFileConfig;
	paths: { envPath?: string; projectPath?: string; globalPath?: string };
	error?: string;
}

/**
 * Global single source with project override (same-name servers only).
 * Priority: explicit `C_CODE_MCP_CONFIG` file wins; otherwise merge
 * global `extensions/mcp.json` + trusted project `.c-code/mcp.json`.
 * Missing files fall back to the built-in Originkit default.
 */
export function loadMergedMcpConfig(
	cwd: string,
	options?: { agentDir?: string; projectTrusted?: boolean },
): McpMergedConfig {
	const envPath = process.env[MCP_CONFIG_ENV];
	if (envPath) {
		try {
			return { config: loadMcpConfigFile(envPath), paths: { envPath } };
		} catch (error) {
			return { config: { servers: {} }, paths: { envPath }, error: sanitizeError(error) };
		}
	}
	const agentDir = options?.agentDir ?? getAgentDir();
	const globalPath = join(agentDir, "extensions", "mcp.json");
	const merged: Record<string, McpServerConfig> = {};
	const paths: McpMergedConfig["paths"] = {};
	let error: string | undefined;
	if (existsSync(globalPath)) {
		paths.globalPath = globalPath;
		try {
			Object.assign(merged, loadMcpConfigFile(globalPath).servers ?? {});
		} catch (err) {
			error = sanitizeError(err);
		}
	}
	if (options?.projectTrusted !== false) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "mcp.json");
		if (existsSync(projectPath)) {
			paths.projectPath = projectPath;
			try {
				Object.assign(merged, loadMcpConfigFile(projectPath).servers ?? {});
			} catch (err) {
				error = error === undefined ? sanitizeError(err) : `${error}; ${sanitizeError(err)}`;
			}
		}
	}
	if (paths.globalPath === undefined && paths.projectPath === undefined) {
		return { config: defaultMcpConfig(), paths };
	}
	return { config: { servers: merged }, paths, ...(error === undefined ? {} : { error }) };
}

async function safeClose(client: Client | undefined): Promise<void> {
	if (!client) return;
	try {
		await client.close();
	} catch {
		// Closing a broken transport must not fail the state update.
	}
}

export class McpManager {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly isProjectTrusted: () => boolean;
	private readonly events: McpManagerEvents;
	private readonly runtimes = new Map<string, ServerRuntime>();
	private readonly toolNames = new Set<string>();
	private serverNames: string[] = [];
	private configError?: string;
	private disposed = false;
	private heartbeatTimer?: ReturnType<typeof setInterval>;
	private heartbeatRunning = false;

	constructor(options: {
		cwd: string;
		agentDir?: string;
		isProjectTrusted: () => boolean;
		events: McpManagerEvents;
	}) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.isProjectTrusted = options.isProjectTrusted;
		this.events = options.events;
	}

	getSnapshot(): McpSnapshot {
		if (this.configError !== undefined && this.serverNames.length === 0) {
			return { servers: [], error: this.configError };
		}
		return {
			servers: this.serverNames.map((name) => {
				const runtime = this.runtimes.get(name);
				if (!runtime) return { name, state: "off" as const, toolCount: 0 };
				const status: McpServerStatus = { name, state: runtime.state, toolCount: runtime.toolCount };
				if (runtime.error !== undefined) status.error = runtime.error;
				return status;
			}),
			...(this.configError === undefined ? {} : { error: this.configError }),
		};
	}

	async connectAll(): Promise<void> {
		if (this.disposed) return;
		this.toolNames.clear();
		this.configError = undefined;
		const merged = loadMergedMcpConfig(this.cwd, {
			agentDir: this.agentDir,
			projectTrusted: this.isProjectTrusted(),
		});
		if (merged.error !== undefined && Object.keys(merged.config.servers ?? {}).length === 0) {
			this.configError = merged.error;
			this.serverNames = [];
			this.publishTools();
			this.events.onStateChanged();
			return;
		}
		if (merged.error !== undefined) this.configError = merged.error;
		const fileConfig = merged.config;
		const servers = fileConfig.servers ?? {};
		// Once-configure: live env keys are copied to auth.json so restarts keep working.
		migrateEnvKeysToAuth(servers, this.agentDir);
		this.serverNames = Object.keys(servers);
		if (this.serverNames.length === 0) {
			this.publishTools();
			this.events.onStateChanged();
			return;
		}
		await Promise.all(
			this.serverNames.map((name) => {
				if (this.disposed) return Promise.resolve();
				const config = servers[name];
				if (!config) return Promise.resolve();
				return this.connectServer(name, config);
			}),
		);
		if (this.disposed) return;
		this.publishTools();
	}

	async reconnect(name?: string): Promise<void> {
		if (this.disposed) return;
		if (name !== undefined) {
			let fileConfig: McpFileConfig;
			try {
				const merged = loadMergedMcpConfig(this.cwd, {
					agentDir: this.agentDir,
					projectTrusted: this.isProjectTrusted(),
				});
				if (merged.error !== undefined) this.configError = merged.error;
				fileConfig = merged.config;
			} catch (error) {
				throw new Error(`MCP 重连失败: ${sanitizeError(error)}`);
			}
			const config = fileConfig.servers?.[name];
			if (!config) throw new Error(`MCP: 未知 server ${name}`);
			if (!this.serverNames.includes(name)) this.serverNames = [...this.serverNames, name];
			this.removeServerToolNames(name);
			await this.connectServer(name, config);
			this.publishTools();
			return;
		}
		for (const existing of [...this.runtimes.keys()]) await this.closeServer(existing);
		this.runtimes.clear();
		await this.connectAll();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.stopHeartbeat();
		for (const name of [...this.runtimes.keys()]) await this.closeServer(name);
		this.runtimes.clear();
		this.toolNames.clear();
		this.serverNames = [];
		this.configError = undefined;
	}

	/** Periodic self-heal: verify `ok` servers, retry `err` servers whose key arrived later. */
	startHeartbeat(intervalMs: number = MCP_HEARTBEAT_MS): void {
		this.stopHeartbeat();
		if (this.disposed) return;
		this.heartbeatTimer = setInterval(() => {
			if (this.heartbeatRunning || this.disposed) return;
			this.heartbeatRunning = true;
			void this.healthCheck().finally(() => {
				this.heartbeatRunning = false;
			});
		}, intervalMs);
		if (
			typeof this.heartbeatTimer === "object" &&
			typeof (this.heartbeatTimer as { unref?: unknown }).unref === "function"
		) {
			(this.heartbeatTimer as unknown as { unref: () => void }).unref();
		}
	}

	stopHeartbeat(): void {
		if (this.heartbeatTimer !== undefined) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		this.heartbeatRunning = false;
	}

	async healthCheck(): Promise<void> {
		if (this.disposed) return;
		for (const name of [...this.serverNames]) {
			if (this.disposed) return;
			const runtime = this.runtimes.get(name);
			if (!runtime?.client) {
				// Err server may have gained its key (user ran /mcp add --key); retry once.
				if (runtime?.state === "err") {
					const missing =
						runtime.config.type === "remote"
							? (missingEnvName(runtime.config.url, this.agentDir) ??
								Object.values(runtime.config.headers ?? {})
									.map((value) => missingEnvName(value, this.agentDir))
									.find((value) => value !== undefined))
							: undefined;
					if (missing === undefined) {
						await this.connectServer(name, runtime.config, { retries: 0 });
						this.publishTools();
					}
				}
				continue;
			}
			try {
				await withMcpTimeout(
					runtime.client.listTools(),
					Math.min(MCP_CONNECT_TIMEOUT_MS, 10000),
					`MCP ${name} health`,
				);
			} catch (error) {
				this.setState(name, { state: "err", error: sanitizeError(error) });
			}
		}
	}

	private setState(name: string, patch: Partial<ServerRuntime>): void {
		const runtime = this.runtimes.get(name);
		if (runtime) Object.assign(runtime, patch);
		this.events.onStateChanged();
	}

	private uniqueToolName(base: string): string {
		if (!this.toolNames.has(base)) {
			this.toolNames.add(base);
			return base;
		}
		let index = 2;
		while (this.toolNames.has(`${base}_${index}`)) index += 1;
		const name = `${base}_${index}`.slice(0, 64);
		this.toolNames.add(name);
		return name;
	}

	private async closeServer(name: string): Promise<void> {
		const runtime = this.runtimes.get(name);
		if (!runtime) return;
		await safeClose(runtime.client);
		this.runtimes.delete(name);
	}

	private removeServerToolNames(name: string): void {
		const runtime = this.runtimes.get(name);
		if (!runtime) return;
		for (const def of runtime.defs) this.toolNames.delete(def.name);
	}

	private publishTools(): void {
		const defs: ToolDefinition[] = [];
		for (const name of this.serverNames) {
			const runtime = this.runtimes.get(name);
			if (runtime) defs.push(...runtime.defs);
		}
		this.events.onToolsChanged(defs);
	}

	private buildTools(server: string, tools: ListedMcpTool[]): ToolDefinition[] {
		const manager = this;
		const defs: ToolDefinition[] = [];
		for (const tool of tools) {
			if (typeof tool.name !== "string" || tool.name.length === 0) continue;
			const name = this.uniqueToolName(normalizeMcpToolName(server, tool.name));
			const remoteName = tool.name;
			const description =
				typeof tool.description === "string" && tool.description.length > 0
					? tool.description
					: `MCP tool ${remoteName} from ${server}`;
			const guidelines =
				server === "originkit" && remoteName === "get_component"
					? ["Originkit get_component 每 key 每天限 10 次，先用 search/list 定位再取。"]
					: undefined;
			defs.push({
				name,
				label: `MCP ${server}/${remoteName}`,
				description,
				promptSnippet: `MCP ${server} 工具 ${remoteName}`,
				...(guidelines === undefined ? {} : { promptGuidelines: guidelines }),
				parameters: ensureObjectSchema(jsonSchemaToTypeBox(tool.inputSchema)),
				executionMode: "sequential",
				async execute(_toolCallId, params, signal, _onUpdate, _execCtx) {
					const runtime = manager.runtimes.get(server);
					if (!runtime?.client) {
						throw new Error(`MCP ${server} 未连接，用 /mcp reconnect ${server} 重连`);
					}
					const args = params as unknown as Record<string, unknown>;
					try {
						const result = await runtime.client.callTool(
							{ name: remoteName, arguments: args },
							undefined,
							signal === undefined ? undefined : { signal },
						);
						const { text, truncated } = mcpContentToText(result);
						if (!truncated && runtime.state === "err") {
							manager.setState(server, { state: "ok", error: undefined });
						}
						return {
							content: [{ type: "text", text }],
							details: { server, tool: remoteName, truncated },
						};
					} catch (error) {
						if (runtime.state !== "err") {
							manager.setState(server, { state: "err", error: sanitizeError(error) });
						}
						throw new Error(`MCP ${server}/${remoteName} 调用失败: ${sanitizeError(error)}`);
					}
				},
			});
		}
		return defs;
	}

	private async connectServer(name: string, config: McpServerConfig, options?: { retries?: number }): Promise<void> {
		await this.closeServer(name);
		this.runtimes.set(name, { config, state: "connecting", toolCount: 0, defs: [] });
		this.events.onStateChanged();

		if (config.type !== "remote") {
			this.runtimes.set(name, {
				config,
				state: "err",
				toolCount: 0,
				error: "stdio local 类型暂不支持远程 MCP，请改用 type: remote",
				defs: [],
			});
			this.events.onStateChanged();
			return;
		}

		const missingUrl = missingEnvName(config.url, this.agentDir);
		const missingHeader = Object.values(config.headers ?? {})
			.map((value) => missingEnvName(value, this.agentDir))
			.find((value) => value !== undefined);
		const missing = missingUrl ?? missingHeader;
		if (missing !== undefined) {
			this.runtimes.set(name, {
				config,
				state: "err",
				toolCount: 0,
				error: `missing ${missing}（/mcp add ${name} <url> --key <secret> 一次存入 auth.json，或 /mcp doctor 查看）`,
				defs: [],
			});
			this.events.onStateChanged();
			return;
		}

		const url = interpolateEnv(config.url, this.agentDir);
		const headers: Record<string, string> = {};
		for (const key of Object.keys(config.headers ?? {})) {
			headers[key] = interpolateEnv((config.headers as Record<string, string>)[key], this.agentDir);
		}

		const retries = options?.retries ?? MCP_CONNECT_RETRIES;
		let lastError: unknown;
		for (let attempt = 0; attempt <= retries; attempt += 1) {
			if (this.disposed) return;
			if (attempt > 0) await sleepMs(500 * 2 ** (attempt - 1));
			const client = new Client({ name: "c-code-mcp", version: MCP_MANAGER_VERSION }, { capabilities: {} });
			const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
			try {
				await withMcpTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, `MCP ${name} connect`);
				const listed = await withMcpTimeout(client.listTools(), MCP_CONNECT_TIMEOUT_MS, `MCP ${name} listTools`);
				const tools = (listed as unknown as { tools?: ListedMcpTool[] }).tools ?? [];
				const defs = this.buildTools(name, tools);
				this.runtimes.set(name, {
					config,
					client,
					transport,
					state: "ok",
					toolCount: defs.length,
					defs,
				});
				this.events.onStateChanged();
				return;
			} catch (error) {
				lastError = error;
				await safeClose(client);
				// Retry transient failures; final failure below records the sanitized error.
			}
		}
		if (this.disposed) return;
		this.runtimes.set(name, {
			config,
			state: "err",
			toolCount: 0,
			error: `${sanitizeError(lastError)}（已重试 ${retries} 次，用 /mcp reconnect ${name} 手动重试，心跳会自动恢复）`,
			defs: [],
		});
		this.events.onStateChanged();
		return;
	}
}
