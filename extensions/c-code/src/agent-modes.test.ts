import { describe, expect, test } from "vitest";
import {
	DANGEROUS_BASH_PATTERNS,
	type AgentMode,
	MODE_ORDER,
	decideToolCall,
	modeColor,
	nextMode,
	themeForMode,
	toolsForMode,
} from "./agent-modes.ts";

describe("MODE_ORDER / nextMode", () => {
	test("plan→build→yolo→plan 轮转", () => {
		expect(MODE_ORDER).toEqual(["plan", "build", "yolo"]);
		expect(nextMode("plan")).toBe("build");
		expect(nextMode("build")).toBe("yolo");
		expect(nextMode("yolo")).toBe("plan");
	});
});

describe("modeColor", () => {
	test("plan黄 / build绿 / yolo红（主题 token）", () => {
		const colors: Record<AgentMode, string> = { plan: "warning", build: "accent", yolo: "error" };
		for (const mode of MODE_ORDER) {
			expect(modeColor(mode)).toBe(colors[mode]);
		}
	});
});

describe("toolsForMode", () => {
	const all = ["read", "bash", "edit", "write", "grep"];
	test("plan 禁 edit/write，其余保留", () => {
		expect(toolsForMode("plan", all)).toEqual(["read", "bash", "grep"]);
	});
	test("build/yolo 全量", () => {
		expect(toolsForMode("build", all)).toEqual(all);
		expect(toolsForMode("yolo", all)).toEqual(all);
	});
});

describe("decideToolCall", () => {
	test("plan 下 edit/write 直接拒绝", () => {
		expect(decideToolCall("plan", "edit", {}, true)).toBe("deny");
		expect(decideToolCall("plan", "write", {}, true)).toBe("deny");
		expect(decideToolCall("plan", "read", {}, true)).toBe("allow");
	});

	test("build 下 edit/write 需确认，读工具放行", () => {
		expect(decideToolCall("build", "edit", {}, true)).toBe("confirm");
		expect(decideToolCall("build", "write", {}, true)).toBe("confirm");
		expect(decideToolCall("build", "read", {}, true)).toBe("allow");
	});

	test("yolo 下 edit/write 自动放行", () => {
		expect(decideToolCall("yolo", "edit", {}, true)).toBe("allow");
		expect(decideToolCall("yolo", "write", {}, true)).toBe("allow");
	});

	test("危险 bash 三档都确认（有 UI），无 UI 直接拒绝", () => {
		for (const mode of MODE_ORDER) {
			expect(decideToolCall(mode, "bash", { command: "rm -rf /tmp/x" }, true)).toBe("confirm");
			expect(decideToolCall(mode, "bash", { command: "sudo ls" }, true)).toBe("confirm");
			expect(decideToolCall(mode, "bash", { command: "rm -rf /tmp/x" }, false)).toBe("deny");
		}
	});

	test("安全 bash 三档都放行", () => {
		for (const mode of MODE_ORDER) {
			expect(decideToolCall(mode, "bash", { command: "ls -la" }, true)).toBe("allow");
		}
	});
});

describe("DANGEROUS_BASH_PATTERNS", () => {
	test("覆盖官方 permission-gate 三类", () => {
		const hits = ["rm -rf x", "sudo apt update", "chmod 777 f"];
		for (const cmd of hits) {
			expect(DANGEROUS_BASH_PATTERNS.some((p) => p.test(cmd))).toBe(true);
		}
		expect(DANGEROUS_BASH_PATTERNS.some((p) => p.test("ls -la"))).toBe(false);
	});
});

describe("themeForMode", () => {
	test("plan黄 / build绿 / yolo红主题名", () => {
		expect(themeForMode("plan")).toBe("c-code-yellow");
		expect(themeForMode("build")).toBe("c-code-green");
		expect(themeForMode("yolo")).toBe("c-code-red");
	});
});
