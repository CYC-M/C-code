#!/bin/bash
# 双击启动 pi CLI（交互式 TUI），工作区固定在仓库自身。
# 带参数会原样透传，例如：./启动CLI.command --help
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1

# 失败时留住窗口：双击启动时等一次回车，管道/CI 里不阻塞
pause() {
  [ -t 0 ] && read -r -p "按回车关闭本窗口" _
}

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。pi 需要 Node 22.19+（brew install node 或用 nvm 切版本）。"
  pause
  exit 1
fi

if ! node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>22||(M===22&&m>=19)?0:1)'; then
  echo "Node 版本过低：$(node -v)，需要 22.19+。"
  pause
  exit 1
fi

if [ ! -f "$ROOT/packages/coding-agent/dist/bundle/cli.js" ]; then
  echo "没找到 dist/bundle/cli.js，请先在仓库根执行："
  echo "  npm install --ignore-scripts && npm run build:offline"
  pause
  exit 1
fi

exec node "$ROOT/packages/coding-agent/dist/bundle/cli.js" "$@"
