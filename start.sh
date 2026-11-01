#!/usr/bin/env bash
# 仅在 Node 支持时启用内置代理选项；代理地址由环境自行配置。
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8799}"
echo "[quota-board] 启动：http://127.0.0.1:$PORT"
node_help=$(node --help)
if [[ "$node_help" == *"--use-env-proxy"* ]]; then
  exec node --use-env-proxy server.mjs --port "$PORT"
else
  echo '[quota-board] 当前 Node 不支持自动读取代理的选项，将尝试直连。' >&2
  exec node server.mjs --port "$PORT"
fi
