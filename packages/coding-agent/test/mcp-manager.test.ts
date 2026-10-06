/**
 * Core MCP manager helpers (no network, no real keys).
 *
 * C-code connects to remote MCP servers natively (Originkit first) and
 * mirrors server health in the permanent sidebar MCP group.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import {
	defaultMcpConfig,
	ensureObjectSchema,
	getMcpAuthPath,
	interpolateEnv,
	jsonSchemaToTypeBox,
	loadMcpConfigFile,
	loadMergedMcpConfig,
	MCP_CONNECT_RETRIES,
	MCP_CONNECT_TIMEOUT_MS,
	McpManager,
	mcpContentToText,
	mcpEnvVarToProviderId,
	missingEnvName,
	normalizeMcpToolName,
	persistMcpEnvValue,
	readMcpAuthValue,
	resolveMcpConfigPath,
	resolveMcpEnvValue,
	sanitizeError,
	withMcpTimeout,
} from "../src/core/mcp-manager.ts";

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = { ...process.env };
	delete process.env.ORIGINKIT_API_KEY;
	delete process.env.C_CODE_MCP_CONFIG;
});

afterEach(() => {
	process.env = savedEnv;
});

function makeManager(cwd: string, agentDir: string) {
	const seenTools: ToolDefinition[][] = [];
	let states = 0;
	const manager = new McpManager({
		cwd,
		agentDir,
		isProjectTrusted: () => true,
		events: {
			onToolsChanged: (tools) => {
				seenTools.push(tools);
			},
			onStateChanged: () => {
				states += 1;
			},
		},
	});
	return { manager, seenTools, states: () => states };
}

describe("mcp-manager naming", () => {
	it("normalizes server/tool names to mcp_<server>_<tool>", () => {
		expect(normalizeMcpToolName("originkit", "list_components")).toBe("mcp_originkit_list_components");
		expect(normalizeMcpToolName("Originkit", "get-component")).toBe("mcp_originkit_get_component");
		expect(normalizeMcpToolName("my.server", "search.v2")).toBe("mcp_my_server_search_v2");
	});
});

describe("mcp-manager env interpolation", () => {
	it("replaces {env:VAR} with the environment value", () => {
		process.env.ORIGINKIT_API_KEY = "secret-key";
		expect(interpolateEnv("Bearer {env:ORIGINKIT_API_KEY}")).toBe("Bearer secret-key");
		expect(interpolateEnv("https://mcp.originkit.dev/mcp")).toBe("https://mcp.originkit.dev/mcp");
	});

	it("resolves missing variables to empty string and reports their name", () => {
		// Isolated agentDir (no auth.json) so the real user keyring never leaks into this test.
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-empty-"));
		try {
			expect(interpolateEnv("Bearer {env:ORIGINKIT_API_KEY}", agentDir)).toBe("Bearer ");
			expect(missingEnvName("Bearer {env:ORIGINKIT_API_KEY}", agentDir)).toBe("ORIGINKIT_API_KEY");
			expect(missingEnvName("Bearer abc", agentDir)).toBeUndefined();
			process.env.ORIGINKIT_API_KEY = "k";
			expect(missingEnvName("Bearer {env:ORIGINKIT_API_KEY}", agentDir)).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("mcp-manager JSON Schema conversion", () => {
	it("converts objects with required/optional fields", () => {
		const schema = jsonSchemaToTypeBox({
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				limit: { type: "number", default: 10 },
			},
			required: ["query"],
		}) as { type?: string; properties?: Record<string, { [key: string]: unknown }> };
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties ?? {})).toEqual(["query", "limit"]);
	});

	it("converts enums, arrays, and nested objects", () => {
		const enumSchema = jsonSchemaToTypeBox({ enum: ["a", "b"] }) as { anyOf?: unknown[] };
		expect(enumSchema.anyOf?.length ?? 0).toBeGreaterThan(0);
		const arraySchema = jsonSchemaToTypeBox({ type: "array", items: { type: "string" } }) as {
			type?: string;
		};
		expect(arraySchema.type).toBe("array");
	});

	it("degrades unknown fragments instead of throwing", () => {
		expect(() => jsonSchemaToTypeBox({ $ref: "#/defs/x" })).not.toThrow();
		expect(() => jsonSchemaToTypeBox(undefined)).not.toThrow();
		expect(() => jsonSchemaToTypeBox("string")).not.toThrow();
	});

	it("keeps top-level tool schemas as objects", () => {
		const wrapped = ensureObjectSchema(jsonSchemaToTypeBox({ type: "string" })) as { type?: string };
		expect(wrapped.type).toBe("object");
		const kept = ensureObjectSchema(jsonSchemaToTypeBox({ type: "object", properties: {} })) as {
			type?: string;
		};
		expect(kept.type).toBe("object");
	});
});

describe("mcp-manager result mapping", () => {
	it("joins text blocks and placeholders images", () => {
		const { text, truncated } = mcpContentToText({
			content: [
				{ type: "text", text: "hello" },
				{ type: "text", text: "world" },
				{ type: "image", data: "x", mimeType: "image/png" },
			],
		});
		expect(truncated).toBe(false);
		expect(text).toContain("hello\nworld");
		expect(text).toContain("[image: image/png]");
	});

	it("truncates large results with a notice", () => {
		const { text, truncated } = mcpContentToText({
			content: [{ type: "text", text: "x".repeat(13000) }],
		});
		expect(truncated).toBe(true);
		expect(text).toContain("truncated");
	});

	it("handles empty results", () => {
		expect(mcpContentToText({ content: [] }).text).toBe("(empty result)");
	});

	it("sanitizes errors without secrets", () => {
		expect(sanitizeError(new Error("401 Unauthorized")).length).toBeLessThanOrEqual(300);
		expect(sanitizeError("plain")).toBe("plain");
	});
});

describe("mcp-manager config", () => {
	it("defaults to the Originkit remote server", () => {
		const config = defaultMcpConfig();
		const originkit = config.servers?.originkit;
		expect(originkit?.type).toBe("remote");
		if (originkit?.type === "remote") {
			expect(originkit.url).toBe("https://mcp.originkit.dev/mcp");
			expect(originkit.headers?.Authorization).toContain("{env:ORIGINKIT_API_KEY}");
		}
	});

	it("prefers env, then project (when trusted), then global, then the default", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-core-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
		try {
			// No files anywhere: built-in default.
			expect(resolveMcpConfigPath(cwd, { agentDir })).toBeUndefined();
			mkdirSync(join(cwd, ".c-code"), { recursive: true });
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			const projectPath = join(cwd, ".c-code", "mcp.json");
			const globalPath = join(agentDir, "extensions", "mcp.json");
			writeFileSync(projectPath, "{}");
			writeFileSync(globalPath, "{}");
			process.env.C_CODE_MCP_CONFIG = "/env/mcp.json";
			expect(resolveMcpConfigPath(cwd, { agentDir })).toBe("/env/mcp.json");
			delete process.env.C_CODE_MCP_CONFIG;
			expect(resolveMcpConfigPath(cwd, { agentDir })).toBe(projectPath);
			// Untrusted projects are skipped in favor of the global file.
			expect(resolveMcpConfigPath(cwd, { agentDir, projectTrusted: false })).toBe(globalPath);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("loads config files and rejects malformed ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-core-"));
		try {
			const path = join(dir, "mcp.json");
			writeFileSync(path, JSON.stringify({ servers: {} }));
			expect(loadMcpConfigFile(path)).toEqual({ servers: {} });
			writeFileSync(path, "[]");
			expect(() => loadMcpConfigFile(path)).toThrow();
			writeFileSync(path, "{nope");
			expect(() => loadMcpConfigFile(path)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("McpManager lifecycle without network", () => {
	it("marks servers with missing keys as err without connecting", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-core-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
		try {
			const { manager } = makeManager(cwd, agentDir);
			await manager.connectAll();
			const snapshot = manager.getSnapshot();
			expect(snapshot.servers.map((server) => server.name)).toEqual(["originkit"]);
			expect(snapshot.servers[0]?.state).toBe("err");
			expect(snapshot.servers[0]?.error).toContain("ORIGINKIT_API_KEY");
			await manager.dispose();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reports config parse failures in the snapshot", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-core-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
		try {
			const badPath = join(cwd, "mcp.json");
			writeFileSync(badPath, "{nope");
			process.env.C_CODE_MCP_CONFIG = badPath;
			const { manager } = makeManager(cwd, agentDir);
			await manager.connectAll();
			expect(manager.getSnapshot().error).toBeDefined();
			expect(manager.getSnapshot().servers).toEqual([]);
			await manager.dispose();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects reconnect for unknown servers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-core-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
		try {
			const { manager } = makeManager(cwd, agentDir);
			await expect(manager.reconnect("nope")).rejects.toThrow("未知 server");
			await manager.dispose();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("mcp-manager auth.json persistence (once-configure)", () => {
	it("maps env vars to auth provider ids", () => {
		expect(mcpEnvVarToProviderId("ORIGINKIT_API_KEY")).toBe("mcp-originkit");
		expect(mcpEnvVarToProviderId("MY_SERVICE_TOKEN")).toBe("mcp-my-service");
	});

	it("resolves env first, then auth.json fallback", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-auth-"));
		try {
			delete process.env.ORIGINKIT_API_KEY;
			persistMcpEnvValue("ORIGINKIT_API_KEY", "auth-file-key", agentDir);
			expect(readMcpAuthValue("ORIGINKIT_API_KEY", agentDir)).toBe("auth-file-key");
			expect(resolveMcpEnvValue("ORIGINKIT_API_KEY", agentDir)).toBe("auth-file-key");
			expect(missingEnvName("Bearer {env:ORIGINKIT_API_KEY}", agentDir)).toBeUndefined();
			expect(interpolateEnv("Bearer {env:ORIGINKIT_API_KEY}", agentDir)).toBe("Bearer auth-file-key");
			process.env.ORIGINKIT_API_KEY = "env-key";
			expect(resolveMcpEnvValue("ORIGINKIT_API_KEY", agentDir)).toBe("env-key");
			expect(interpolateEnv("Bearer {env:ORIGINKIT_API_KEY}", agentDir)).toBe("Bearer env-key");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("connects without env when auth.json has the key", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-core-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
		try {
			delete process.env.ORIGINKIT_API_KEY;
			persistMcpEnvValue("ORIGINKIT_API_KEY", "auth-file-key", agentDir);
			const { manager } = makeManager(cwd, agentDir);
			// No network in test: connect will fail on network, but must NOT fail on missing key.
			await manager.connectAll();
			const snapshot = manager.getSnapshot();
			expect(snapshot.servers[0]?.error ?? "").not.toContain("ORIGINKIT_API_KEY");
			expect(getMcpAuthPath(agentDir).endsWith("auth.json")).toBe(true);
			await manager.dispose();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("mcp-manager merged config (global single source)", () => {
	it("merges global + project (project overrides same name)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-merge-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
		try {
			mkdirSync(join(cwd, ".c-code"), { recursive: true });
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(
				join(agentDir, "extensions", "mcp.json"),
				JSON.stringify({
					servers: {
						originkit: { type: "remote", url: "https://mcp.originkit.dev/mcp" },
						global_only: { type: "remote", url: "https://example.com/global" },
					},
				}),
			);
			writeFileSync(
				join(cwd, ".c-code", "mcp.json"),
				JSON.stringify({
					servers: {
						originkit: { type: "remote", url: "https://mcp.originkit.dev/mcp-project" },
						project_only: { type: "remote", url: "https://example.com/project" },
					},
				}),
			);
			const merged = loadMergedMcpConfig(cwd, { agentDir, projectTrusted: true });
			expect(Object.keys(merged.config.servers ?? {}).sort()).toEqual(["global_only", "originkit", "project_only"]);
			expect((merged.config.servers?.originkit as { url: string }).url).toContain("mcp-project");
			expect(merged.paths.globalPath).toContain("mcp.json");
			// Untrusted project is ignored, global wins.
			const untrusted = loadMergedMcpConfig(cwd, { agentDir, projectTrusted: false });
			expect(Object.keys(untrusted.config.servers ?? {}).sort()).toEqual(["global_only", "originkit"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("mcp-manager resilience (timeout + heartbeat)", () => {
	it("exposes sane timeout/retry budgets", () => {
		expect(MCP_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
		expect(MCP_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(30000);
		expect(MCP_CONNECT_RETRIES).toBeGreaterThanOrEqual(1);
	});

	it("withMcpTimeout rejects slow operations", async () => {
		const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 200));
		await expect(withMcpTimeout(slow, 20, "unit-test")).rejects.toThrow("unit-test");
		await expect(withMcpTimeout(Promise.resolve("fast"), 500, "unit-test")).resolves.toBe("fast");
	});

	it("reconnect surfaces friendly errors on malformed config", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-core-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
		try {
			const badPath = join(cwd, "mcp.json");
			writeFileSync(badPath, "{nope");
			process.env.C_CODE_MCP_CONFIG = badPath;
			const { manager } = makeManager(cwd, agentDir);
			await expect(manager.reconnect("originkit")).rejects.toThrow();
			await manager.dispose();
		} finally {
			delete process.env.C_CODE_MCP_CONFIG;
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("heartbeat start/stop is safe without servers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "mcp-core-"));
		const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
		try {
			const { manager } = makeManager(cwd, agentDir);
			manager.startHeartbeat(50);
			await manager.healthCheck();
			manager.stopHeartbeat();
			await manager.dispose();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
