# 🚀 小说管理系统 - Docker 一键部署指南

> **本文档面向零基础用户**。如果遇到任何问题，重新阅读对应步骤，99% 的问题都是因为跳过了某一步。

---

## ⚡ 一键安装（推荐）

**只需要 2 条命令，3 分钟搞定：**

```bash
# 1. 确保已安装 Docker（如果没有：curl -fsSL https://get.docker.com | sh）
# 2. 执行安装脚本
chmod +x install.sh && ./install.sh
```

安装脚本会自动：
- ✅ 检测 Docker 环境
- ✅ 生成安全的随机密码和密钥
- ✅ 创建配置文件
- ✅ 构建并启动所有服务
- ✅ 等待健康检查通过
- ✅ 显示登录地址和密码

**安装完成后，按脚本输出的地址和密码登录即可使用。**

---

## 📦 打包发布

如果你想将项目打包成一个压缩包，分发给其他人部署：

```bash
chmod +x pack.sh && ./pack.sh
```

这会生成 `novel-admin-x.x.x-YYYYMMDD.tar.gz`，接收方只需：

```bash
tar xzf novel-admin-x.x.x-YYYYMMDD.tar.gz && cd novel-admin-x.x.x-*
chmod +x install.sh && ./install.sh
```

---

## 目录

