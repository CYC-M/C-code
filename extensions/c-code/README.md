# C-code 品牌 extension（P0）

开局扫描线动效 + 中文 slash 命令 + 未来绿主题。纯 extension 层实现，不侵入核心运行时逻辑。
动效移植自 `C-code.bak/packages/c-tui/src/boot.ts`（5x7 点阵 + 16 帧扫描线，约 1.1s），着色跟随当前主题。

## 内容

- `src/index.ts` —— extension 入口：tui 会话挂动画 header（`setHeader`，播完常驻，`dispose` 清 timer），注册中文命令。
- `src/boot-frames.ts` —— 动效纯函数（字模/帧渲染/窄终端 scale，可单测）。
- `src/agent-modes.ts` —— 三模式政策纯函数（轮转/工具集/确认矩阵，可单测）。
- `src/zh-commands.ts` —— `/帮助` `/模型` `/关于`。
- `src/model-entry.ts` —— `/加模型` 向导：entry 构建/校验/合并纯函数 + 可注入 IO 的流程（备份再写入）。
- `themes/c-code-green.json` —— accent `#00FF87` 的 dark 变体（仓库 `validateThemeJson` 已校验）。
- `vitest.config.ts` —— `@earendil-works/pi-coding-agent` 指向源码别名（沿用根 `vitest.base.ts` 惯例）。

## 测试

```bash
node node_modules/vitest/dist/cli.js --run --config extensions/c-code/vitest.config.ts
```

## 安装（常驻）

```bash
mkdir -p ~/.c-code/agent/extensions ~/.c-code/agent/themes
ln -s <repo>/extensions/c-code ~/.c-code/agent/extensions/c-code
ln -s <repo>/extensions/c-code/themes/c-code-green.json ~/.c-code/agent/themes/c-code-green.json
ln -s <repo>/extensions/c-code/themes/c-code-yellow.json ~/.c-code/agent/themes/c-code-yellow.json
ln -s <repo>/extensions/c-code/themes/c-code-red.json ~/.c-code/agent/themes/c-code-red.json
# settings.json 加 "theme": "c-code-green"
```

临时加载：`c-code --extension ./extensions/c-code/src/index.ts`

## 按键与模式

`~/.c-code/agent/keybindings.json`（Tab 让给思考循环，补全改 `ctrl+space`，空出 `shift+tab`）：

```json
{ "app.thinking.cycle": "tab", "tui.input.tab": "ctrl+space" }
```

`shift+tab` 或 `/模式 plan|build|yolo` 轮转 agent 模式，footer 显示颜色状态：

| 模式 | 颜色 | 行为 |
|---|---|---|
| plan | 黄 | 禁 `edit`/`write`，只读；主题切 `c-code-yellow` |
| build | 绿（accent） | 全工具；`edit`/`write` 弹确认，危险 bash 弹确认；主题 `c-code-green` |
| yolo | 红 | 全工具自动放行；仅 `rm -rf`/`sudo`/`chmod 777` 类弹确认；主题 `c-code-red` |

切模式同步 `setTheme`：输入框边框（跟 thinking 边框 token 走）与 footer 状态同色。
三套主题差异只在 accent 系 + thinking 边框色 + 选中底 tint，其余与 dark 一致。

默认 build。plan 快照进入前工具集，切回自动恢复。

## 回滚

- 删扩展与主题软链，`settings.json` 改回 `"theme": "dark"`；
- 移除扩展后动画页眉随扩展卸载消失。
