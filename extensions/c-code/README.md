# C-code 品牌 extension（P0）

开局扫描线动效 + 中文 slash 命令 + 未来绿主题 + 只读子代理。纯 extension 层实现，不侵入核心运行时逻辑。
动效移植自 `C-code.bak/packages/c-tui/src/boot.ts`（5x7 点阵 + 16 帧扫描线，约 1.1s），着色跟随当前主题。

## 内容

- `src/index.ts` —— extension 入口：tui 会话挂动画 header（`setHeader`，仅冷启动播放，`dispose` 清 timer），注册中文命令与 `task` 子代理工具。
- `src/boot-frames.ts` —— 动效纯函数（字模/帧渲染/窄终端 scale，可单测）。
- `src/agent-modes.ts` —— 三模式政策纯函数（轮转/工具集/确认矩阵/子代理放行，可单测）。
- `src/zh-commands.ts` —— `/帮助` `/模型` `/关于`。
- `src/model-entry.ts` —— `/加模型` 向导：entry 构建/校验/合并纯函数 + 可注入 IO 的流程（备份再写入）。
- `src/subagent.ts` —— `task` 子代理：派生独立 pi 进程跑只读调研（参数拼装/事件解析/结果文案为纯函数）。
- `themes/c-code-green.json` —— accent `#00FF87` 的 dark 变体（仓库 `validateThemeJson` 已校验）。
- `vitest.config.ts` —— `@earendil-works/pi-coding-agent` 指向源码别名（沿用根 `vitest.base.ts` 惯例）。

## 测试与类型检查

```bash
# 单元测试
node node_modules/vitest/dist/cli.js --run --config extensions/c-code/vitest.config.ts

# 类型检查（根 tsconfig/biome 的 includes 不含 extensions/，故这里单配一份）
node_modules/.bin/tsgo --noEmit -p extensions/c-code/tsconfig.json
```

`tsconfig.json` 继承根配置，但把 `@earendil-works/pi-coding-agent` 指向宿主包的**发布声明**
（`node_modules/.../dist/index.d.ts`）——贴近真实安装形态，且避免把宿主源码拉进程序产生无关噪声。

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
| plan | 黄 | 禁 `edit`/`write`，只读；shell 逐条确认（`sed -i`/重定向等写路径也在内）；主题切 `c-code-yellow` |
| build | 绿（accent） | 全工具；`edit`/`write` 弹确认，危险 shell 弹确认；主题 `c-code-green` |
| yolo | 红 | `edit`/`write` 自动放行；危险 shell 仍弹确认；主题 `c-code-red` |

headless（`-p`/json 模式）没有可弹出的确认框：build 档的 `edit`/`write` 与危险 shell 一律拒绝，
要无人值守写入请显式切 yolo。

切模式同步 `setTheme`：输入框边框（跟 thinking 边框 token 走）与 footer 状态同色。
三套主题差异只在 accent 系 + thinking 边框色 + 选中底 tint，其余与 dark 一致。

默认 build。plan 快照进入前工具集，切回自动恢复（并保留 plan 期间新启用的非写类工具）。

## 子代理（task 工具）

主 agent 可调用 `task`，把自包含的调研任务派给**独立 pi 进程**执行，返回其结论。适合大范围检索、
跨文件调研这类需要独立上下文的重活；不适合需要写文件的任务。

安全模型（进程级隔离，能力由构造决定）：

| 机制 | 效果 |
|---|---|
| `--tools read,grep,find,ls` | 写工具与 shell 在子进程里**不存在**（CLI 白名单，不依赖 LLM 自觉） |
| `--no-extensions` | 子进程无扩展、无 `task` 工具 → 递归深度恒为 1 |
| `C_CODE_SUBAGENT=1` 环境变量 | 双重保险：万一去掉 `-ne`，子进程内的本扩展也会锁死只读 profile |
| `--no-session` | 不落盘会话，不污染会话列表 |
| `SIGTERM`→`SIGKILL` + 10 分钟超时 | 主会话 Ctrl+C 或超时即终止子进程 |
| 输出硬上限 50KB | 防止撑爆主会话上下文 |

子进程继承父进程环境变量，因此与主会话共用同一 agent dir（models.json、凭据一致）。
三档模式都放行 `task`（只读子代理与 plan 语义一致）；若将来给子代理开写权限，
必须同步改 `agent-modes.ts` 的 `SUBAGENT_TOOLS` 分支与 `subagent.ts` 的白名单。

## 回滚

- 删扩展与主题软链，`settings.json` 改回 `"theme": "dark"`；
- 移除扩展后动画页眉随扩展卸载消失。
