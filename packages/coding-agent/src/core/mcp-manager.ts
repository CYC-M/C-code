/**
 * Core MCP manager.
 *
 * Owns remote MCP server connections (Originkit first) for all run modes.
 * Reads `mcp.json` (env `C_CODE_MCP_CONFIG`, project `.c-code/mcp.json` when
 * the project is trusted, user `<agent-dir>/extensions/mcp.json`, in that
 * order; falls back to the built-in Originkit default), registers each MCP
 * tool as `mcp_<server>_<tool>`, and exposes a snapshot for the sidebar.
 *
 * Secrets: header values support `{env:VAR}` interpolation. Resolved values
 * are never logged, notified, or thrown; only the variable name is mentioned.
 */

import { existsSync, readFileSync } from "node:fs";
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

/** Replace `{env:VAR}` with the environment value (empty string when unset). */
export function interpolateEnv(value: string): string {
	return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

/** Name the first `{env:VAR}` whose variable is missing or empty, if any. */
export function missingEnvName(value: string): string | undefined {
	const match = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value);
	if (!match) return undefined;
	const current = process.env[match[1]];
	return current === undefined || current === "" ? match[1] : undefined;
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
		const path = resolveMcpConfigPath(this.cwd, {
			agentDir: this.agentDir,
			projectTrusted: this.isProjectTrusted(),
		});
		let fileConfig: McpFileConfig;
		if (path === undefined) {
			fileConfig = defaultMcpConfig();
		} else {
			try {
				fileConfig = loadMcpConfigFile(path);
			} catch (error) {
				this.configError = sanitizeError(error);
				this.serverNames = [];
				this.publishTools();
				this.events.onStateChanged();
				return;
			}
		}
		const servers = fileConfig.servers ?? {};
		this.serverNames = Object.keys(servers);
		if (this.serverNames.length === 0) {
			this.publishTools();
			this.events.onStateChanged();
			return;
		}
		for (const name of this.serverNames) {
			if (this.disposed) return;
			await this.connectServer(name, servers[name]);
		}
		this.publishTools();
	}

	async reconnect(name?: string): Promise<void> {
		if (this.disposed) return;
		if (name !== undefined) {
			const path = resolveMcpConfigPath(this.cwd, {
				agentDir: this.agentDir,
				projectTrusted: this.isProjectTrusted(),
			});
			const fileConfig = path === undefined ? defaultMcpConfig() : loadMcpConfigFile(path);
			const config = fileConfig.servers?.[name];
			if (!config) throw new Error(`MCP: 未知 server ${name}`);
			if (!this.serverNames.includes(name)) this.serverNames = [...this.serverNames, name];
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
		for (const name of [...this.runtimes.keys()]) await this.closeServer(name);
		this.runtimes.clear();
		this.toolNames.clear();
		this.serverNames = [];
		this.configError = undefined;
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

	private async connectServer(name: string, config: McpServerConfig): Promise<void> {
		await this.closeServer(name);
		this.runtimes.set(name, { config, state: "connecting", toolCount: 0, defs: [] });
		this.events.onStateChanged();

		if (config.type !== "remote") {
			this.runtimes.set(name, {
				config,
				state: "err",
				toolCount: 0,
				error: "stdio unsupported",
				defs: [],
			});
			this.events.onStateChanged();
			return;
		}

		const missingUrl = missingEnvName(config.url);
		const missingHeader = Object.values(config.headers ?? {})
			.map(missingEnvName)
			.find((value) => value !== undefined);
		const missing = missingUrl ?? missingHeader;
		if (missing !== undefined) {
			this.runtimes.set(name, {
				config,
				state: "err",
				toolCount: 0,
				error: `missing ${missing}`,
				defs: [],
			});
			this.events.onStateChanged();
			return;
		}

		const url = interpolateEnv(config.url);
		const headers: Record<string, string> = {};
		for (const key of Object.keys(config.headers ?? {})) {
			headers[key] = interpolateEnv((config.headers as Record<string, string>)[key]);
		}

		const client = new Client({ name: "c-code-mcp", version: MCP_MANAGER_VERSION }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
		try {
			await client.connect(transport);
			const listed = await client.listTools();
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
		} catch (error) {
			await safeClose(client);
			this.runtimes.set(name, {
				config,
				state: "err",
				toolCount: 0,
				error: sanitizeError(error),
				defs: [],
			});
			this.events.onStateChanged();
		}
	}
}
