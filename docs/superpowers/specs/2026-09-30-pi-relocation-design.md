# C-code → 纯净 Pi 重定位设计 (A: 本地提升)

日期: 2026-09-30
来源: earendil-works/pi v0.87.1 (f07218c)
方法: 本地提升 (从 C-code.bak/vendor/pi 原样复制, 排除 node_modules)

## 1. 背景

旧 C-code 是 vendor+overlay 结构: `vendor/pi` (上游 v0.87.1) + `packages/c-*` 7 个自研包 (789 测试)。
用户判定之前方向有问题, 要求整仓清空重来, 直接放 github 开源 pi, 本地有原文件则直接复制, 再做自适应优化。

## 2. 决策 (已确认)

- 清空范围: 整仓清空重来。
- Pi 版本: 就用 v0.87.1 (本地 vendor/pi 已验证完整, 26 项齐全)。
- 旧仓: 改名保留 (`C-code` → `C-code.bak`), 不删除, git 历史留在 bak 内。
- 优化目标: 国产网关+汉化, 记忆+桌面 (下一步实施, 本次只做重定位+验证)。
- 执行方式: A 本地提升 (离线 cp, 不走公网 clone, 避开镜像代理干扰)。

## 3. 执行 (已完成)

1. `mv C-code C-code.bak` (bak 不存在, 无需日期后缀)。
2. `mkdir C-code`, `rsync -a --exclude=node_modules C-code.bak/vendor/pi/ C-code/`。
3. `diff -r --exclude=node_modules` 对比: 零差异。
4. 新仓 `git init` (未 commit, 遵守 AGENTS.md 非请勿提交)。

## 4. 验证 (已完成, 2026-09-30)

- `npm install --ignore-scripts`: 通过 (338 packages, 仅 EBADENGINE/deprecated 警告)。
- `npm run build:offline`: 通过 (chord→tui→telemetry→ai→durable→agent→sqlite→protocol→client→server→coding-agent, bundle 56 files 8.2 MiB)。
- `./test.sh`: 通过 (隔离环境全量非 e2e, 尾段 sqlite-node 105 passed, 全程无失败退出)。
- 纠正: `mini-test.sh` 是交互式 mini runner (tsx mini/main.ts), 不是测试套件, 不纳入验证链。

## 5. 自适应优化接入原则 (下一步)

- pi 本体禁止直改; 定制一律走 extension/overlay。
- 国产网关: 参考 `packages/coding-agent/examples/extensions/custom-provider-*` 做 provider extension (qwen/moonshot/zai/deepseek/ollama/vllm)。
- TUI 汉化: 只做 theme + slash/commands 中文包。
- 记忆/skills: 桥接 `pi-durable` + `session-backends`。
- 桌面 Electron: 上游无对应, 后续从 `C-code.bak` 取回独立成包。
- 旧自研 `packages/c-*` 仅作参考, 按 `keep-as-extension / drop-in-favor-of-upstream / merge` 逐文件定夺 (详见 bak 内 `docs/ADAPTATION.md`)。

## 6. 风险与回滚

- 旧仓完整保留在 `../C-code.bak` (含 .git/7 个包/node_modules), 误删可直接改名恢复。
- 新仓尚未首 commit; 首 commit 前建议先定 `.gitignore` (已自带) 与 writing-plans 产出的实施计划。
