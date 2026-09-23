#!/bin/sh

set -e

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR"

# 存储所有子进程的 PID
pids=""

# 清理函数：优雅关闭所有服务
cleanup() {
    echo ""
    echo "🛑 正在关闭所有服务..."

    # 发送 SIGTERM 信号给所有子进程
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            service_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            echo "   关闭进程 $pid ($service_name)..."
            kill -TERM "$pid" 2>/dev/null
        fi
    done

    # 等待所有进程退出（最多等待 5 秒）
    sleep 1
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            # 如果还在运行，等待最多 4 秒
            timeout=4
            while [ $timeout -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
                sleep 1
                timeout=$((timeout - 1))
            done
            # 如果仍然在运行，强制关闭
            if [ $timeout -eq 0 ]; then
                if kill -0 "$pid" 2>/dev/null; then
                    echo "   强制关闭进程 $pid..."
                    kill -KILL "$pid" 2>/dev/null
                fi
            fi
        fi
    done

    echo "✅ 所有服务已关闭"
    exit 0
}

echo "🚀 开始启动所有服务（Go 单栈：backend-go :3000 + scraper-go :3030）..."
echo ""

cd "$BUILD_DIR" || exit 1

ls -lah

DEFAULT_PACKAGED_DB_PATH="/app/db/custom.db"
DEFAULT_PACKAGED_DATABASE_PATH="${DATABASE_PATH:-$DEFAULT_PACKAGED_DB_PATH}"

# Python 依赖在构建阶段安装进部署产物（scraper-go render 策略使用）。
if [ -d "/app/python-runtime/site-packages" ]; then
    export PYTHONPATH="/app/python-runtime/site-packages${PYTHONPATH:+:$PYTHONPATH}"
    export PATH="/app/python-runtime/site-packages/bin:$PATH"
    export PYTHONDONTWRITEBYTECODE=1
    export PYTHONUNBUFFERED=1
    echo "🐍 已启用部署包内 Python runtime: $(python --version 2>&1)"
fi

# 数据库守卫：backend-go 启动时空表自动播种（seed go:embed），无需预置数据；
# 但若外层明确指定 DB 路径则透传。
export DB_PATH="$DEFAULT_PACKAGED_DATABASE_PATH"
if [ ! -f "$DB_PATH" ]; then
    echo "🗄️  数据库文件不存在（$DB_PATH），backend-go 将创建空库并自动播种 15 条规则/9 分类"
fi

# 启动 backend-go（页面 SSR + 业务 API + 采集 runner，:3000）
if [ -f "./backend-go/backend-go.bin" ]; then
    echo "🚀 启动 backend-go（:3000，mode=all）..."
    cd backend-go/ || exit 1
    export BACKEND_PORT="${BACKEND_PORT:-3000}"
    export BACKEND_MODE="${BACKEND_MODE:-all}"
    ./backend-go.bin &
    BACKEND_PID=$!
    pids="$pids $BACKEND_PID"
    sleep 2
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo "❌ backend-go 启动失败"
        exit 1
    fi
    echo "✅ backend-go 已启动 (PID: $BACKEND_PID, Port: $BACKEND_PORT)"
    cd ../
else
    echo "❌ 未找到 backend-go/backend-go.bin，无法启动主服务"
    exit 1
fi

# 启动 scraper-go 采集引擎（:3030）
if [ -f "./scraper-go/scraper-go.bin" ]; then
    echo "🚀 启动 scraper-go（:3030）..."
    cd scraper-go/ || exit 1
    ./scraper-go.bin &
    ENGINE_PID=$!
    pids="$pids $ENGINE_PID"
    sleep 1
    if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
        echo "⚠️  scraper-go 启动失败（backend-go 内置互监护会周期重试拉起）"
    else
        echo "✅ scraper-go 已启动 (PID: $ENGINE_PID, Port: 3030)"
    fi
    cd ../
else
    echo "⚠️  未找到 scraper-go/scraper-go.bin（backend-go 互监护会在任务执行时拉起引擎）"
fi

echo ""
echo "✅ 全部服务启动完成，等待信号..."
trap cleanup INT TERM
wait