1. [一键安装（推荐）](#-一键安装推荐)
2. [打包发布](#-打包发布)
3. [你需要准备什么](#3-你需要准备什么)
4. [安装 Docker](#4-安装-docker)
5. [获取项目文件](#5-获取项目文件)
6. [配置环境变量（手动模式）](#6-配置环境变量手动模式)
7. [一键启动](#7-一键启动)
8. [访问系统](#8-访问系统)
9. [日常操作](#9-日常操作)
10. [常见问题排查](#10-常见问题排查)
11. [数据备份与恢复](#11-数据备份与恢复)
12. [更新升级](#12-更新升级)
13. [完全卸载](#13-完全卸载)
14. [开发模式切换（SQLite）](#14-开发模式切换sqlite)

---

## 3. 你需要准备什么

### 3.1 一台服务器

你需要一台 Linux 服务器（推荐 Ubuntu 22.04 或 24.04，Debian 11/12 也可以）。

**最低配置：**
- CPU：1 核
- 内存：1 GB（推荐 2 GB）
- 硬盘：10 GB

**推荐配置：**
- CPU：2 核
- 内存：4 GB
- 硬盘：40 GB SSD

> 💡 如果只是自己用（管理几十本小说），最低配置就够。如果需要大量采集，用推荐配置。

### 3.2 你需要知道的信息

- 服务器的 **IP 地址**（比如 `192.168.1.100` 或者公网 IP）
- 如果是云服务器，知道 **root 密码** 或能 SSH 登录

---

## 4. 安装 Docker

> Docker 是一个容器运行工具。你可以把它理解为一个「迷你虚拟机」，
> 我们的应用程序会运行在里面，不会弄乱你的服务器。

### 4.1 连接到你的服务器

打开你的电脑上的终端（Mac/Linux 直接打开终端，Windows 打开 PowerShell 或 CMD）：

```bash
# 把下面的 your_server_ip 换成你服务器的实际 IP 地址
ssh root@your_server_ip
# 然后输入密码（输入时不会显示任何字符，这是正常的，输完按回车就行）
```

### 4.2 一键安装 Docker

```bash
# 复制这整行，粘贴到终端，按回车
curl -fsSL https://get.docker.com | sh
```

这个命令会自动下载并安装 Docker，大概需要 1-3 分钟（取决于服务器网速）。

看到类似 `Docker installed successfully` 的提示就说明安装成功了。

### 4.3 启动 Docker 并设置开机自启

```bash
# 启动 Docker 服务
systemctl start docker

# 设置 Docker 开机自动启动（服务器重启后也会自动运行）
systemctl enable docker

# 验证 Docker 是否安装成功
docker --version
```

如果看到类似 `Docker version 2x.x.x` 的输出，说明安装成功！

### 4.4 安装 Docker Compose

```bash
# 新版 Docker 已经自带 docker compose（注意没有横杠），验证一下：
docker compose version
```

如果看到类似 `Docker Compose version v2.x.x`，说明已经有了。如果没有：

```bash
# 手动安装 Docker Compose 插件
apt-get update && apt-get install -y docker-compose-plugin
```

---

## 5. 获取项目文件

### 5.1 创建项目目录

```bash
# 在服务器上创建一个目录来存放项目文件
mkdir -p /opt/novel-admin
cd /opt/novel-admin
```

> 📁 `/opt/novel-admin` 就是你项目的"家"。所有文件都放这里。

### 5.2 上传项目文件

把项目文件上传到服务器的 `/opt/novel-admin/` 目录。

**方法 A：使用 SCP（命令行）**

在你自己的电脑上（不是服务器上），打开终端：

```bash
# 把 /path/to/project/ 换成你本地项目文件的实际路径
# 把 your_server_ip 换成你服务器的 IP
# 把项目文件打包上传
cd /path/to/project/
tar czf novel-admin.tar.gz --exclude=node_modules --exclude=.next --exclude=.git --exclude=db/*.db .
scp novel-admin.tar.gz root@your_server_ip:/opt/novel-admin/
```

然后在服务器上解压：

```bash
cd /opt/novel-admin
tar xzf novel-admin.tar.gz
rm novel-admin.tar.gz
```

**方法 B：使用 FTP 工具（推荐新手）**

下载 [FileZilla](https://filezilla-project.org/)（免费开源的 FTP 工具）：
1. 打开 FileZilla
2. 主机：`sftp://你的服务器IP`
3. 用户名：`root`
4. 密码：你的服务器密码
5. 端口：`22`
6. 点击「快速连接」
7. 把左侧（你电脑）的项目文件，全部拖到右侧的 `/opt/novel-admin/` 目录

> ⚠️ 上传时**不要**上传 `node_modules` 文件夹（太大了，几百MB），Docker 会自动安装依赖。
> ⚠️ 上传时**不要**上传 `.env` 文件（包含敏感信息），我们下一步会新建。

---

## 6. 配置环境变量（手动模式）

> 这一步配置系统的密码、数据库密码、密钥等。
> **每个 "change-this" 都必须改成你自己的值！**
> 如果不改，系统会拒绝启动（这是安全保护）。

### 6.1 生成随机密钥

在服务器上执行以下命令，生成两个随机字符串：

```bash
# 生成第 1 个随机密钥（用于 NEXTAUTH_SECRET）
echo "=== 第1个密钥 (NEXTAUTH_SECRET) ==="
openssl rand -hex 32

# 生成第 2 个随机密钥（用于 SCRAPER_SERVICE_TOKEN）
echo "=== 第2个密钥 (SCRAPER_SERVICE_TOKEN) ==="
openssl rand -hex 32

# 生成数据库密码
echo "=== 数据库密码 (POSTGRES_PASSWORD) ==="
openssl rand -hex 16
```

你会看到类似这样的输出：

```
=== 第1个密钥 (NEXTAUTH_SECRET) ===
a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
=== 第2个密钥 (SCRAPER_SERVICE_TOKEN) ===
f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f1e2
=== 数据库密码 (POSTGRES_PASSWORD) ===
1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

**把这三行密钥复制保存到记事本里，后面要用！**

> 💡 如果 `openssl` 命令不可用，也可以用这个方法：
> ```bash
> head -c 64 /dev/urandom | base64 | head -c 64
> ```

### 6.2 创建配置文件

```bash
cd /opt/novel-admin

# 从模板复制一份配置文件
cp .env.production .env
```

### 6.3 编辑配置文件

```bash
# 使用 nano 编辑器打开配置文件（新手推荐，比 vim 简单）
nano .env
```

你会看到配置文件的内容。找到每个 `change-this`，替换成你刚才生成的值：

```ini
# ─── 数据库密码 ───
# 把 change-this-to-a-strong-db-password-16chars 换成你刚才生成的「数据库密码」
POSTGRES_PASSWORD=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d

# ─── 应用端口 ───
# 默认 3000，如果你服务器上 3000 端口被占用了，改成别的（比如 8080）
APP_PORT=3000

# ─── 应用地址 ───
# 如果你有域名（比如 example.com），改成 https://example.com
# 如果没有域名，用服务器的 IP：http://你的服务器IP:3000
APP_URL=http://192.168.1.100:3000

# ─── 登录密钥 ───
# 把 change-this-to-a-random-secret... 换成你生成的「第1个密钥」
NEXTAUTH_SECRET=a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5...

# ─── 管理员账号 ───
# 改成你想用的用户名
ADMIN_USERNAME=admin
# 改成你想用的密码（至少8位，建议用强密码）
ADMIN_PASSWORD=MyStr0ngP@ssw0rd!

# ─── 服务间通信密钥 ───
# 把 change-this-to-another-random-string... 换成你生成的「第2个密钥」
SCRAPER_SERVICE_TOKEN=f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5...
```

**修改完后保存退出：**
- 按 `Ctrl + O`（字母O，不是数字0）→ 保存
- 按 `Enter` → 确认文件名
- 按 `Ctrl + X` → 退出编辑器

### 6.4 验证配置

```bash
# 检查是否还有 change-this 没有改掉（如果有，说明漏了）
grep "change-this" .env

# 如果上面的命令没有任何输出，说明全部改好了！✓
# 如果有输出，用 nano .env 重新编辑，把漏掉的改掉
```

---

## 7. 一键启动

### 7.1 构建并启动

```bash
cd /opt/novel-admin

# 一键构建并启动所有服务（第一次大概需要 5-10 分钟）
docker compose up -d --build
```

这个命令会做以下事情（全自动，你只需要等）：
1. 下载基础镜像（Bun 运行时 + PostgreSQL）
2. 安装所有依赖包
3. 编译 Next.js 前端
4. 编译 Scraper 采集服务
5. 启动 PostgreSQL 数据库
6. 等待数据库就绪
7. 创建数据表
8. 启动采集服务
9. 启动 Web 应用

> ⏱️ **第一次构建大约需要 5-10 分钟**，取决于服务器性能和网络速度。
> 后续重启只需要几秒钟（因为镜像已经构建好了）。

### 7.2 查看启动日志

```bash
# 实时查看日志（按 Ctrl+C 退出查看，不会停止服务）
docker compose logs -f
```

当你看到类似下面的输出时，说明启动成功了：

```
[DB] PostgreSQL is ready!
[DB] Schema sync completed successfully.
[DB] Database initialization complete.
[Scraper] Service started successfully.
[App] Starting Next.js application on port 3000...
==========================================
  ✓ System is running!
  App:     http://0.0.0.0:3000
  Scraper: http://localhost:3099
  DB:      PostgreSQL
==========================================
```

### 7.3 检查服务状态

```bash
# 查看容器状态（应该都是 Up 状态）
docker compose ps
```

你应该看到两个容器都在运行：

```
NAME              STATUS          PORTS
novel-manager     Up (healthy)    0.0.0.0:3000->3000/tcp
novel-postgres    Up (healthy)    0.0.0.0:5432->5432/tcp
```

如果 novel-manager 的 STATUS 显示 `health: starting`，等 30 秒再看，它需要时间做健康检查。

---

## 8. 访问系统

### 8.1 打开浏览器

在你自己的电脑上，打开浏览器（Chrome / Edge / Firefox 都行），输入：

```
http://你的服务器IP:3000
```

比如你的服务器 IP 是 `192.168.1.100`：

```
http://192.168.1.100:3000
```

### 8.2 登录

- **用户名**：你在 `.env` 里设置的 `ADMIN_USERNAME`（默认 `admin`）
- **密码**：你在 `.env` 里设置的 `ADMIN_PASSWORD`

### 8.3 如果打不开？

**情况 A：页面加载不出来（超时）**

这是防火墙的问题。你需要开放 3000 端口：

```bash
# 如果是云服务器（阿里云、腾讯云、AWS 等）：
#   → 去云服务商的「安全组」或「防火墙规则」页面
#   → 添加一条入站规则：TCP 端口 3000，允许所有 IP (0.0.0.0/0)

# 如果是自建服务器，执行：
ufw allow 3000/tcp
# 或者（如果是 firewalld）：
firewall-cmd --permanent --add-port=3000/tcp
firewall-cmd --reload
```

**情况 B：连接被拒绝**

```bash
# 检查容器是否在运行
docker compose ps

# 如果没有运行，查看错误日志
docker compose logs
```

---

## 9. 日常操作

### 9.1 停止服务

```bash
cd /opt/novel-admin

# 停止但保留数据
docker compose stop

# 停止并删除容器（数据不会丢失，因为用了 volume）
docker compose down
```

### 9.2 启动服务

```bash
cd /opt/novel-admin

# 启动已有容器（不重新构建）
docker compose start

# 如果删过容器了，重新创建并启动
docker compose up -d
```

### 9.3 重启服务

```bash
cd /opt/novel-admin
docker compose restart
```

### 9.4 查看日志

```bash
# 查看所有日志
docker compose logs

# 只看最近的 100 行
docker compose logs --tail=100

# 实时跟踪日志（Ctrl+C 退出）
docker compose logs -f

# 只看应用的日志（不看数据库的）
docker compose logs novel-manager

# 只看数据库的日志
docker compose logs postgres
```

### 9.5 修改配置后重启

```bash
# 1. 编辑配置
nano .env

# 2. 重启（配置文件修改需要 recreate 容器）
docker compose up -d
```

---

## 10. 常见问题排查

### 8.1 容器一直重启

```bash
# 查看为什么重启
docker compose logs --tail=50 novel-manager
```

**常见原因：**
- `.env` 中还有 `change-this` 没改 → 改掉后 `docker compose up -d`
- `NEXTAUTH_SECRET` 太短（少于32字符）→ 改长一点
- 数据库密码不对 → 确保 `.env` 中 `POSTGRES_PASSWORD` 是你设置的值

### 8.2 数据库连接失败

```bash
# 检查数据库容器是否健康
docker compose ps postgres

# 如果不健康，查看数据库日志
docker compose logs postgres

# 常见原因：磁盘空间不足
df -h
# 如果使用率超过 90%，需要清理磁盘
```

### 8.3 忘记管理员密码

```bash
# 编辑 .env，修改 ADMIN_PASSWORD
nano .env
# 改完后重启
docker compose restart novel-manager
```

### 8.4 磁盘空间不足

```bash
# 查看磁盘使用情况
df -h

# 清理无用的 Docker 镜像和缓存（安全操作，不会删除数据）
docker system prune -a

# 查看 Docker 占用空间
docker system df
```

### 8.5 端口被占用

```bash
# 查看哪个进程占用了 3000 端口
lsof -i :3000

# 方法 1：停掉占用端口的进程
kill <PID>

# 方法 2：修改 .env 中的 APP_PORT 为其他端口（比如 8080）
nano .env
# 改完后
docker compose up -d
```

---

## 11. 数据备份与恢复

> 你的数据（小说、章节、采集规则等）存储在两个地方：
> 1. **PostgreSQL 数据库** → 存小说、章节、规则等结构化数据
> 2. **app-data 卷** → 存封面图片、下载文件等

### 9.1 备份数据库

```bash
# 创建备份目录
mkdir -p /opt/novel-admin/backups

# 备份数据库（会生成一个 .sql 文件）
# 把 novel_admin 换成你 POSTGRES_DB 的值（默认就是 novel_admin）
# 把 novel 换成你 POSTGRES_USER 的值（默认就是 novel）
docker compose exec postgres pg_dump -U novel novel_admin > /opt/novel-admin/backups/db_$(date +%Y%m%d_%H%M%S).sql

# 验证备份文件存在
ls -lh /opt/novel-admin/backups/
```

**设置自动备份（每天凌晨3点）：**

```bash
# 创建定时备份脚本
cat > /opt/novel-admin/scripts/auto-backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/novel-admin/backups"
mkdir -p "$BACKUP_DIR"
docker compose -f /opt/novel-admin/docker-compose.yml exec -T postgres \
  pg_dump -U novel novel_admin > "$BACKUP_DIR/db_$(date +%Y%m%d_%H%M%S).sql"
# 只保留最近 30 天的备份
find "$BACKUP_DIR" -name "db_*.sql" -mtime +30 -delete
echo "[$(date)] Backup completed"
EOF

chmod +x /opt/novel-admin/scripts/auto-backup.sh

# 添加到 crontab（每天凌晨 3 点执行）
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/novel-admin/scripts/auto-backup.sh >> /opt/novel-admin/backups/backup.log 2>&1") | crontab -
```

### 9.2 恢复数据库

```bash
# 找到你的备份文件
ls /opt/novel-admin/backups/

# 恢复（把 db_20250101_030000.sql 换成你的实际文件名）
docker compose exec -T postgres psql -U novel novel_admin < /opt/novel-admin/backups/db_20250101_030000.sql
```

### 9.3 备份文件数据

```bash
# 备份封面图和下载文件
mkdir -p /opt/novel-admin/backups
docker cp novel-manager:/app/data /opt/novel-admin/backups/data_$(date +%Y%m%d)
```

---

## 12. 更新升级

当你收到新版本的项目文件时，按以下步骤更新：

### 10.1 备份（重要！）

```bash
cd /opt/novel-admin

# 备份数据库
mkdir -p backups
docker compose exec postgres pg_dump -U novel novel_admin > backups/db_before_update_$(date +%Y%m%d_%H%M%S).sql
```

### 10.2 更新文件

```bash
# 停止旧版本
docker compose down

# 用新文件覆盖（方法同第 3 步的上传）
# ... 上传新文件到 /opt/novel-admin/ ...
```

### 10.3 重新构建并启动

```bash
cd /opt/novel-admin

# 重新构建并启动
docker compose up -d --build

# 查看日志确认正常
docker compose logs -f
```

### 10.4 数据库迁移

如果新版本修改了数据库结构（通常发布说明会提到）：

```bash
# Prisma 会自动处理大部分变更
docker compose exec novel-manager bunx prisma db push
```

---

## 13. 完全卸载

> ⚠️ 以下操作会**删除所有数据**（数据库、小说、配置全部清除）！

```bash
cd /opt/novel-admin

# 停止并删除所有容器、网络
docker compose down

# 删除所有数据卷（数据库数据、文件数据全部删除）
docker compose down -v

# 删除 Docker 镜像
docker rmi $(docker images -q --filter "reference=*novel*") 2>/dev/null
docker image prune -f

# 删除项目文件
cd /opt
rm -rf /opt/novel-admin
```

---

## 14. 开发模式切换（SQLite）

如果你想在本地电脑上开发/调试，使用 SQLite 会更方便（不需要装 PostgreSQL）。

### 12.1 切换到 SQLite（开发模式）

```bash
# 在项目根目录执行
bash scripts/switch-to-sqlite.sh
```

这个脚本会自动：
1. 把 `prisma/schema.prisma` 的 provider 改为 `sqlite`
2. 把 `.env` 中的 `DATABASE_URL` 改为 SQLite 路径
3. 把 scraper 的队列模块切换回 SQLite 版本
4. 重新生成 Prisma 客户端

### 12.2 切换到 PostgreSQL（本地开发用 PG）

```bash
bash scripts/switch-to-postgres.sh
```

脚本会引导你输入 PostgreSQL 连接信息，然后自动完成切换。

### 12.3 Docker 始终使用 PostgreSQL

无论你本地开发用的是 SQLite 还是 PostgreSQL，**Docker 部署始终使用 PostgreSQL**。

Docker 构建过程会自动：
1. 把 Prisma schema 切换为 PostgreSQL
2. 把 scraper 队列替换为 PostgreSQL 版本
3. 配置好数据库连接

你不需要手动做任何事情。

---

## 架构说明

```
Docker 容器架构：

┌─────────────────────────────────────────────┐
│           novel-manager (容器)               │
│  ┌──────────────┐  ┌─────────────────────┐  │
│  │  Next.js     │  │  Scraper Service    │  │
│  │  (端口 3000) │  │  (端口 3099, 内部)  │  │
│  └──────┬───────┘  └────────┬────────────┘  │
│         │                   │               │
│         └─────────┬─────────┘               │
│                   │ Prisma Client           │
└───────────────────┼─────────────────────────┘
                    │
┌───────────────────┼─────────────────────────┐
│         novel-postgres (容器)                │
│                   │                         │
│         PostgreSQL 17                       │
│         (端口 5432, 内部)                   │
│                                             │
│         数据卷: postgres-data               │
└─────────────────────────────────────────────┘

外部访问：
  用户浏览器 ──→ 端口 3000 ──→ Next.js 应用
```

---

## 快速命令参考卡

| 操作 | 命令 |
|------|------|
| 启动 | `cd /opt/novel-admin && docker compose up -d` |
| 停止 | `docker compose stop` |
| 重启 | `docker compose restart` |
| 查看日志 | `docker compose logs -f` |
| 查看状态 | `docker compose ps` |
| 备份数据库 | `docker compose exec postgres pg_dump -U novel novel_admin > backup.sql` |
| 恢复数据库 | `docker compose exec -T postgres psql -U novel novel_admin < backup.sql` |
| 修改密码 | `nano .env` → 改 `ADMIN_PASSWORD` → `docker compose restart` |
| 完全卸载 | `docker compose down -v && rm -rf /opt/novel-admin` |
| **国内镜像** | `echo '{"registry-mirrors":["https://docker.1ms.run","https://docker.xuanyuan.me","https://docker.m.daocloud.io"]}' > /etc/docker/daemon.json && systemctl restart docker` |