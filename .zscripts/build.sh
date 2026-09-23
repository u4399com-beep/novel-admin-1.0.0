#!/bin/bash

# 将 stderr 重定向到 stdout，避免 execute_command 因为 stderr 输出而报错
exec 2>&1

set -e

# 获取脚本所在目录（.zscripts 目录，即 workspace-agent/.zscripts）
# 使用 $0 获取脚本路径（兼容 sh 和 bash）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 项目路径
PROJECT_DIR="/home/z/my-project"

if [ ! -d "$PROJECT_DIR" ]; then
    echo "❌ 错误: 项目目录不存在: $PROJECT_DIR"
    exit 1
fi

echo "🚀 开始构建 Go 应用（Task 27 起：全栈 Go 单栈，Next.js 已拆除）..."
echo "📁 项目路径: $PROJECT_DIR"

cd "$PROJECT_DIR" || exit 1

export NEXT_TELEMETRY_DISABLED=1

BUILD_DIR="/tmp/build_fullstack_$BUILD_ID"
echo "📁 清理并创建构建目录: $BUILD_DIR"
mkdir -p "$BUILD_DIR"

# 安装依赖（bun lockfile + scripts/build-go.sh 需要 bun 运行 CSS 构建）
echo "📦 安装依赖..."
bun install

# 构建 Go 应用：backend-go.bin（页面 SSR + API + runner，:3000）+
#               scraper-go.bin（采集引擎，:3030）+ Tailwind CSS 产物
echo "🔨 构建 Go 应用..."
bun run build

# 校验产物完整性（部署成功率守卫，对齐原 standalone 校验语义）
if [ ! -f "mini-services/backend-go/backend-go.bin" ] || [ ! -f "mini-services/scraper-go/scraper-go.bin" ]; then
    echo "❌ 构建失败：Go 二进制缺失（backend-go.bin / scraper-go.bin），请检查上方构建日志。"
    exit 1
fi
if [ ! -d "mini-services/backend-go/web/templates" ]; then
    echo "❌ 构建失败：backend-go web 模板目录缺失（模板为磁盘加载，部署产物必须携带 web/）。"
    exit 1
fi
echo "✅ Go 构建产物校验通过"

# Python 不继承 workspace-agent 的 /home/z/.venv。若项目包含 Python 源码或
# 依赖清单，在构建期将生产依赖固化到产物，并保持 Python 源码的项目相对路径。
# （scraper-go 的 render 策略调用 python playwright 渲染，保留原逻辑）
PROJECT_DIR="$PROJECT_DIR" BUILD_DIR="$BUILD_DIR" \
    sh "$SCRIPT_DIR/python-runtime-build.sh" 2>/dev/null || echo "ℹ️  python-runtime-build 跳过/不可用"

# 将所有构建产物复制到临时构建目录
echo "📦 收集构建产物到 $BUILD_DIR..."

# backend-go：二进制 + web 模板/静态资源 + 运行脚本
mkdir -p "$BUILD_DIR/backend-go"
cp mini-services/backend-go/backend-go.bin "$BUILD_DIR/backend-go/"
cp -r mini-services/backend-go/web "$BUILD_DIR/backend-go/web"
cp mini-services/backend-go/run.sh "$BUILD_DIR/backend-go/run.sh"
chmod +x "$BUILD_DIR/backend-go/run.sh"

# scraper-go：二进制 + 运行脚本
mkdir -p "$BUILD_DIR/scraper-go"
cp mini-services/scraper-go/scraper-go.bin "$BUILD_DIR/scraper-go/"
[ -f mini-services/scraper-go/run.sh ] && cp mini-services/scraper-go/run.sh "$BUILD_DIR/scraper-go/run.sh" && chmod +x "$BUILD_DIR/scraper-go/run.sh"

# 数据库目录占位（DB_PATH 由部署环境注入；种子已 go:embed 进二进制，空库自动播种）
mkdir -p "$BUILD_DIR/db"

# 启动脚本
cp "$SCRIPT_DIR/start.sh" "$BUILD_DIR/start.sh"
chmod +x "$BUILD_DIR/start.sh"

echo ""
echo "✅ 构建完成，产物位于: $BUILD_DIR"
ls -lah "$BUILD_DIR"
