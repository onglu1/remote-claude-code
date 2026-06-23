#!/usr/bin/env bash
# remote-cc 启动脚本模板。
#
# 用法:
#   cp start.example.sh start.sh && chmod +x start.sh   # 首次
#   ./start.sh             构建前端 + 启动
#   ./start.sh --no-build  跳过构建,直接启动(快速重启)
#   ./start.sh stop        仅停止
#
# 说明:
# - 端口/口令等全部来自 ./.env(改 .env 的 PORT 即改端口,无需改脚本)。
# - 以宿主进程运行(需访问宿主 tmux/claude/项目路径),放进专用 tmux 会话便于保活与看日志。
# - 会自动停掉旧实例(同名 tmux 会话 + 占用该端口的进程)。
# - start.sh 在 .gitignore 中,本机可任意微调(改 tmux 名、加自启 hook、加日志轮转...)而不污染上游。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "[start] 缺少 .env,请先 cp .env.example .env 并填写 ADMIN_PASSWORD / SESSION_SECRET" >&2
  exit 1
fi

# 读取 .env 以拿到 PORT / 会话名(运行时会在 tmux 内再次载入完整环境)
set -a; . ./.env; set +a
PORT="${PORT:-4400}"
SESSION="${RCC_SERVICE_TMUX:-remote-cc-server}"

stop_existing() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  local old
  old="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [ -n "${old:-}" ]; then
    echo "[start] 停止占用 :$PORT 的旧实例 pid=$old"
    kill "$old" 2>/dev/null || true
    sleep 1
  fi
}

if [ "${1:-}" = "stop" ]; then
  stop_existing
  echo "[start] 已停止。"
  exit 0
fi

# 选择 Node 22(若有 nvm)
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use >/dev/null 2>&1 || true; fi

if [ "${1:-}" != "--no-build" ]; then
  echo "[start] 构建前端…"
  npm run build
fi

stop_existing

# 持久日志:每次启动清空,只保留「当前实例」的输出(便于事后查崩溃,且不会无限增长)。
LOG_DIR="$ROOT/logs"; mkdir -p "$LOG_DIR"; SERVER_LOG="$LOG_DIR/server.log"
: > "$SERVER_LOG"

# tmux 会话内运行:重新载入 nvm + .env,再以宿主进程启动后端;输出经 tee 同时进 pane 与日志文件。
RUNCMD="cd '$ROOT'"
RUNCMD="$RUNCMD && if [ -s \"\$HOME/.nvm/nvm.sh\" ]; then . \"\$HOME/.nvm/nvm.sh\"; nvm use >/dev/null 2>&1 || true; fi"
RUNCMD="$RUNCMD && set -a && . ./.env && set +a && npm run start 2>&1 | tee -a '$SERVER_LOG'"

tmux new-session -d -s "$SESSION" bash -lc "$RUNCMD"

echo "[start] remote-cc 已在 tmux 会话 '$SESSION' 启动,监听 :$PORT"
echo "[start] 看日志: tmux attach -t $SESSION   (脱离: Ctrl-b d)"
echo "[start] 持久日志: $SERVER_LOG"
echo "[start] 停止:   ./start.sh stop"
