# 🚀 小说阁 - 部署指南 v6.0

> **Novel Admin Platform — 完整部署与运维文档**
> 面向运维人员与开发者，涵盖从零部署到生产调优全流程。

---

## 目录

1. [快速开始](#1-快速开始)
2. [手动安装](#2-手动安装)
3. [Docker 部署](#3-docker-部署)
4. [生产环境清单](#4-生产环境清单)
5. [采集规则管理](#5-采集规则管理)
6. [速率校准](#6-速率校准)
7. [反爬调优](#7-反爬调优)
8. [故障排查](#8-故障排查)
9. [性能调优](#9-性能调优)
10. [架构图](#10-架构图)
11. [数据备份与恢复](#11-数据备份与恢复)
12. [更新升级](#12-更新升级)
13. [日常运维](#13-日常运维)

---

## 1. 快速开始

### 一键安装 (裸机/Bun)

```bash
# 远程安装
curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install.sh | bash

# 或本地安装
bash install.sh
```

**自动完成：** 环境检查 → 代码获取 → 依赖安装 → .env配置 → 数据库初始化 → 规则导入 → 构建启动 → 健康检查

### 一键安装 (Docker)

```bash
# 海外
bash <(curl -fsSL https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install-docker.sh)

# 国内 (自动加速)
bash <(curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/u4399com-beep/novel-admin-1.0.0/main/install-docker.sh)
```

### 安装选项

| 选项 | 说明 |
|------|------|
| `--skip-env` | 跳过 .env 交互配置 |
| `--skip-deps` | 跳过依赖安装 |
| `--production` | 生产模式（构建+启动） |
| `--port PORT` | 自定义端口（默认3000） |
| `--dir DIR` | 自定义安装目录 |
| `-y / --yes` | 自动接受所有提示 |

---

## 2. 手动安装

### 2.1 系统要求

| 项目 | 最低 | 推荐 |
|------|------|------|
| OS | Ubuntu 20.04+ / Debian 11+ | Ubuntu 22.04/24.04 |
| CPU | 1 核 | 2+ 核 |
| RAM | 1.5 GB | 4 GB |
| Disk | 10 GB | 40 GB SSD |
| Node.js | 20+ | 22 LTS |
| Bun | 1.x | 最新 |

### 2.2 安装步骤

```bash
# 1. 安装 Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 Bun
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# 3. 克隆项目
git clone https://github.com/u4399com-beep/novel-admin-1.0.0.git
cd novel-admin-1.0.0

# 4. 安装依赖
bun install
(cd mini-services/scraper-service && bun install)
(cd mini-services/log-stream-service && bun install)

# 5. 配置环境
cp .env.example .env
# 编辑 .env，设置所有必填项（见下方）

# 6. 生成 Prisma Client
bun run db:generate

# 7. 初始化数据库
bun run db:push

# 8. 构建应用
bun run build

# 9. 启动服务
bun start
```

### 2.3 环境变量配置

**必填项** — 不设置将导致启动失败：

```bash
# 认证密钥（至少32字符）
NEXTAUTH_SECRET=$(openssl rand -hex 32)

# 管理员账号
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的强密码至少8位

# 服务间通信令牌（与NEXTAUTH_SECRET不同）
SCRAPER_SERVICE_TOKEN=$(openssl rand -hex 32)

# 数据库连接
DATABASE_URL="file:./db/custom.db"    # SQLite (开发)
# DATABASE_URL="postgresql://user:pass@host:5432/db"  # PostgreSQL (生产)
```

**可选项**：

```bash
SCRAPER_SERVICE_URL="http://localhost:3099"
NEXT_PUBLIC_APP_NAME="小说管理系统"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
DB_PROVIDER="sqlite"   # 或 "postgresql"

# 外部采集服务
FIRECRAWL_API_KEY=""
AGENTQL_API_KEY=""
BROWSERLESS_API_KEY=""
```

---

## 3. Docker 部署

### 3.1 单容器模式 (推荐入门)

使用 `docker-compose.yml` (原有)，所有服务运行在单个容器中：

```bash
# 使用 quick-docker.sh
chmod +x quick-docker.sh && ./quick-docker.sh

# 或手动
cp .env.docker .env
# 编辑 .env 替换所有 change-this
docker compose up -d --build
```

**架构**：1容器 = Next.js + Scraper + 1 PostgreSQL 容器

### 3.2 多容器模式 (推荐生产)

使用 `docker-compose.multiservice.yml`，每个服务独立容器：

```bash
# 使用 install-docker.sh (自动)
bash install-docker.sh

# 或手动
cp .env.docker .env
# 编辑 .env
docker compose -f docker-compose.multiservice.yml up -d --build
```

**架构**：App容器 + Scraper容器 + LogStream容器 + PostgreSQL容器 + 可选Gateway

**优势**：
- 独立扩缩容：可单独增加 scraper 实例
- 独立重启：更新 scraper 不影响主站
- 资源隔离：内存/CPU 限制各自独立
- 健康检查：每个服务独立健康状态

### 3.3 服务端口映射

| 服务 | 容器内端口 | 对外暴露 | 说明 |
|------|-----------|---------|------|
| app | 3000 | 3000 | 主Web应用 |
| scraper-service | 3099 | 不暴露(内部) | 采集引擎 |
| log-stream | 3004 | 不暴露(内部) | 实时日志 |
| postgres | 5432 | 不暴露(内部) | 数据库 |
| gateway | 80/443 | 80/443 | 反向代理 |

### 3.4 反向代理 (Caddy)

启用 HTTPS 和自动证书：

```bash
# 1. 编辑 Caddyfile，替换 your-domain.com
nano Caddyfile

# 2. 在 docker-compose.multiservice.yml 中取消 gateway 注释

# 3. 重启
docker compose -f docker-compose.multiservice.yml up -d
```

也可使用 Nginx：

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3004;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## 4. 生产环境清单

部署到公网前，**务必完成以下检查**：

### 安全

- [ ] 更改所有默认密码和密钥（NEXTAUTH_SECRET, ADMIN_PASSWORD, SCRAPER_SERVICE_TOKEN）
- [ ] ADMIN_PASSWORD 至少 12 位，包含大小写+数字+特殊字符
- [ ] 启用 HTTPS（Caddy/Nginx + Let's Encrypt）
- [ ] 关闭数据库端口外部访问（不暴露 5432）
- [ ] 设置 `DB_PROVIDER=postgresql`（SQLite 不适合生产并发）
- [ ] 配置防火墙（只开放 80/443）
- [ ] .env 文件权限设为 600：`chmod 600 .env`

### 可靠性

- [ ] 配置自动重启：`restart: unless-stopped`（已默认）
- [ ] 设置数据库自动备份（见 [备份章节](#11-数据备份与恢复)）
- [ ] 配置 swap（1GB 服务器建议 2GB swap）
- [ ] 监控磁盘空间（数据库+日志会持续增长）

### 性能

- [ ] 根据服务器内存选择正确档位（tiny/small/normal）
- [ ] 使用 SSD 存储（数据库性能关键）
- [ ] 配置反向代理压缩（gzip/brotli）

### 监控

- [ ] 设置健康检查告警
- [ ] 配置日志轮转（已默认 json-file + max-size）
- [ ] 可选：接入 Prometheus/Grafana

---

## 5. 采集规则管理

### 5.1 规则文件位置

```
mini-services/scraper-service/src/scrape-rules/
├── 69shuba.json          # 69书吧
├── biqugse.json          # 笔趣阁
├── biquwx.json           # 笔趣文学
├── piaotia.json          # 飘天文学
├── ptwxz.json            # 晋江/品图网
├── hetushu.json          # 和图书
├── fanqie-api.json       # 番茄API
├── qimao-api.json        # 七猫API
├── engine-preferences.json  # 引擎偏好配置
└── ... (40+ 规则文件)
```

### 5.2 添加新规则

**方式 A：通过管理后台（推荐）**

1. 登录管理后台 → 采集规则 → 添加
2. 填写规则 JSON（可参考已有规则）
3. 点击测试验证规则正确性
4. 保存并启用

**方式 B：添加规则文件**

1. 在 `src/scrape-rules/` 目录创建新 JSON 文件
2. 参考现有规则格式编写（见下方模板）
3. 重启 scraper-service

**规则模板**：

```json
{
  "name": "示例书站",
  "baseUrl": "https://example.com",
  "searchUrl": "https://example.com/search?q={keyword}",
  "listRule": {
    "container": ".book-list > li",
    "title": "h3 a",
    "author": ".author",
    "url": "h3 a@href",
    "cover": "img@src"
  },
  "detailRule": {
    "title": "h1",
    "author": ".info span:nth(1)",
    "description": ".intro",
    "cover": ".cover img@src",
    "chapterList": ".chapter-list a",
    "chapterUrl": "a@href"
  },
  "contentRule": {
    "title": "h1",
    "content": "#content",
    "nextPage": ".next-page@href"
  },
  "encoding": "utf-8",
  "rateLimit": {
    "requestInterval": 2000,
    "concurrent": 1
  }
}
```

### 5.3 引擎偏好配置

`engine-preferences.json` 控制各引擎的优先级和策略：

```json
{
  "defaults": {
    "enginePriority": ["cheerio", "playwright", "agentql", "firecrawl"],
    "retryWithNextEngine": true,
    "maxRetries": 3
  },
  "overrides": {
    "fanqie-api": { "enginePriority": ["api"] },
    "qimao-api": { "enginePriority": ["api"] }
  }
}
```

---

## 6. 速率校准

### 6.1 速率限制配置

每个采集规则可以独立配置速率：

```json
{
  "rateLimit": {
    "requestInterval": 2000,    // 请求间隔(ms)
    "concurrent": 1,            // 并发数
    "burstSize": 3,             // 突发请求数
    "cooldownAfterBurst": 10000 // 突发后冷却(ms)
  }
}
```

### 6.2 校准流程

1. **初始测试**：设置保守参数（interval=3000, concurrent=1）
2. **逐步加压**：每次减少 500ms 间隔，监控成功率
3. **标记阈值**：当成功率 < 95% 时，回退到上一个参数
4. **生产设置**：在阈值基础上增加 20% 安全裕度

### 6.3 自适应延迟

scraper-service 内置 `adaptive-delay` 模块，根据响应自动调节：

- 检测到 429/503 → 自动增加间隔
- 连续成功 → 逐步降低间隔（不低于配置最小值）
- 检测到验证码 → 暂停并通知

---

## 7. 反爬调优

### 7.1 反检测策略

系统内置多层反检测机制：

| 层级 | 机制 | 配置 |
|------|------|------|
| TLS | 指纹模拟 (Chrome-like) | 自动 |
| HTTP/2 | 连接复用+多路复用 | 自动 |
| 请求头 | 随机UA + 顺序随机化 | 自动 |
| Cookie | 智能管理 + 持久化 | 自动 |
| 行为 | 鼠标轨迹模拟 (Playwright) | 自动 |
| IP | 代理轮换 | proxy-config.json |
| 频率 | 自适应延迟 | rateLimit in rules |

### 7.2 代理配置

编辑 `mini-services/scraper-service/proxy-config.json`：

```json
{
  "enabled": false,
  "providers": [
    {
      "type": "socks5",
      "host": "127.0.0.1",
      "port": 1080,
      "username": "",
      "password": ""
    }
  ],
  "rotation": "round-robin",
  "testUrl": "https://httpbin.org/ip",
  "testInterval": 300000
}
```

### 7.3 爬虫信号检测

`anti-crawl-signal-detector` 自动检测：

- **频率限制**：429/503 响应码
- **验证码**：HTML 关键词检测
- **IP封禁**：403 + 特定页面特征
- **蜜罐链接**：隐藏链接陷阱
- **行为分析**：异常重定向链

检测到信号后，`anti-crawl-advisor` 给出建议：

1. 增加请求间隔
2. 切换代理
3. 启用 Playwright 引擎
4. 暂停该规则

---

## 8. 故障排查

### 8.1 常见问题

#### 容器启动失败

```bash
# 查看详细日志
docker compose logs --tail=100

# 检查 .env 配置
grep "change-this" .env  # 应无输出

# 检查 Docker 资源
docker system df
```

#### 数据库连接失败

```bash
# 检查 PostgreSQL 状态
docker compose ps postgres

# 测试连接
docker compose exec postgres pg_isready -U novel -d novel_admin

# 常见原因：
# - POSTGRES_PASSWORD 不匹配
# - 磁盘空间不足: df -h
# - 内存不足: free -h
```

#### 应用 OOM (内存不足)

```bash
# 查看容器内存使用
docker stats

# 解决：
# 1. 降低档位参数
# 2. 增加 swap
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile

# 3. 增加容器内存限制
# 编辑 .env: APP_MEMORY_LIMIT=2048M
```

#### 端口冲突

```bash
# 查看端口占用
ss -tlnp | grep 3000
lsof -i :3000

# 修改端口
# .env: APP_PORT=8080
docker compose up -d
```

#### Scraper 服务无响应

```bash
# 检查 scraper 进程
docker compose exec novel-app ps aux | grep bun

# 查看 scraper 日志
docker compose exec novel-app cat /app/data/logs/scraper-service.log

# 手动测试
curl http://localhost:3099/health
```

### 8.2 日志位置

| 场景 | 位置 |
|------|------|
| Docker 日志 | `docker compose logs -f` |
| App 日志 (容器内) | `/app/app.log` |
| Scraper 日志 (容器内) | `/app/data/logs/scraper-service.log` |
| 入口脚本调试 | `/app/data/entrypoint-debug.log` |
| 开发模式 | `dev.log` / `server.log` |

### 8.3 健康检查端点

```bash
# 应用健康 (需认证)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/health

# CSRF 端点 (无需认证，用于存活检查)
curl http://localhost:3000/api/auth/csrf

# Scraper 健康
curl http://localhost:3099/health
```

---

## 9. 性能调优

### 9.1 内存档位

| 档位 | RAM | PG Limit | App Limit | 适用 |
|------|-----|----------|-----------|------|
| tiny | <1.5G | 128M | 512M | 1核1G 入门 |
| small | 1.5-3G | 192M | 640M | 2核2G 主流 |
| normal | 3G+ | 256M | 1024M | 2核4G+ 推荐 |

自动检测：`install-docker.sh` 和 `quick-docker.sh` 会根据可用内存选择。

手动切换：编辑 `.env`，取消注释对应档位的参数。

### 9.2 采集并发调优

```bash
# 全局并发限制 (在 scraper-service 环境变量中)
MAX_CONCURRENT_TASKS=5          # 最大同时采集任务数
MAX_CONCURRENT_CHAPTERS=3       # 每个任务的章节并发数
CHAPTER_BATCH_SIZE=10           # 每批下载章节数
```

### 9.3 数据库调优

```bash
# PostgreSQL 关键参数 (在 .env 中)
PG_SHARED_BUFFERS=128MB        # 共享缓冲区 (建议 RAM 的 25%)
PG_WORK_MEM=8MB                # 排序/哈希内存
PG_EFFECTIVE_CACHE_SIZE=256MB  # 操作系统缓存估计
PG_MAX_CONNECTIONS=30          # 连接数 (按需调整)
```

### 9.4 Next.js 调优

```bash
# 构建时
NODE_MAX_OLD_SPACE_SIZE=1024   # V8 堆上限 (MB)
NEXT_WORKER_THREADS=1          # 构建线程 (低内存设1)

# 运行时
NODE_OPTIONS="--max-old-space-size=256"  # 运行时 V8 堆
```

---

## 10. 架构图

### 单容器架构 (默认)

```
┌──────────────────────────────────────────────────────┐
│                 novel-manager (容器)                  │
│                                                      │
│  ┌────────────────┐    ┌─────────────────────────┐  │
│  │   Next.js App  │    │    Scraper Service      │  │
│  │   (port 3000)  │◄──►│    (port 3099, 内部)    │  │
│  └───────┬────────┘    └───────────┬─────────────┘  │
│          │                         │                 │
│          └───────────┬─────────────┘                 │
│                      │ Prisma Client                 │
│                      │ SQLite Queue                  │
└──────────────────────┼──────────────────────────────┘
                       │
┌──────────────────────┼──────────────────────────────┐
│              novel-postgres (容器)                    │
│                      │                              │
│              PostgreSQL 17                          │
│              (port 5432, 内部)                      │
│              Volume: postgres-data                  │
└─────────────────────────────────────────────────────┘

外部访问: 用户浏览器 ──► port 3000 ──► Next.js App
```

### 多容器架构 (生产)

```
                    ┌──────────────┐
                    │    用户      │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Gateway    │  (Caddy, 可选)
                    │  80/443 SSL  │
                    └──────┬───────┘
                           │
        ┌──────────────────┼──────────────────────┐
        │           frontend network               │
        └──────────────────┼──────────────────────┘
                    ┌──────▼───────┐
                    │     App      │  Next.js
                    │   port 3000  │
                    └──┬───────┬──┘
                       │       │
        ┌──────────────┼───────┼──────────────────┐
        │            internal network               │
        └──┬──────────┼───────┼───────────────┬───┘
           │          │       │               │
    ┌──────▼──┐  ┌───▼────┐  │        ┌──────▼─────┐
    │ Scraper │  │  Log   │  │        │ PostgreSQL │
    │  :3099  │  │ Stream │  │        │   :5432    │
    │ (采集)  │  │  :3004  │  │        │  (数据库)  │
    └─────────┘  └────────┘  │        └────────────┘
                             │
                    ┌────────▼────────┐
                    │   Shared Data   │
                    │   Volume        │
                    └─────────────────┘
```

### 采集引擎架构

```
请求进入 ──► Engine Router
               │
               ├── cheerio    (轻量HTML解析, 最快)
               ├── playwright (完整浏览器, 反反爬)
               ├── firecrawl  (外部API, 付费)
               ├── agentql    (AI提取, 付费)
               └── custom API (番茄/七猫等)
               │
               ▼
         Anti-Crawl Layer
               │
               ├── TLS 指纹模拟
               ├── 请求头随机化
               ├── Cookie 智能管理
               ├── 自适应延迟
               ├── 代理轮换
               └── 验证码检测
               │
               ▼
         Content Processing
               │
               ├── 编码检测 + 转简
               ├── HTML 清洗
               ├── 内容质量评分
               └── SSRF 防护
```

---

## 11. 数据备份与恢复

### 11.1 备份数据库

```bash
# 手动备份
mkdir -p backups
docker compose exec postgres pg_dump -U novel novel_admin > backups/db_$(date +%Y%m%d_%H%M%S).sql
```

### 11.2 自动备份

```bash
cat > scripts/auto-backup.sh << 'EOF'
#!/bin/bash
DIR="/opt/novel-admin/backups"
mkdir -p "$DIR"
docker compose -f /opt/novel-admin/docker-compose.yml exec -T postgres \
  pg_dump -U novel novel_admin > "$DIR/db_$(date +%Y%m%d_%H%M%S).sql"
find "$DIR" -name "db_*.sql" -mtime +30 -delete
echo "[$(date)] Backup done"
EOF

chmod +x scripts/auto-backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/novel-admin/scripts/auto-backup.sh >> /opt/novel-admin/backups/backup.log 2>&1") | crontab -
```

### 11.3 恢复

```bash
# 停止应用（避免数据冲突）
docker compose stop app

# 恢复数据库
docker compose exec -T postgres psql -U novel novel_admin < backups/db_YYYYMMDD.sql

# 重启
docker compose start app
```

### 11.4 SQLite 备份（开发模式）

```bash
# SQLite 直接复制
cp db/custom.db backups/custom_$(date +%Y%m%d).db
```

---

## 12. 更新升级

### 12.1 Docker 升级

```bash
# 1. 备份
docker compose exec postgres pg_dump -U novel novel_admin > backups/pre_update.sql

# 2. 获取新代码
git pull origin main

# 3. 重新构建
docker compose down
docker compose up -d --build

# 4. 验证
docker compose logs -f
```

### 12.2 裸机升级

```bash
# 1. 备份数据库
cp db/custom.db db/custom.db.bak

# 2. 更新代码
git pull origin main

# 3. 更新依赖
bun install
(cd mini-services/scraper-service && bun install)

# 4. 数据库迁移
bun run db:push

# 5. 重新构建
bun run build

# 6. 重启
# Ctrl+C 停止旧进程，然后:
bun start
```

---

## 13. 日常运维

### 快速命令参考

| 操作 | 命令 |
|------|------|
| **启动** | `docker compose up -d` |
| **停止** | `docker compose stop` |
| **重启** | `docker compose restart` |
| **日志** | `docker compose logs -f` |
| **状态** | `docker compose ps` |
| **资源** | `docker stats` |
| **备份** | `docker compose exec postgres pg_dump -U novel novel_admin > bk.sql` |
| **恢复** | `docker compose exec -T postgres psql -U novel novel_admin < bk.sql` |
| **改密码** | `nano .env` → `docker compose restart` |
| **清理** | `docker system prune -a` |
| **卸载** | `docker compose down -v && rm -rf /opt/novel-admin` |

### 国内加速

```bash
# Docker Hub 镜像
echo '{"registry-mirrors":["https://docker.1ms.run","https://docker.m.daocloud.io"]}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker

# NPM 镜像
bun config set registry https://registry.npmmirror.com
```

### 开发模式

```bash
# 切换 SQLite (开发)
bash scripts/switch-to-sqlite.sh

# 切换 PostgreSQL (开发)
bash scripts/switch-to-postgres.sh

# 启动开发服务器
bun dev
```
