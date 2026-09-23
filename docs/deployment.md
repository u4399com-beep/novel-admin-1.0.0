# novel-admin 部署运维图文教程（全 Go 架构版）

> 适用架构：**Task 24/25 之后的终态** —— Go 页面渲染 + Go 业务 API + Go 采集引擎，Next.js 16 退役为纯分流代理。
> 专题文档：[采集规则分析（15 站点实测）](scrape-rules.md) · [反反爬技术选型](anti-anti-crawl.md)
> 说明：本教程以 ASCII 图 + 表格 + 命令块代替截图（「图」均为真实拓扑/状态机的字符画）；命令按「可直接复制执行」标准编写，在本环境（/home/z/my-project）验证过的标注 ✅。

---

## 目录

1. [架构总览](#1-架构总览)
2. [环境要求与国内镜像安装](#2-环境要求与国内镜像安装)
3. [首次部署（8 步）](#3-首次部署8-步)
4. [进程看护与自愈语义](#4-进程看护与自愈语义)
5. [日常运维](#5-日常运维)
6. [任务生命周期操作](#6-任务生命周期操作)
7. [数据备份与恢复](#7-数据备份与恢复)
8. [常见问题排查](#8-常见问题排查)
9. [生产部署建议](#9-生产部署建议)
10. [目录结构与脚本清单](#10-目录结构与脚本清单)

---

## 1. 架构总览

### 1.1 三层拓扑图（ASCII）

```
                          ┌──────────────────────────────────────────────┐
                          │                 浏览器 / 反代                  │
                          └───────────────────────┬──────────────────────┘
                                                  │ HTTP :3000（唯一对外入口）
                                                  ▼
                ┌─────────────────────────────────────────────────────────────┐
                │  Next.js 16（:3000）—— 纯分流代理，无页面、无业务逻辑            │
                │                                                             │
                │  /api/*        →  src/app/api/[...path]/route.ts ──┐        │
                │  其余全部（/、/admin、/static、/covers、robots.txt、  ├────────┤
                │  /sitemap.xml、/category/*、/book/* …）             │        │
                │                 →  src/app/[[...slug]]/route.ts ───┘        │
                │  职责：原样转发（65s 超时）+ 调用 ensureBackendGo() 看护自愈     │
                └───────────────────────────────┬─────────────────────────────┘
                                                │ 127.0.0.1:3005
                                                ▼
        ┌───────────────────────────────────────────────────────────────────────┐
        │  backend-go（:3005，BACKEND_MODE=all）—— 单进程三职责                    │
        │                                                                       │
        │  ① 页面渲染   web.go + web/templates/（10 主题 × 6 视图 + /admin       │
        │              + _fallback 兜底主题 + robots + sitemap + ?theme= 预览）  │
        │  ② 业务 API   api_*.go（书籍/章节/分类/设置/PSEO/采集规则/采集任务）      │
        │  ③ 采集 runner worker.go + runner.go（2s 轮询 pending、两阶段管线、    │
        │              心跳文件、封面落盘、LLM 智能分类、pseo 富集循环）            │
        └───────┬──────────────────────────────┬────────────────────────────────┘
                │ SQL（唯一写入方）               │ 互监护：每 ≈30s 探测 :3030
                ▼                              ▼ 不可达 → 杀残留 → 托孤拉起
        ┌──────────────────┐          ┌────────────────────────────────────┐
        │ SQLite（WAL 模式） │          │  scraper-go（:3030）采集引擎          │
        │ db/custom.db      │          │  7 策略链：fetch-browser → ua-rotate │
        │ （Prisma 建表，     │          │  → mobile → spider → curl-impersonate│
        │  Go 用 modernc.    │          │  → got-scraping → browser(Playwright)│
        │  org/sqlite 直连）  │          │  域名限速 ≥1.2s · robots warn-only    │
        └──────────────────┘          └────────────────────────────────────┘
                                                                  │ 可选增强
                                                  ┌───────────────┴──────────────┐
                                                  │ ~/.local/bin/curl_chrome* 等   │
                                                  │ （TLS/JA3 指纹级伪装二进制）      │
                                                  └──────────────────────────────┘
```

要点：

- **单进程拓扑（Task 25 合并）**：此前的「3007 mode=api 页面双保险」进程已裁撤——沙箱会回收 bash 派生进程且 supervisor 只看护 3005，反复死亡导致页面 502。现在 **3005 一个进程就是唯一真身**（web + API + runner）。
- **Next.js 是纯管道**：`src/app/` 下无任何页面/SSR 代码，仅两个代理 route 文件（catch-all + /api/* 专用，目标同为 3005）。Next 挂了唯一影响是 3000 入口断连，Go 层本身仍健康（可直连 3005 应急）。
- **单库单写者**：`db/custom.db` 是唯一存储，backend-go 是唯一业务写入方。Prisma 仅在建表（`db:push`）时使用，运行时 Go 侧用 `modernc.org/sqlite` 纯 Go 驱动直连同一个文件。
- **封面落盘**：采集到的远程封面下载到 `public/covers/{id}.jpg`，由 backend-go 以 `/covers/` 前缀路由对外服务。

### 1.2 组件职责表

| 组件 | 端口 | 运行时 | 职责 | 源码 |
|------|------|--------|------|------|
| Next.js 16 | 3000 | Node ≥20（Bun 启动） | 纯分流代理 + backend-go 看护钩子（`ensureBackendGo()`） | `src/app/[[...slug]]/route.ts`、`src/app/api/[...path]/route.ts`、`src/lib/backend-supervisor.ts` |
| backend-go | 3005 | Go ≥1.22 | 页面渲染 + 业务 API + 采集 runner（`BACKEND_MODE=all`） | `mini-services/backend-go/` |
| scraper-go | 3030 | Go ≥1.22 | 反反爬引擎：7 策略链、GBK/GB18030 解码、SSRF 防护、限速、JSON 目录接口 | `mini-services/scraper-go/` |
| SQLite | — | — | 唯一存储 `db/custom.db`（WAL + busy_timeout 5s） | `db/`、`prisma/schema.prisma` |
| scraper-service | — | TS（**已退役**） | 旧 TS 引擎，仅作回滚备份；与 Go runner 并存会双写任务，**严禁启动** | `mini-services/scraper-service/` |

### 1.3 看护关系图（谁拉起谁）

```
 dev-supervisor.sh（while 循环，bun run dev 退出 2s 后重拉）
        │ 看护
        ▼
 Next.js :3000 ──ensureBackendGo()──▶ backend-go :3005（detached 托孤，长寿稳定）
                                        │    ▲
                        502 兜底重拉 ────┘    │（5s 冷却，进程消失后首次请求触发）
                                        │
                                        │ 每 ≈30s 探测 :3030（互监护）
                                        ▼
                                scraper-go :3030 ──▶（日志 /tmp/engine.log）

 二级兜底：scripts/ensure-services.sh（可挂 cron 每分钟）
   3005 不通 → 拉起 backend-go.bin(all)；3030 不通 → 拉起 scraper-go.bin

 沙箱专属（默认关闭）：backend-go devwatch.go，BACKEND_WATCH_DEV=1 时
   每 10s 探测 :3000，死后 30s 冷却自动重拉 bun run dev（堆内存限 1280MB）
```

---

## 2. 环境要求与国内镜像安装

### 2.1 版本要求

| 组件 | 版本要求 | 本环境实测 | 必需性 |
|------|----------|------------|--------|
| Bun | ≥ 1.3 | 1.3.x ✅ | 必需（依赖安装、dev 启动、CSS 构建、运维脚本） |
| Node.js | ≥ 20（Next.js 16 要求） | v24 ✅ | 必需（Next dev 运行时；backend-supervisor 用 node child_process） |
| Go | ≥ 1.22（两个 go.mod 声明 go 1.22） | **1.22.10** ✅ | 必需（编译 backend-go / scraper-go） |
| Python 3 + Playwright | ≥3.8 | 沙箱内置 Chromium | 可选（browser 策略的渲染桥接；缺失时该策略自动标记不可用，其余 6 策略不受影响） |
| curl-impersonate | v0.6.1 | 已装（~/.local/bin） | 可选但强烈建议（TLS 指纹伪装，硬反爬站的唯一突破口，见 §2.4） |

### 2.2 Bun / Node 安装

```bash
# Bun（官方脚本，装到 ~/.bun）
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Node 20+（Debian/Ubuntu 示例；macOS 用 brew install node@20）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
```

### 2.3 Go 安装（国内镜像：阿里云 tarball + goproxy.cn）

国内网络直连 go.dev 与 proxy.golang.org 通常不可达，用阿里云镜像 tarball + goproxy.cn 模块代理（**本环境实测路径**，工具链曾两次被回收、均按下法 3 分钟恢复）：

```bash
# ① 下载并解压 Go 1.22.10（阿里云镜像）
curl -sL -o /tmp/go.tgz https://mirrors.aliyun.com/golang/go1.22.10.linux-amd64.tar.gz
mkdir -p /home/z/go-sdk && tar -C /home/z/go-sdk -xzf /tmp/go.tgz
# → 产物为 /home/z/go-sdk/go/bin/go（本环境约定路径；官方默认 /usr/local/go 亦可）

# ② 环境变量（建议写入 ~/.bashrc / ~/.profile）
export PATH=$PATH:/home/z/go-sdk/go/bin   # 本环境 Go 所在目录
export GOPROXY=https://goproxy.cn,direct  # 国内模块代理
export GOPATH="${GOPATH:-/home/z/go}"

# ③ 验证
go version    # → go version go1.22.10 linux/amd64 ✅
```

> 仓库内两个 `run.sh`（mini-services/*/run.sh）已自动补 `PATH=$PATH:/home/z/go-sdk/go/bin`，用 run.sh 启动可免手工 export。
> 首次 `go build` 需拉取 `modernc.org/sqlite`、`goquery` 等依赖，GOPROXY 已设 goproxy.cn 时约 1~2 分钟。

### 2.4 curl-impersonate 安装（可选增强，硬反爬站必备）

```bash
bash scripts/install-curl-impersonate.sh
# → 解压 21 个 curl_chrome/ff/edge/safari 二进制到 ~/.local/bin（BoringSSL TLS/JA3 指纹级伪装）
```

- 引擎启动时 PATH 需含 `~/.local/bin`；策略侧已有 **60s 空结果重探逻辑**，装好后无需重启引擎，`GET /api/strategies` 中 curl-impersonate 自动变为可用。
- 该目录在沙箱环境会被周期性清理（已发生两次）——出现「101kks 这类 TLS 指纹站从可用变全拦截」时先重跑安装脚本。

---

## 3. 首次部署（8 步）

> 以全新机器为例，项目根目录写作 `~/my-project`（本沙箱为 `/home/z/my-project`，按实际替换）。
> 步骤顺序刻意设计为：**依赖 → 建库 → 样式 → 二进制 → 启动**，前一步产物是后一步的输入。

### 步骤 1：获取代码

```bash
git clone <你的仓库地址> my-project
cd my-project
```

### 步骤 2：安装依赖 + Prisma Client

```bash
bun install          # @prisma/client 的 postinstall 会自动 prisma generate
bun run db:generate  # 若上一步未自动生成，手动补跑
```

### 步骤 3：配置环境变量（.env）

```bash
mkdir -p db
cat > .env <<'EOF'
DATABASE_URL=file:/home/z/my-project/db/custom.db
EOF
```

| 变量 | 谁在用 | 说明 |
|------|--------|------|
| `DATABASE_URL` | Prisma CLI（建表） | SQLite 文件路径 |
| `DB_PATH` | backend-go（运行时读库） | 缺省回退 `/home/z/my-project/db/custom.db`，**部署到其他机器必须显式设置** |
| `BACKEND_PORT` / `BACKEND_MODE` | backend-go | 缺省 3005 / `all`（api+runner 同进程） |
| `SCRAPER_PORT` | scraper-go | 缺省 3030 |
| `COVERS_DIR` | backend-go | 封面目录，缺省向上查找 `public/covers` |
| `BACKEND_WATCH_DEV` | backend-go devwatch | 沙箱专属开关，生产**不要开** |

> 两处路径必须指向**同一个文件**：`DATABASE_URL`（建库）= `DB_PATH`（运行时）。

### 步骤 4：初始化数据库

```bash
bun run db:push    # = prisma db push --accept-data-loss
```

按 `prisma/schema.prisma` 在 `DATABASE_URL` 路径创建 SQLite 文件与全部表（Novel / Chapter / Category / SiteSetting / ScrapeRule / ScrapeTask / PseoKeyword 等）。
⚠️ 对既有库有 schema 同步语义，请勿对生产库随手执行；空库首建无副作用。

### 步骤 5：构建页面样式（Tailwind CSS）

```bash
bun run build:css   # = bun scripts/build-web-css.mjs ✅
# → mini-services/backend-go/web/static/css/tw.css（约 170KB）
```

Tailwind v4 的 `@source` 扫描 **Go 模板（web/templates/**）与静态 JS（web/static/js/**）** 中的类名生成最终 CSS。**改模板/JS 后必须重跑**，否则新类名无样式。

### 步骤 6：编译两个 Go 服务

```bash
export PATH=$PATH:/home/z/go-sdk/go/bin     # 按实际 Go 安装路径
export GOPROXY=https://goproxy.cn,direct

# ① backend-go（业务 API + 页面渲染 + 采集 runner）✅
cd mini-services/backend-go && go build -o backend-go.bin .

# ② scraper-go（反反爬引擎）✅
cd ../scraper-go && go build -o scraper-go.bin .

cd ../..
```

产物：`backend-go.bin` ≈ 15MB、`scraper-go.bin` ≈ 10MB。已有二进制时可用 `bash mini-services/backend-go/run.sh` 增量构建并前台运行（自动补 PATH）。

### 步骤 7：启动服务（推荐路径：只手动启动 Next，其余全自动）

**推荐（开发/长跑通用）**：

```bash
# 方式 A：dev-supervisor 循环（崩溃 2s 自动重拉，堆内存限 1280MB 防 OOM）✅
bash scripts/dev-supervisor.sh
# 或方式 B：前台直接跑
bun run dev   # Next dev on :3000，日志 tee 到 dev.log
```

之后**三层全自动接力**（无需手动启动 Go 服务）：

```
bun run dev 起来
   → 首次任意请求（浏览器打开 :3000 或 curl）触发 ensureBackendGo()
      → 自动 spawn backend-go.bin（:3005 mode=all，detached 托孤，日志 /tmp/backend-go-api.log）
         → runner 每 ≈30s 探测 :3030，不可达自动拉起 scraper-go.bin（日志 /tmp/engine.log）
```

**手动等价命令**（跳过自动链、直接拉起，形态与 `scripts/ensure-services.sh` 一致）：

```bash
# 引擎 → /tmp/engine.log
cd mini-services/scraper-go && setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 </dev/null &

# 后端（all 模式）→ /tmp/backend-go-api.log
cd ../backend-go && setsid nohup env BACKEND_PORT=3005 BACKEND_MODE=all \
  DB_PATH=/home/z/my-project/db/custom.db \
  ./backend-go.bin >> /tmp/backend-go-api.log 2>&1 </dev/null &
```

### 步骤 8：验证安装 ✅（以下为本环境真实输出）

```bash
# ① 入口（3000 → 代理 → 3005 页面渲染）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/            # → 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/admin       # → 200（Go 版管理后台）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/robots.txt  # → 200

# ② backend-go 健康（直连 3005）
curl -s http://127.0.0.1:3005/api/health
# → {"db":"/home/z/my-project/db/custom.db","dbOk":true,"ok":true,"runtime":"go1.22",
#    "service":"backend-go","version":"1.0.0",...}

# ③ 引擎健康（直连 3030）
curl -s http://127.0.0.1:3030/api/health
# → {"ok":true,"port":3030,"service":"scraper-service",...}

# ④ 引擎策略可用性（确认 curl-impersonate 是否已启用）
curl -s http://127.0.0.1:3030/api/strategies
```

浏览器验证：

- `http://localhost:3000/` → 当前启用主题的**服务端渲染**首页（书封卡、分类导航、图文区块）；
- `http://localhost:3000/admin` → Go 版管理后台（总览/规则/任务/书籍/分类/PSEO/设置 7 个 tab）；
- 主题预览：任意页面加 `?theme=<主题名>`（白名单）即时切换预览。

> React 时代的旧界面截图（`docs/images/*.png`）为历史版本存档，UI 已被 Go 模板层替代，仅作考古参考。

---

## 4. 进程看护与自愈语义

### 4.1 三层看护 + 双向互监护

| 层级 | 看护者 | 被看护者 | 探测方式 | 拉起方式 | 日志 |
|------|--------|----------|----------|----------|------|
| L1 | Next 进程内 supervisor（`src/lib/backend-supervisor.ts`） | backend-go :3005 | `/proc/{pid}/cmdline` 含 backend-go.bin；pid 未知退化用心跳+端口 | 首次 API 请求幂等拉起；502 兜底重拉（5s 冷却），detached 托孤 | `/tmp/backend-go-api.log` |
| L2 | backend-go runner ↔ scraper-go | scraper-go :3030 | 每 ≈30s GET `/api/strategies` | 杀残留 → setsid 托孤拉起 | `/tmp/engine.log` |
| L3 | `scripts/ensure-services.sh`（cron 每分钟） | 3005 与 3030 | curl 健康端点 | 不通才拉起（幂等），先清残留防端口互斥 | `/tmp/watchdog.log` |
| L0（可选） | `dev-supervisor.sh` while 循环 | Next :3000 | 进程退出码 | 2s 后重拉 `bun run dev`（堆限 1280MB） | `/tmp/dev-supervisor.log` |
| L0'（沙箱） | backend-go `devwatch.go`（`BACKEND_WATCH_DEV=1`） | Next :3000 | 每 10s 探测 TCP | 30s 冷却后托孤拉起 | backend-go 日志 |

> 为什么「挂在长寿进程上」：沙箱实证会周期性回收 bash 会话直接派生的后台进程（setsid 也不保险），只有长寿进程（Next dev / Go 常驻）托孤出去的进程才稳定。三层看护全部遵循该模式。

### 4.2 任务级自愈语义

| 场景 | 行为 |
|------|------|
| backend-go 重启，有任务遗留 `running` | 自动转 `paused`（进度保留可恢复），**不再误标 failed**；日志记「服务重启，任务中断自动暂停」 |
| backend-go 重启，有任务遗留 `pending` | 保持不动，新 runner 2s 内自动领取 |
| runner 心跳（`/tmp/scrape-runner-heartbeat`） | runner 每 2s 轮询 pending 时刷新；scrape API 以此判定 runner 在线 |
| 恢复（resume）语义 | paused → pending **重新入队**，Phase 1/2 依 DB 骨架续传：已有正文跳过、缺失补抓，不重复采集 |
| 沙箱进程收割 | 会话结束后遗留进程免疫——服务不稳定时「全部停掉 → 按 §3 步骤 7 重拉一遍」即恢复长期稳定 |

---

## 5. 日常运维

### 5.1 日志位置总表

| 日志 | 路径 | 内容 |
|------|------|------|
| Next dev | `dev.log`（项目根，`bun run dev` 自带 tee） | 代理层访问记录、supervisor 报错 |
| backend-go | `/tmp/backend-go-api.log` | API/runner/pseo 富集/引擎互监护/护栏全部关键日志 |
| scraper-go | `/tmp/engine.log` | 引擎启动、策略尝试明细 |
| ensure-services 动作 | `/tmp/watchdog.log` | 兜底脚本每轮检查结论与拉起动作 |
| dev-supervisor | `/tmp/dev-supervisor.log` | dev 退出与重拉记录 |
| runner 心跳 | `/tmp/scrape-runner-heartbeat` | 文件 mtime = runner 最近存活时刻 |
| 任务级日志 | DB `ScrapeTask.log`（后台任务列表「日志」按钮查看） | 追加式（保留最近 100 行），记录逐书逐章成败 |

### 5.2 常用运维命令 ✅

```bash
# 三层健康一键巡检
for p in 3000 3005 3030; do printf ":$p -> "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:$p/; done

# runner 是否在线（心跳 10s 内为健康）
find /tmp/scrape-runner-heartbeat -mmin -1 | grep -q . && echo "runner alive" || echo "runner stale"

# 看 backend-go 最近日志
tail -n 50 /tmp/backend-go-api.log

# 有序重启 backend-go（先杀后由 Next 502 兜底重拉，或手动按 §3 步骤 7 拉起）
pkill -f 'backend-go[.]bin'; sleep 1; curl -s http://127.0.0.1:3000/api/health >/dev/null  # 触发 ensureBackendGo

# 规则资产核对（15 条：11 旧站 + 4 新站）
bun scripts/dump-rules.ts            # 导出关键字段供比对
bun scripts/check-rules-integrity.ts # 选择器字节级断言（防 IM 网关吞字）
```

### 5.3 规则资产维护

- 规则存于 `ScrapeRule` 表，当前 **15 条**（11 旧站 id 10-20 + 4 新站 id 21-24），结论详见 [`scrape-rules.md`](scrape-rules.md)。
- **4 新站规则由 `scripts/add-new-rules.ts` 幂等重建**（按 name upsert，任务关联不受影响，可重复执行）：

```bash
bun scripts/add-new-rules.ts   # 重建/校准 5165、23uswx、38.34.172.127（停用草稿）、ixdzs8 ✅
```

- 11 旧站规则依赖实测定稿，**以备份为准**（§7），不要凭记忆重填；库丢失时从备份恢复后再用上脚本补新站。
- 编辑规则注意：后台规则表单为**全字段覆盖**式 PUT——传部分 JSON 会把未传的 bookRule/chapterRule 清空（24-d 实训教训），改单字段也要带全量对象。

### 5.4 选择器语法速查（三段规则通用）

| 语法 | 含义 | 示例 |
|------|------|------|
| CSS 选择器 | 取 textContent | `#gengxin ul li` |
| `sel@src` / `sel@href` / `sel@content` / `sel@value` | 取对应属性 | `.pic img@src` |
| 逗号分隔 | 备选（从左到右命中即用） | `p a, a` |
| `catalogLinkSelector` | 书页只有目录入口链接时，二次抓整目页 | `a[href^="/read/"]` |
| `nextSelector` | 章节页 CMS 分页自动跟随 | `.next` |
| `removeSelectors` | 提取前剔除噪声节点（广告/推荐） | `h1.logo,.search` |
| `chapterListApi` | JSON 目录接口配置（POST 拉全目录，含 `{bookId}`/`{order}` 模板与 SSRF 同源校验） | 见规则 #24 ixdzs8 落库值 |

> 完整字段清单与 15 站实测结论见 [`scrape-rules.md`](scrape-rules.md)；后台「规则」tab 的 JSON 表单与 DB 字段一一对应。

---

## 6. 任务生命周期操作

### 6.1 状态机（ASCII）

```
                 ┌──────────────────────────────────────────────────────┐
                 │            pending（排队，runner 每 2s 轮询领取）        │
                 └──────┬───────────────────────────────▲───────────────┘
              领取/恢复 │                               │ resume / restart
                       ▼                               │（重新入队）
                 ┌──────────────┐   pause（安全点停手）  │
                 │   running    │──────────────►┌─────────────┐
                 │              │               │   paused    │（进度保留，可编辑）
                 └──┬───┬───┬───┘               └──────┬──────┘
                    │   │   │        cancel（协作停止）   │
        success ◄───┘   │   └──────────►┌──────────┐    │
        partial ◄───────┤               │ canceled │    │
        failed  ◄───────┘               └────┬─────┘    │
                                             └──────────┴──► 终态（含 success/partial/failed）
                                                              终态可 restart：置 pending + 进度清零
```

### 6.2 操作矩阵（后台「采集中心」或 PATCH API）

| 操作 | 允许的当前状态 | 行为 |
|------|----------------|------|
| 编辑（PUT 参数） | `pending` / `paused` / 全部终态；**`running` → 409**（提示先暂停） | 改 mode/targetUrl/ruleId/pages；终态改完点「重启」按新参数重采 |
| 暂停（pause） | `pending` / `running` | running 由 worker 协作式在安全点停手（≤数秒），绝不覆盖 paused 状态与进度字段 |
| 恢复（resume） | 仅 `paused` | → `pending` 重新入队 + 日志追加恢复记录；骨架续传不重复采 |
| 取消（cancel） | `pending` / `running` / `paused` | 协作式停止（非强杀），已采数据保留，终态 `canceled` |
| 重启（restart） | 仅终态 `failed` / `partial` / `canceled` / `success` | → `pending` + 进度清零 + 日志记「手动重启，任务重新入队」；6s 内被 runner 领取 |
| 删除 | 终态与 `paused` | 删任务记录，**不动已入库书籍** |

API 形态（也可在后台 UI 点按钮）：

```bash
curl -X PATCH http://127.0.0.1:3000/api/scrape-tasks/27 -H 'Content-Type: application/json' \
     -d '{"action":"pause"}'    # pause | resume | cancel | restart
curl -X PUT   http://127.0.0.1:3000/api/scrape-tasks/27 -H 'Content-Type: application/json' \
     -d '{"pages":2,"ruleId":14,...}'   # 编辑（running 会被 409 拒绝）
```

### 6.3 进度字段

| 字段 | single 模式 | list 模式 |
|------|-------------|-----------|
| `total` / `done` | 章节数 | 书籍数 |
| `chaptersDone` / `chaptersTotal` | — | 章节级副进度（跨书累计） |
| `created` / `updated` | 0 / 1 | 新建/更新书籍数 |
| `log` | 追加式运行日志 | 同左 |

> Phase 1（建骨架）快、Phase 2（填正文）慢且受目标站限速约束（每域名 ≥1.2s）；`done` 按 200 章/批 flush 属正常设计。

---

## 7. 数据备份与恢复

### 7.1 备份对象：db 三文件

WAL 模式下 SQLite 由三个文件组成：`db/custom.db` + `custom.db-shm` + `custom.db-wal`。**三文件必须作为整体快照**，只拷主文件会丢最近写入甚至损坏。

```bash
# 安全备份方式 A（推荐，热备单文件、免停服）：SQLite 在线备份 API（需 sqlite3 CLI）
sqlite3 db/custom.db ".backup '/tmp/backup-$(date +%F).db'"

# 安全备份方式 B（停写冷备）：先停 backend-go（唯一写方），再整体拷贝
pkill -f 'backend-go[.]bin' && sleep 2
cp -av db/custom.db db/custom.db-shm db/custom.db-wal /tmp/backup-dir/ 2>/dev/null || cp -av db/ /tmp/backup-dir/
```

### 7.2 恢复

```bash
# ⚠️ 铁律（Task 22 血泪教训）：多进程持有 WAL 时 mv/替换库文件 = 数据丢失
#    （旧进程退出时按路径 unlink 新 wal）。必须先停掉全部持有者。
pkill -f 'backend-go[.]bin'; pkill -f 'scraper-[g]o.bin'
# Next dev 若持有旧 inode 也一并处理（或直接重启 dev）
cp /tmp/backup-dir/custom.db* db/
# 再按 §3 步骤 7 重新拉起；重启触发 running→paused 自愈，任务可在后台「恢复」
```

恢复后核对：`curl :3005/api/health`（dbOk:true）→ 后台总览统计 → `bun scripts/dump-rules.ts` 核对 15 规则。

### 7.3 规则重建（库丢规则但书籍还在/全新库）

1. 全新库：`bun run db:push` 建表；
2. 11 旧站规则：从 git 历史或备份 JSON 恢复（后台规则表单**全字段**录入，或 `INSERT` 后用 `check-rules-integrity.ts` 校验）；
3. 4 新站规则：`bun scripts/add-new-rules.ts`（幂等 upsert）✅；
4. 核对总数：`dump-rules.ts` 应输出 15 条。

### 7.4 封面与正文

- 封面：`public/covers/{id}.jpg`，普通文件，随目录整体备份；
- 正文：全部在 DB（Chapter 表），随 §7.1 备份覆盖；
- 模板/样式：Go 模板与 `tw.css` 属代码资产，随 git 仓库走，改模板后重跑 `bun run build:css`。

---

## 8. 常见问题排查

### 8.1 页面 502：按链路逐层排查

```
请求 :3000 → 502 ？
   │
   ├─ ① Next 活着吗？  curl -s -o /dev/null -w '%{http_code}' :3000/robots.txt
   │      不通 → 看 dev.log；重启：bash scripts/dev-supervisor.sh（沙箱可开 BACKEND_WATCH_DEV=1 让 backend-go 顺带看护）
   │
   ├─ ② backend-go 活着吗？  curl -s :3005/api/health
   │      不通 → 看 /tmp/backend-go-api.log；正常情况下首次请求/502 兜底会在 5s 冷却后自动重拉
   │      （拉不起来：常见为端口被占/二进制缺失/DB_PATH 错误，逐项核对）
   │
   └─ ③ 引擎活着吗？  curl -s :3030/api/health
          不通 → 不影响页面浏览，只影响采集；runner 30s 内互监护拉起，或手动：
          cd mini-services/scraper-go && setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 &
```

> 502 响应体带 `{"error":..., "detail":...}`：`后端服务响应超时` = 65s 超时（backend-go 在但卡住，看日志找慢查询/引擎阻塞）；`后端服务不可用` = 连不上（backend-go 死了，等自愈或手动拉起）。

### 8.2 端口占用（拉起失败第一嫌疑）

```bash
ss -ltnp | grep -E ':(3000|3005|3030)\b'
# 双开残留 → 精确清掉再拉（[.] 字符类防 pkill 自匹配）
pkill -f 'backend-go[.]bin'; pkill -f 'scraper-[g]o.bin'
```

### 8.3 Go 工具链被回收（go: command not found）

沙箱实证 `/home/z/go-sdk` 会被周期清理。恢复三步（§2.3 原文）：aliyun tarball 重解压 → `export PATH` → `go version` 验证。二进制（backend-go.bin / scraper-go.bin）不受影响，运行中的服务不需要重新编译。

### 8.4 SQLite WAL 锁 / busy / malformed

| 症状 | 处置 |
|------|------|
| `database is locked` / busy | busy_timeout 已设 5s，偶发竞争会自动重试；**检查是否有第二个写者**（TS worker / 旧进程 / 手开 sqlite3 写事务）——单写者原则必须维持 |
| `database disk image is malformed` | 多为 WAL inode 分裂（mv 替换/多进程混写）所致。按 §7.2 全停持有者 → 从备份恢复；或抢救：`bun:sqlite` 只读导出健康数据到新库（Task 22 实操流程，integrity_check 确认后整体替换） |
| 间歇 500 但直连 3005 正常 | Next 持有旧 DB inode 的 deleted fd（库被替换过）→ 重启 Next dev 即恢复 |

### 8.5 采集侧速查

| 症状 | 处置 |
|------|------|
| 任务长期 `pending` | runner 不在：看心跳文件与 /tmp/backend-go-api.log；或规则 `enabled=false` 被跳过 |
| 全策略 challenge-page 拦截 | 先跑 `bash scripts/install-curl-impersonate.sh`（~/.local/bin 可能被清）；仍拦截 → 该站引擎指纹被针对（如 101kks），结论记规则 notes，见 scrape-rules.md |
| list 提取 0 本 | 站点改版，选择器失效：直连（系统 curl）看真实 HTML 校准 listRule，参考 24-d 两次校准记录（ggd66 #gengxin、x2552 #centeri） |
| 章节正文被限速熔断 | 站点对高频掐流量（aijjxs/23qb/xinjianpan 实训）：等冷却后重启/恢复任务，骨架自动续传 |

### 8.6 CSS 类名不生效（模板改了但页面没样式）

Tailwind 只认构建时扫描到的类名：改 Go 模板 / static JS 后**必须** `bun run build:css` 重新生成 `tw.css`（§3 步骤 5）。

---

## 9. 生产部署建议

1. **进程管理换 systemd**：本仓库的三层看护（supervisor/互监护/ensure-services）是为无 systemd 的沙箱设计的兜底；生产环境建议三个 unit（next / backend-go / scraper-go）+ `Restart=always`，看护语义等价且更透明。backend-go 的 `devwatch.go`（BACKEND_WATCH_DEV）是为沙箱收割器准备的特设层，**生产不要开启**。
2. **反向代理**：Nginx/Caddy 直接指向 3000（Next 代理壳）或跳过 Next 直指 3005（Go 层已能渲染全部页面与 API，3000 只是多一跳）。
3. **备份**：cron 每日 `sqlite3 .backup`（§7.1 方式 A）+ 异机存放；规则 JSON 导出（`dump-rules.ts`）一并归档。
4. **构建**：`go build` 可加 `-trimpath -ldflags "-s -w"` 缩小二进制；模板与 `tw.css` 属静态资产，随部署目录走。
5. **合规**：引擎内置域名限速 ≥1.2s、robots warn-only、无验证码破解/登录态伪造；请遵守目标站 robots 与当地法规，仅采集公开内容。

---

## 10. 目录结构与脚本清单

### 10.1 关键目录

```
my-project/
├─ src/app/[[...slug]]/route.ts      # 3000 唯一出口：全部流量 → 3005（65s，502 兜底重拉）
├─ src/app/api/[...path]/route.ts    # /api/* 专用代理（同一目标，契约同）
├─ src/lib/backend-supervisor.ts     # ensureBackendGo()：进程看护核心
├─ mini-services/backend-go/         # :3005 单进程（web.go/web_data.go/api_*.go/worker.go/runner.go/…）
│  ├─ web/templates/{10 主题,_fallback,admin}/
│  ├─ web/static/{css/tw.css, js/}
│  └─ web-src/tw-input.css           # Tailwind 入口（@source 扫模板）
├─ mini-services/scraper-go/         # :3030 引擎（chain.go/strategies.go/curlimp.go/…）
├─ prisma/schema.prisma              # 表结构权威定义（db:push 建库）
├─ db/custom.db(-shm/-wal)           # 唯一存储（SQLite WAL）
├─ public/covers/                    # 采集封面落盘
├─ docs/                             # 本文档 + scrape-rules.md + anti-anti-crawl.md
└─ scripts/                          # 运维脚本（见下表）
```

### 10.2 scripts/ 活跃脚本（Task 25-d 清理后，共 8 项）

| 脚本 | 用途 | 运行 |
|------|------|------|
| `dev-supervisor.sh` | Next dev 看护循环（崩溃 2s 重拉，堆限 1280MB） | `bash scripts/dev-supervisor.sh` |
| `ensure-services.sh` | 二级兜底：3005/3030 不通才拉起（幂等，可挂 cron） | `bash scripts/ensure-services.sh` |
| `watchdog.ts` | bun 常驻看护（runner 心跳 + 引擎探活，30s 一轮） | `setsid nohup bun scripts/watchdog.ts` |
| `build-web-css.mjs` | Tailwind v4 构建（扫 Go 模板/JS → tw.css） | `bun run build:css` |
| `add-new-rules.ts` | 4 新站规则幂等 upsert（5165/23uswx/38.34/ixdzs8） | `bun scripts/add-new-rules.ts` |
| `dump-rules.ts` | 导出全部规则关键字段（备份核对用） | `bun scripts/dump-rules.ts` |
| `check-rules-integrity.ts` | 选择器字节级断言（防吞字/误改） | `bun scripts/check-rules-integrity.ts` |
| `install-curl-impersonate.sh` | 重装 curl-impersonate 21 二进制到 ~/.local/bin | `bash scripts/install-curl-impersonate.sh` |

> 一次性排查/取证脚本（probe-*、forensic-*、check-*、fix-*、rule-probe*、set-pagination、reclassify-others、port-forward、engine-rule-test、db-evidence 等 43 项）已归档至 `scripts/archive/`（历史留档，硬编码路径可能失效，不再维护）。

### 10.3 package.json scripts 速查

| 命令 | 实际执行 | 说明 |
|------|----------|------|
| `bun run dev` | `next dev -p 3000`（tee dev.log） | Next 代理壳 |
| `bun run build:css` | `bun scripts/build-web-css.mjs` | 模板类名变更后必跑 |
| `bun run db:push` | `prisma db push --accept-data-loss` | 建库/同步 schema |
| `bun run db:generate` | `prisma generate` | 生成 Prisma Client（CLI 用） |
| `bun run lint` | `eslint .` | 代码检查 |
