/**
 * Agent 三模式政策（纯函数）：plan 只读 / build 常规确认 / yolo 仅危险确认。
 * 危险 shell pattern 是黑名单兜底而非安全边界（常见变体已覆盖，
 * 完整保障需外部沙箱类扩展）。bash 与 powershell 同权门控：
 * Windows 上 powershell 与 bash 危险度相同，plan 只读同样覆盖 shell。
 */

export type AgentMode = "plan" | "build" | "yolo";

export const MODE_ORDER: AgentMode[] = ["plan", "build", "yolo"];

export const DEFAULT_MODE: AgentMode = "build";

/** 写文件类工具：plan 禁用，build 确认，yolo 放行。 */
export const WRITE_TOOLS: readonly string[] = ["edit", "write"];

/** shell 类工具：跨平台同权门控（powershell 在 Windows 与 bash 等价）。 */
export const SHELL_TOOLS: readonly string[] = ["bash", "powershell"];

/**
 * 子代理类工具（实现见 subagent.ts）。
 *
 * 安全契约：子代理进程被 CLI 白名单钉死为只读工具集（read,grep,find,ls），
 * 且 -ne 使其无扩展、无 task 工具（递归深度恒为 1），故三档都放行。
 * 若将来给子代理开任何写权限，必须同步改两处：
 *   1) decideToolCall 里把本分支改成 plan=deny / build=confirm
 *   2) subagent.ts 的 --tools 白名单
 */
export const SUBAGENT_TOOLS: readonly string[] = ["task"];

/** plan 禁用的写工具。 */
export const PLAN_DISABLED_TOOLS: readonly string[] = WRITE_TOOLS;

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

export function toolsForMode(mode: AgentMode, allTools: string[]): string[] {
	if (mode !== "plan") return allTools;
	return allTools.filter((name) => !PLAN_DISABLED_TOOLS.includes(name));
}

/**
 * 危险 bash：rm 任意递归变体 / sudo / chmod|chown 777 / dd 裸写 /
 * mkfs / find -delete / truncate 清零 / 管道直接执行远程脚本 / force push。
 * 注意 `[^|;&]*` 防止跨越管道边界误配（如 `echo rm -rf | xargs` 的展示串）。
 */
export const DANGEROUS_BASH_PATTERNS = [
	/\brm\s+(-\w*r\w*|--recursive)\b/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*777/i,
	/\bdd\b[^|;&]*\bof=/i,
	/\bmkfs/i,
	/\bfind\b[^|;&]*-delete\b/i,
	/\btruncate\b[^|;&]*-s\s*0\b/i,
	/(\bcurl\b|\bwget\b)[^|;&]*\|\s*(ba|z|fi)?sh\b/i,
	/\bgit\s+push\b[^|;&]*--force/i,
];

/** 危险 PowerShell：递归强删（含 rm/del 别名）/ 磁盘操作 / IEX / 注册表写。 */
export const DANGEROUS_POWERSHELL_PATTERNS = [
	/\b(Remove-Item|ri|rm|del|erase)\b[^|;&]*\s-(Recurse|Force|r|f)\b/i,
	/\b(Format-Volume|Clear-Disk|Initialize-Disk)\b/i,
	/\bInvoke-Expression\b/i,
	/\b(iwr|Invoke-WebRequest|Invoke-RestMethod|curl)\b[^|;&]*\|\s*(iex|Invoke-Expression)\b/i,
	/\b(Set|Remove)-ItemProperty\b[^|;&]*Registry/i,
];

export function isDangerousBash(input: Record<string, unknown>): boolean {
	const command = typeof input.command === "string" ? input.command : "";
	return DANGEROUS_BASH_PATTERNS.some((p) => p.test(command));
}

export function isDangerousPowershell(input: Record<string, unknown>): boolean {
	const command = typeof input.command === "string" ? input.command : "";
	return DANGEROUS_POWERSHELL_PATTERNS.some((p) => p.test(command));
}

export function isDangerousShell(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "powershell") return isDangerousPowershell(input);
	return isDangerousBash(input);
}

export type ToolDecision = "allow" | "confirm" | "deny";

/**
 * 三档门控：
 * - plan：edit/write 直接拒绝（工具已禁用，双保险）；shell 逐条确认——
 *   plan 的"只读"承诺必须覆盖 shell（sed -i / 重定向 / 脚本写文件均可绕过工具禁用）
 * - build：edit/write 弹确认；危险 shell 弹确认
 * - yolo：edit/write 自动放行；危险 shell 三档都确认
 * - 所有需确认的场景：有 UI 弹窗，无 UI（headless）直接拒绝——
 *   无人可确认时默认拒绝是安全侧；headless 要写文件请显式用 yolo
 * - 其余一律放行
 */
export function decideToolCall(
	mode: AgentMode,
	toolName: string,
	input: Record<string, unknown>,
	hasUI: boolean,
): ToolDecision {
	// 只读子代理：三档放行（契约见 SUBAGENT_TOOLS 注释）
	if (SUBAGENT_TOOLS.includes(toolName)) return "allow";
	if (WRITE_TOOLS.includes(toolName)) {
		if (mode === "plan") return "deny";
		if (mode === "build") return hasUI ? "confirm" : "deny";
		return "allow";
	}
	if (SHELL_TOOLS.includes(toolName)) {
		if (mode === "plan") return hasUI ? "confirm" : "deny";
		if (isDangerousShell(toolName, input)) return hasUI ? "confirm" : "deny";
		return "allow";
	}
	return "allow";
}
