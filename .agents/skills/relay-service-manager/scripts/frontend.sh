#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Calculate project root (assuming structure: .claude/skills/relay-service-manager/scripts/frontend.sh)
PROJECT_ROOT="$(dirname "$(dirname "$(dirname "$(dirname "$SCRIPT_DIR")")")")"
FRONTEND_DIR="$PROJECT_ROOT/web/admin-spa"
PID_FILE="$(dirname "$SCRIPT_DIR")/frontend.pid"
LOG_FILE="$PROJECT_ROOT/logs/frontend-dev.log"

# Load fnm (Fast Node Manager)
if command -v fnm &> /dev/null; then
  eval "$(fnm env --use-on-cd)"
  fnm use 24 || { echo "Failed to switch to node 24"; exit 1; }
else
  echo "Error: fnm not found"
  echo "Please install fnm: https://github.com/Schniz/fnm"
  exit 1
fi

# Verify frontend directory exists
if [ ! -d "$FRONTEND_DIR" ]; then
  echo "Error: Frontend directory not found at $FRONTEND_DIR"
  exit 1
fi

get_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE"
  fi
}

is_running() {
  local pid=$(get_pid)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

case "$1" in
  start)
    if is_running; then
      echo "✅ 前端开发服务已在运行 (PID: $(get_pid))"
      echo "   http://localhost:3001"
      exit 0
    fi

    # Ensure log directory exists
    mkdir -p "$(dirname "$LOG_FILE")"

    echo "🚀 启动前端开发服务..."
    cd "$FRONTEND_DIR" && npm run dev > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 3

    if is_running; then
      echo "✅ 前端开发服务已启动 (PID: $(get_pid))"
      echo "   http://localhost:3001"
      echo "   日志: $LOG_FILE"
    else
      echo "❌ 前端开发服务启动失败，查看日志: $LOG_FILE"
      rm -f "$PID_FILE"
      exit 1
    fi
    ;;

  stop)
    if ! is_running; then
      echo "⚪ 前端开发服务未运行"
      rm -f "$PID_FILE"
      exit 0
    fi

    pid=$(get_pid)
    echo "🛑 停止前端开发服务 (PID: $pid)..."
    kill "$pid" 2>/dev/null
    sleep 1

    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null
    fi

    rm -f "$PID_FILE"
    echo "✅ 前端开发服务已停止"
    ;;

  status)
    if is_running; then
      echo "✅ 前端开发服务运行中 (PID: $(get_pid))"
      echo "   http://localhost:3001"
    else
      echo "❌ 前端开发服务未运行"
      rm -f "$PID_FILE"
    fi
    ;;

  logs)
    LINES="${2:-50}"
    if [ -f "$LOG_FILE" ]; then
      tail -n "$LINES" "$LOG_FILE"
    else
      echo "⚪ 暂无日志"
    fi
    ;;

  *)
    echo "用法: $0 {start|stop|status|logs [行数]}"
    exit 1
    ;;
esac
