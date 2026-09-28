# 【已废弃·Task 27】Next.js/TS mini-services 构建链路已拆除（全栈 Go 化）。
# 现行构建：bash scripts/build-go.sh（backend-go.bin + scraper-go.bin）。
# 【Task 58 重写】bun/Prisma 残留清除：数据库 schema 由 backend-go 启动时纯 Go 自引导
# （CREATE TABLE IF NOT EXISTS + 空表播种），本脚本只剩「Preview 库随构建产物复制」。
#!/bin/bash

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/z/my-project}"
BUILD_DIR="${BUILD_DIR:?BUILD_DIR is required}"
SOURCE_DB_DIR="$PROJECT_DIR/db"
TARGET_DB_DIR="$BUILD_DIR/db"

mkdir -p "$TARGET_DB_DIR"

if [ -f "$SOURCE_DB_DIR/custom.db" ]; then
    echo "🗄️  复制 Preview 数据库到构建产物..."
    cp -a "$SOURCE_DB_DIR/." "$TARGET_DB_DIR/"
else
    echo "ℹ️  未找到 Preview 数据库 db/custom.db，将初始化空的生产数据库"
fi

echo "✅ 构建产物数据库已准备完成（schema 由 backend-go 启动自引导）"
ls -lah "$TARGET_DB_DIR"
