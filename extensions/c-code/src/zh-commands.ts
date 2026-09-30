/**
 * C-code 中文 slash 命令：帮助 / 模型 / 关于。
 * 纯描述 + handler，经 registerZhCommands 接入 ExtensionAPI。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ZhCommandDef {
	name: string;
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export function createZhCommands(version: string): ZhCommandDef[] {
	return [
		{
			name: "帮助",
			description: "显示 C-code 中文命令速查",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					[
						"C-code 中文命令：",
						"/帮助 —— 本速查",
						"/模型 —— 模型切换指引（/model 空参列候选，/models 看全部）",
						"/模式 —— 切换 plan/build/yolo",
						"/加模型 —— 交互式添加自定义模型商",
						"/关于 —— 版本与主题信息",
						"常用原生命令：/model /new /compact /session /quit",
					].join("\n"),
					"info",
				);
			},
		},
		{
			name: "模型",
			description: "模型切换指引",
			handler: async (_args, ctx) => {
				ctx.ui.notify(
					["当前用 /model 切换模型：", "· 输入 /model（空参）弹出候选选择", "· 输入 /models 查看全部可用模型", "· 凭据缺失时用 /login 配 Key"].join("\n"),
					"info",
				);
			},
		},
		{
			name: "关于",
			description: "关于 C-code：版本与主题",
			handler: async (_args, ctx) => {
				ctx.ui.notify(`C-code 专属 coding agent（基于上游 v${version} 深度定制）\n主题：c-code-green 未来绿 #00FF87`, "info");
			},
		},
	];
}

export function registerZhCommands(pi: ExtensionAPI, version: string): void {
	for (const cmd of createZhCommands(version)) {
		pi.registerCommand(cmd.name, {
			description: cmd.description,
			handler: cmd.handler,
		});
	}
}
