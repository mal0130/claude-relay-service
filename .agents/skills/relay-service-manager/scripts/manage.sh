#!/bin/bash

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Calculate project root (assuming structure: .claude/skills/relay-service-manager/scripts/manage.sh)
PROJECT_ROOT="$(dirname "$(dirname "$(dirname "$(dirname "$SCRIPT_DIR")")")")"
MANAGER_JS="$PROJECT_ROOT/scripts/manage.js"
CONFIG_JS="$PROJECT_ROOT/config/config.js"

# Verify manage.js exists
if [ ! -f "$MANAGER_JS" ]; then
    # Fallback: try relative to current directory if not found via calculated path
    if [ -f "scripts/manage.js" ]; then
        MANAGER_JS="scripts/manage.js"
        CONFIG_JS="config/config.js"
    else
        echo "Error: Cannot find scripts/manage.js at $MANAGER_JS or ./scripts/manage.js"
        exit 1
    fi
fi

# Load fnm (Fast Node Manager)
if command -v fnm &> /dev/null; then
  eval "$(fnm env --use-on-cd)"

  # Switch to Node 24
  fnm use 24 || { echo "Failed to switch to node 24"; exit 1; }
else
  echo "Error: fnm not found"
  echo "Please install fnm: https://github.com/Schniz/fnm"
  exit 1
fi

# Check Redis status before starting service
if [[ "$1" == "start" || "$1" == "restart" ]]; then
    echo "🔍 检查 Redis 状态..."
    if ! redis-cli ping > /dev/null 2>&1; then
        echo "❌ Redis 未运行，正在尝试启动..."

        # Try to start Redis with daemonize
        if redis-server --daemonize yes > /dev/null 2>&1; then
            sleep 2
            if redis-cli ping > /dev/null 2>&1; then
                echo "✅ Redis 已启动"
            else
                echo "⚠️  Redis 启动失败，请手动启动: redis-server --daemonize yes"
                exit 1
            fi
        else
            # Try brew services
            echo "尝试使用 Homebrew 启动 Redis..."
            brew services start redis > /dev/null 2>&1
            sleep 3
            if ! redis-cli ping > /dev/null 2>&1; then
                echo "❌ 无法启动 Redis，请手动启动后重试"
                exit 1
            fi
            echo "✅ Redis 已启动"
        fi
    else
        echo "✅ Redis 运行正常"
    fi
fi

# Execute the management script
node "$MANAGER_JS" "$@"

# If command is start or restart with daemon flag, output access URLs
if [[ "$1" == "start" || "$1" == "restart" ]] && [[ "$*" == *"-d"* || "$*" == *"--daemon"* ]]; then
    # Wait a moment for service to start
    sleep 2

    # Extract port from config (default 3000)
    PORT=$(grep -E "port.*process\.env\.PORT.*\|\|.*[0-9]+" "$CONFIG_JS" | grep -oE "[0-9]+" | head -1)
    PORT=${PORT:-3000}

    echo ""
    echo "🌐 访问地址:"
    echo "   http://localhost:$PORT"
    echo "   http://127.0.0.1:$PORT"
    echo "   管理界面: http://localhost:$PORT/admin-next/"
    echo ""
fi
