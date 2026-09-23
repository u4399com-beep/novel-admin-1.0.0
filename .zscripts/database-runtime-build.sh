# 【已废弃·Task 27】Next.js/TS mini-services 构建链路已拆除（全栈 Go 化）。
# 现行构建：bun run build = scripts/build-go.sh（backend-go.bin + scraper-go.bin + tw.css）。
# 本脚本保留存档，不再被任何链路引用。
#!/bin/bash

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/z/my-project}"
BUILD_DIR="${BUILD_DIR:?BUILD_DIR is required}"
SOURCE_DB_DIR="$PROJECT_DIR/db"
SOURCE_DB_PATH="$SOURCE_DB_DIR/custom.db"
TARGET_DB_DIR="$BUILD_DIR/db"
TARGET_DB_PATH="$TARGET_DB_DIR/custom.db"

mkdir -p "$TARGET_DB_DIR"

if [ -f "$SOURCE_DB_PATH" ]; then
    echo "🗄️  复制 Preview 数据库到构建产物..."
    cp -a "$SOURCE_DB_DIR/." "$TARGET_DB_DIR/"
else
    echo "ℹ️  未找到 Preview 数据库 db/custom.db，将初始化空的生产数据库"
fi

echo "🗄️  同步构建产物中的数据库结构..."
(
    cd "$PROJECT_DIR"
    DATABASE_URL="file:$TARGET_DB_PATH" bun run db:push
)

if [ ! -f "$TARGET_DB_PATH" ]; then
    echo "❌ 数据库初始化命令执行成功，但未生成 $TARGET_DB_PATH"
    exit 1
fi

echo "✅ 构建产物数据库已准备完成"
ls -lah "$TARGET_DB_DIR"
