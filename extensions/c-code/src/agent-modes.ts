/**
 * Agent 三模式政策（纯函数）：plan 只读 / build 常规确认 / yolo 仅危险确认。
 * 危险 bash pattern 沿用官方 permission-gate 示例。
 */

export type AgentMode = "plan" | "build" | "yolo";

export const MODE_ORDER: AgentMode[] = ["plan", "build", "yolo"];

export const DEFAULT_MODE: AgentMode = "build";

export function nextMode(mode: AgentMode): AgentMode {
	return MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
}

/** 主题颜色 token：plan黄 / build绿(accent→#00FF87) / yolo红。 */
export function modeColor(mode: AgentMode): "warning" | "accent" | "error" {
	if (mode === "plan") return "warning";
	if (mode === "yolo") return "error";
	return "accent";
}

/** 模式对应主题：输入框边框跟 thinking 边框 token 走，主题里已按模式色覆盖。 */
export function themeForMode(mode: AgentMode): string {
	if (mode === "plan") return "c-code-yellow";
	if (mode === "yolo") return "c-code-red";
	return "c-code-green";
}

/** plan 禁用的写工具。 */
export const PLAN_DISABLED_TOOLS = ["edit", "write"];

export function toolsForMode(mode: AgentMode, allTools: string[]): string[] {
	if (mode !== "plan") return allTools;
	return allTools.filter((name) => !PLAN_DISABLED_TOOLS.includes(name));
}

/** 危险 bash：rm -rf / sudo / chmod|chown 777。 */
export const DANGEROUS_BASH_PATTERNS = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

export function isDangerousBash(input: Record<string, unknown>): boolean {
	const command = typeof input.command === "string" ? input.command : "";
	return DANGEROUS_BASH_PATTERNS.some((p) => p.test(command));
}

export type ToolDecision = "allow" | "confirm" | "deny";

/**
 * 三档门控：
 * - plan：edit/write 直接拒绝（工具已禁用，双保险）
 * - build：edit/write 弹确认
 * - yolo：edit/write 自动放行
 * - 危险 bash 三档都确认；无 UI 时直接拒绝
 * - 其余一律放行
 */
export function decideToolCall(
	mode: AgentMode,
	toolName: string,
	input: Record<string, unknown>,
	hasUI: boolean,
): ToolDecision {
	if (toolName === "edit" || toolName === "write") {
		if (mode === "plan") return "deny";
		if (mode === "build") return "confirm";
		return "allow";
	}
	if (toolName === "bash" && isDangerousBash(input)) {
		return hasUI ? "confirm" : "deny";
	}
	return "allow";
}
