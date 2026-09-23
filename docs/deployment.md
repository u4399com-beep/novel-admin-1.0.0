# novel-admin 部署运维图文教程（全 Go 架构版）

> 适用架构：**Task 27 之后的终态** —— Go 单栈：backend-go 单进程承载 3000（页面 SSR + 业务 API + 采集 runner 三合一）+ scraper-go（:3030）采集引擎。**Next.js 已彻底拆除**（src/、next.config.ts、.next/ 均已删除，依赖精简至 5 包，`bun run dev/build` 已切到 scripts/dev-go.sh / build-go.sh）。
> 历史兼容：backend-go 的 `BACKEND_PORT` 环境变量仍接受 3005（Task 24-26 时代默认值），不设置即用 3000；老部署配置无需改动即可继续运行，新部署一律 3000。
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
9. [生产部署建议（systemd 双进程）](#9-生产部署建议systemd-双进程)
10. [目录结构与脚本清单](#10-目录结构与脚本清单)

---

## 1. 架构总览

### 1.1 双进程拓扑图（ASCII）

```
                          ┌──────────────────────────────────────────────┐
                          │                 浏览器 / 反代                  │
                          └───────────────────────┬──────────────────────┘
                                                  │ HTTP :3000（唯一对外入口，直连 Go）
                                                  ▼
        ┌───────────────────────────────────────────────────────────────────────┐
        │  backend-go（:3000，BACKEND_MODE=all）—— 单进程三职责（Task 27 唯一真身）│
        │                                                                       │
        │  ① 页面渲染   web.go + web/templates/（10 主题 × 6 视图 + /admin       │
        │              + _fallback 兜底主题 + robots + sitemap + ?theme= 预览）  │
        │  ② 业务 API   api_*.go（书籍/章节/分类/设置/PSEO/采集规则/采集任务）      │
        │  ③ 采集 runner worker.go + runner.go（2s 轮询 pending、两阶段管线、    │
        │              心跳文件、封面落盘、LLM 智能分类、pseo 富集循环）            │
        │  ④ 空库自动播种 seed.go（go:embed seed/seed.json，见 §1.4）            │
        └───────┬──────────────────────────────┬────────────────────────────────┘
                │ SQL（唯一写入方）               │ 互监护：每 ≈30s 探测 :3030
                ▼                              ▼ 不可达 → 杀残留 → 托孤拉起
        ┌──────────────────┐          ┌────────────────────────────────────┐
        │ SQLite（WAL 模式） │          │  scraper-go（:3030）采集引擎          │
        │ db/custom.db      │          │  8 策略链：fetch-browser → ua-rotate │
        │ （Prisma 建表，     │          │  → mobile → spider → curl-impersonate│
        │  Go 用 modernc.    │          │  → fetch-curl → got-scraping        │
        │  org/sqlite 直连）  │          │  → browser(Playwright)              │
        └──────────────────┘          │  域名限速 ≥1.2s · robots warn-only   │
                可选增强               └────────────────────────────────────┘
                                                  │
                                  ┌───────────────┴──────────────┐
                                  │ ~/.local/bin/curl_chrome* 等   │
                                  │ （TLS/JA3 指纹级伪装二进制）      │
                                  └──────────────────────────────┘
```

要点：

- **Go 单栈（Task 27）**：Next.js 代理壳已整体拆除——无 src/、无 node 运行时依赖、无 next dev。3000 端口由 backend-go 直接承载（页面 + API + runner 同进程），少一跳代理、少一层看护、少一份内存。
- **迁移期端口兼容**：`BACKEND_PORT=3005` 仍可运行（Task 24-26 时代部署配置不受影响）；不设置该变量时默认 3000。3005 不再是文档口径，新部署/新配置一律 3000。
- **单库单写者**：`db/custom.db` 是唯一存储，backend-go 是唯一业务写入方。Prisma 仅在建表（`db:push`）时使用，运行时 Go 侧用 `modernc.org/sqlite` 纯 Go 驱动直连同一个文件。
- **封面落盘**：采集到的远程封面下载到 `public/covers/{id}.jpg`，由 backend-go 以 `/covers/` 前缀路由对外服务。
- **历史残响**：曾有的「3007 mode=api 页面双保险」「Next 纯分流代理」「devwatch.go 看 3000」均已随 Next.js 拆除一并退役，相关配置（`GO_WEB_ORIGIN`、`BACKEND_WATCH_DEV`）不再生效。

### 1.2 组件职责表

| 组件 | 端口 | 运行时 | 职责 | 源码 |
|------|------|--------|------|------|
| backend-go | **3000** | Go ≥1.22 | 页面渲染 + 业务 API + 采集 runner + 空库播种（`BACKEND_MODE=all`） | `mini-services/backend-go/` |
| scraper-go | 3030 | Go ≥1.22 | 反反爬引擎：8 策略链、GBK/GB18030 解码、SSRF 防护、限速、JSON 目录接口 | `mini-services/scraper-go/` |
| SQLite | — | — | 唯一存储 `db/custom.db`（WAL + busy_timeout 5s） | `db/`、`prisma/schema.prisma` |
| scraper-service | — | TS（**已退役**） | 旧 TS 引擎，仅作回滚备份；与 Go runner 并存会双写任务，**严禁启动** | `mini-services/scraper-service/` |

### 1.3 看护关系图（谁拉起谁）

```
 bun run dev = scripts/dev-go.sh（自愈循环：backend-go 退出 2s 后重拉，防双实例预检）
        │ 看护（经沙箱 dev 链路孵化 → 长寿稳定）
        ▼
 backend-go :3000（页面 SSR + API + runner 三合一）
        │
        │ 每 ≈30s 探测 :3030（互监护）
        ▼
 scraper-go :3030 ──▶（日志 /tmp/engine.log）

 二级兜底：scripts/ensure-services.sh（可挂 cron 每分钟）
   3000 不通 → 拉起 backend-go.bin(all)；3030 不通 → 拉起 scraper-go.bin

 生产环境：systemd 双 unit（backend-go / scraper-go）+ Restart=always
   取代上述全部兜底循环（见 §9）
```

> 看护层级从 Task 25 时代的「三层 + 互监护」收敛为「dev 循环 + 互监护 + cron 兜底」：Next 进程内 supervisor（ensureBackendGo）与 backend-go devwatch.go 已随 Next.js 拆除删除，不再存在。

### 1.4 种子固化机制（Task 27，全新部署无需预置数据）

规则/分类/首页区块配置已固化为仓库内种子，随二进制分发（`go:embed`），**启动时对应表为空即自动导入**：

| 表 | 空表时播种内容 | 说明 |
|----|----------------|------|
| `ScrapeRule` | 15 条校准规则（11 老站 + 4 新站，含 fetch-curl/chapterListApi 增强标注与噪声审计 notes） | 11 老站经 Task 3/24-d/26-a 多轮实测定稿 |
| `Category` | 9 分类（8 核心类 + 「其他」id=9999 sort=9999 恒末位） | 26-a 分类治理终态 |
| `SiteSetting` | 兜底建行（站名/主题 trxsw/公告）+ homeConfig 为空时写默认三区块（小编精选 featured 上移契约位 + 热门 + 最新上架） | 幂等 ON CONFLICT DO NOTHING |

- **幂等语义**：只在 `COUNT==0` 时导入，绝不覆盖用户已编辑的规则/分类；播种失败仅告警不阻断启动。
- **手动重置**：清空对应表后重启服务即可重新播种。
- 源文件：`mini-services/backend-go/seed/seed.json`（数据）+ `seed.go`（导入逻辑）。沙箱整机回收重置 DB 后，服务重启即自动找回全部规则资产——历史上两次人工从 git 快照救数据的事故不再复发。

---

## 2. 环境要求与国内镜像安装

### 2.1 版本要求

| 组件 | 版本要求 | 本环境实测 | 必需性 |
|------|----------|------------|--------|
| Bun | ≥ 1.3 | 1.3.x ✅ | 必需（依赖安装、CSS 构建、engine-rule-test 等运维脚本、dev 链路入口 `bun run dev`） |
| Go | ≥ 1.22（两个 go.mod 声明 go 1.22） | **1.22.10** ✅ | 必需（编译并运行 backend-go / scraper-go——Task 27 起也是 3000 端口的运行时） |
| Node.js | — | — | **不再必需**（Next.js 已拆除；原「Next 16 要求 Node ≥20」约束随架构退役） |
| Python 3 + Playwright | ≥3.8 | 沙箱内置 Chromium | 可选（browser 策略的渲染桥接；缺失时该策略自动标记不可用，其余 7 策略不受影响） |
| curl-impersonate | v0.6.1 | 已装（~/.local/bin） | 可选但强烈建议（TLS 指纹伪装，硬反爬站的唯一突破口，见 §2.4） |

### 2.2 Bun 安装

```bash
# Bun（官方脚本，装到 ~/.bun）
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
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
bun install          # 依赖已精简至 5 包（prisma/@prisma/client/@tailwindcss/postcss/tailwindcss/typescript 等 dev），
                     # @prisma/client 的 postinstall 会自动 prisma generate
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
| `BACKEND_PORT` / `BACKEND_MODE` | backend-go | 缺省 **3000** / `all`（页面+API+runner 同进程）；Task 24-26 时代默认 3005，现仅作迁移期兼容值 |
| `SCRAPER_PORT` | scraper-go | 缺省 3030 |
| `COVERS_DIR` | backend-go | 封面目录，缺省向上查找 `public/covers` |

> 两处路径必须指向**同一个文件**：`DATABASE_URL`（建库）= `DB_PATH`（运行时）。

### 步骤 4：初始化数据库

```bash
bun run db:push    # = prisma db push --accept-data-loss
```

按 `prisma/schema.prisma` 在 `DATABASE_URL` 路径创建 SQLite 文件与全部表（Novel / Chapter / Category / SiteSetting / ScrapeRule / ScrapeTask / PseoKeyword）。
⚠️ 对既有库有 schema 同步语义，请勿对生产库随手执行；空库首建无副作用。

**建表后无需预置任何数据文件**：backend-go 首次启动检测到 ScrapeRule / Category 空表、homeConfig 为空时，会从内嵌种子（§1.4）自动播种 15 条校准规则、9 个分类与首页默认三区块。历史版本需要手工恢复 SQL/JSON 资产文件的步骤已废除。

### 步骤 5：构建页面样式（Tailwind CSS）

```bash
bun run build:css   # = bun scripts/build-web-css.mjs ✅
# → mini-services/backend-go/web/static/css/tw.css（约 170KB）
```

Tailwind v4 的 `@source` 扫描 **Go 模板（web/templates/**）、静态资源（web/static/**）与渐变 token 表（web-src/gradient-tokens.txt）** 中的类名生成最终 CSS。**改模板/JS 后必须重跑**，否则新类名无样式。

### 步骤 6：编译两个 Go 服务

```bash
export PATH=$PATH:/home/z/go-sdk/go/bin     # 按实际 Go 安装路径
export GOPROXY=https://goproxy.cn,direct

# ① backend-go（页面渲染 + 业务 API + 采集 runner，端口 3000）✅
cd mini-services/backend-go && go build -o backend-go.bin .

# ② scraper-go（反反爬引擎）✅
cd ../scraper-go && go build -o scraper-go.bin .

cd ../..
```

产物：`backend-go.bin` ≈ 15MB、`scraper-go.bin` ≈ 10MB。

> 一键等价命令：`bun run build`（= `bash scripts/build-go.sh`，构建双二进制 + Tailwind CSS 一步到位）。
> 已有二进制时可用 `bash mini-services/backend-go/run.sh` 增量构建并前台运行（自动补 PATH）。

### 步骤 7：启动服务（推荐路径：一条 `bun run dev`，其余全自动）

**推荐（开发/长跑通用）**：

```bash
bun run dev   # = bash scripts/dev-go.sh ✅
# 自愈循环启动 backend-go（:3000 mode=all，页面+API+runner 三合一），
# 进程退出 2s 后自动重拉；已有健康实例则退出（防双实例双 runner）。
```

启动后**两级自动接力**（无需手动启动引擎）：

```
bun run dev 起来
   → backend-go.bin 增量构建并监听 :3000（日志见 §5.1）
      → runner 每 ≈30s 探测 :3030，不可达自动杀残留并托孤拉起 scraper-go.bin（日志 /tmp/engine.log）
```

**手动等价命令**（跳过 dev 循环、直接拉起，形态与 `scripts/ensure-services.sh` 一致）：

```bash
# 引擎 → /tmp/engine.log
cd mini-services/scraper-go && setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 </dev/null &

# 后端（all 模式）→ /tmp/backend-go-api.log
cd ../backend-go && setsid nohup env BACKEND_PORT=3000 BACKEND_MODE=all \
  DB_PATH=/home/z/my-project/db/custom.db \
  ./backend-go.bin >> /tmp/backend-go-api.log 2>&1 </dev/null &
```

**生产环境**请改用 systemd 双进程（§9），不经过 dev 循环。

### 步骤 8：验证安装 ✅（以下为本环境真实输出）

```bash
# ① 入口（3000 = backend-go 本体，页面渲染直连）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/            # → 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/admin       # → 200（Go 版管理后台）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/robots.txt  # → 200

# ② backend-go 健康（与 ① 同一进程）
curl -s http://127.0.0.1:3000/api/health
# → {"db":"/home/z/my-project/db/custom.db","dbOk":true,"ok":true,"runtime":"go1.22",
#    "service":"backend-go","version":"1.0.0",...}

# ③ 引擎健康（直连 3030）
curl -s http://127.0.0.1:3030/api/health
# → {"ok":true,"port":3030,"service":"scraper-service",...}

# ④ 引擎策略可用性（确认 curl-impersonate 是否已启用）
curl -s http://127.0.0.1:3030/api/strategies
```

首次启动日志应出现播种记录（库为空时）：

```
[seed] ScrapeRule 空表 → 已播种 15 条校准规则
[seed] Category 空表 → 已播种 9 个分类（其他 id=9999 恒末位）
[seed] homeConfig 空 → 已写入默认 3 区块（小编精选上移契约位）
```

浏览器验证：

- `http://localhost:3000/` → 当前启用主题的**服务端渲染**首页（书封卡、分类导航、图文区块）；
- `http://localhost:3000/admin` → Go 版管理后台（总览/规则/任务/书籍/分类/PSEO/设置 7 个 tab）；
- 主题预览：任意页面加 `?theme=<主题名>`（白名单）即时切换预览。

> React 时代的旧界面截图（`docs/images/*.png`）为历史版本存档，UI 已被 Go 模板层替代，仅作考古参考。

---

## 4. 进程看护与自愈语义

### 4.1 看护层级（Task 27 收敛后）

| 层级 | 看护者 | 被看护者 | 探测方式 | 拉起方式 | 日志 |
|------|--------|----------|----------|----------|------|
| L1 | `scripts/dev-go.sh` 自愈循环（`bun run dev` 入口） | backend-go :3000 | 进程退出码（另含启动时健康预检防双实例） | 2s 后重拉 `run.sh`（增量构建 + 前台运行） | `/tmp/dev-supervisor.log`（退出记录） |
| L2 | backend-go runner ↔ scraper-go | scraper-go :3030 | 每 ≈30s GET `/api/strategies` | 杀残留 → setsid 托孤拉起 | `/tmp/engine.log` |
| L3 | `scripts/ensure-services.sh`（cron 每分钟） | 3000 与 3030 | curl 健康端点 | 不通才拉起（幂等），先清残留防端口互斥 | `/tmp/watchdog.log` |

> 为什么「挂在长寿进程上」：沙箱实证会周期性回收 bash 会话直接派生的后台进程（setsid 也不保险），只有经沙箱 dev 链路（基础设施进程）孵化的进程才长寿稳定——所以 dev-go.sh 必须经 `bun run dev` 链路进入，不要在交互 shell 里直接跑。
> 历史层级（Next 进程内 ensureBackendGo supervisor、devwatch.go 看 3000）已随 Next.js 拆除删除，勿再配置 `BACKEND_WATCH_DEV`（无效果）。

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
| backend-go（dev 链路） | 沙箱 dev 链路标准输出（`bun run dev` 前台运行即所见即所得） | 增量构建、启动、API/runner/pseo 富集/播种全部关键日志 |
| backend-go（ensure-services 拉起） | `/tmp/backend-go-api.log` | 同上（后台实例） |
| scraper-go | `/tmp/engine.log` | 引擎启动、策略尝试明细 |
| ensure-services 动作 | `/tmp/watchdog.log` | 兜底脚本每轮检查结论与拉起动作 |
| dev-go 退出记录 | `/tmp/dev-supervisor.log` | backend-go 退出码与重拉时刻 |
| runner 心跳 | `/tmp/scrape-runner-heartbeat` | 文件 mtime = runner 最近存活时刻 |
| 任务级日志 | DB `ScrapeTask.log`（后台任务列表「日志」按钮查看） | 追加式（保留最近 100 行），记录逐书逐章成败 |

### 5.2 常用运维命令 ✅

```bash
# 双进程健康一键巡检
for p in 3000 3030; do printf ":$p -> "; curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:$p/; done

# runner 是否在线（心跳 10s 内为健康）
find /tmp/scrape-runner-heartbeat -mmin -1 | grep -q . && echo "runner alive" || echo "runner stale"

# 看 backend-go 最近日志
tail -n 50 /tmp/backend-go-api.log

# 有序重启 backend-go（先杀后由 dev-go 循环自愈重拉；无 dev 循环时手动按 §3 步骤 7 拉起）
pkill -f 'backend-go[.]bin'; sleep 3
# dev 链路在跑时无需任何操作（2s 自愈）；否则：
# bash scripts/dev-go.sh   或按 §3 步骤 7 的手动等价命令拉起
```

### 5.3 规则资产维护

- 规则存于 `ScrapeRule` 表，当前 **15 条**（11 旧站 id 10-20 + 4 新站 id 21-24），结论详见 [`scrape-rules.md`](scrape-rules.md)。
- **15 条规则已固化为种子**（§1.4）：库丢失/清空后重启服务即自动找回，无需再跑任何补数脚本。历史脚本 `add-new-rules.ts` / `dump-rules.ts` / `check-rules-integrity.ts` 已归档至 `scripts/archive/`（仍可 `bun` 直跑作核对用途）。
- 修改规则请走**后台规则表单或 API**，改完建议把校准结论同步回 `mini-services/backend-go/seed/seed.json`（随仓库分发，下次空库播种即为新版）。
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
> 规则改动后的三段试测工具：`bun scripts/engine-rule-test.mjs <规则名> <URL> [list|book|chapter]`（直连 3030 引擎，不入库）。

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
cp /tmp/backup-dir/custom.db* db/
# 再按 §3 步骤 7 重新拉起；重启触发 running→paused 自愈，任务可在后台「恢复」
```

恢复后核对：`curl :3000/api/health`（dbOk:true）→ 后台总览统计 → 后台规则 tab 核对 15 条（或 `bun scripts/archive/dump-rules.ts`）。

### 7.3 规则重建（全新库）

**现行流程（Task 27 起，种子固化）**：

1. `bun run db:push` 建表；
2. 按 §3 步骤 7 启动 backend-go —— 检测到规则/分类空表即自动播种 15 规则 + 9 分类 + homeConfig（§1.4），**无需任何手工步骤**。

<details>
<summary>历史流程（存档，仅在需要恢复非种子版本数据时参考）</summary>

1. 11 旧站规则：从 git 历史或备份 JSON 恢复（后台规则表单**全字段**录入）；
2. 4 新站规则：`bun scripts/archive/add-new-rules.ts`（幂等 upsert）；
3. 核对总数：`bun scripts/archive/dump-rules.ts` 应输出 15 条。

</details>

### 7.4 封面与正文

- 封面：`public/covers/{id}.jpg`，普通文件，随目录整体备份；
- 正文：全部在 DB（Chapter 表），随 §7.1 备份覆盖；
- 模板/样式：Go 模板与 `tw.css` 属代码资产，随 git 仓库走，改模板后重跑 `bun run build:css`。

---

## 8. 常见问题排查

### 8.1 页面不可达：按链路逐层排查

```
请求 :3000 → 不通/502 ？
   │
   ├─ ① backend-go 活着吗？  curl -s http://127.0.0.1:3000/api/health
   │      不通 → 看 /tmp/backend-go-api.log 与 /tmp/dev-supervisor.log；
   │      dev-go 循环在跑时崩溃 2s 自动重拉；拉不起来常见为端口被占/二进制缺失/DB_PATH 错误，逐项核对
   │
   └─ ② 引擎活着吗？  curl -s :3030/api/health
          不通 → 不影响页面浏览，只影响采集；runner 30s 内互监护拉起，或手动：
          cd mini-services/scraper-go && setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 &
```

> 无代理层后，「502 由代理返回」的历史报错形态（`后端服务不可用 fetch failed` / `后端服务响应超时`）不再出现；backend-go 死亡时表现为连接拒绝（connection refused），直接按 ① 排查。

### 8.2 端口占用（拉起失败第一嫌疑）

```bash
ss -ltnp | grep -E ':(3000|3030)\b'
# 双开残留 → 精确清掉再拉（[.] 字符类防 pkill 自匹配）
pkill -f 'backend-go[.]bin'; pkill -f 'scraper-[g]o.bin'
```

### 8.3 Go 工具链被回收（go: command not found）

沙箱实证 `/home/z/go-sdk` 会被周期清理。恢复三步（§2.3 原文）：aliyun tarball 重解压 → `export PATH` → `go version` 验证。二进制（backend-go.bin / scraper-go.bin）不受影响，运行中的服务不需要重新编译。

### 8.4 SQLite WAL 锁 / busy / malformed

| 症状 | 处置 |
|------|------|
| `database is locked` / busy | busy_timeout 已设 5s，偶发竞争会自动重试；**检查是否有第二个写者**（TS worker / 旧进程 / 手开 sqlite3 写事务）——单写者原则必须维持 |
| `database disk image is malformed` | 多为 WAL inode 分裂（mv 替换/多进程混写）所致。按 §7.2 全停持有者 → 从备份恢复；或抢救：只读导出健康数据到新库（Task 22 实操流程，integrity_check 确认后整体替换） |
| 规则/分类莫名变空 | 沙箱回收重置了 DB → 直接重启 backend-go，种子机制自动回填（§1.4），无需人工恢复 |

### 8.5 采集侧速查

| 症状 | 处置 |
|------|------|
| 任务长期 `pending` | runner 不在：看心跳文件与 backend-go 日志；或规则 `enabled=false` 被跳过 |
| 全策略 challenge-page 拦截 | 先跑 `bash scripts/install-curl-impersonate.sh`（~/.local/bin 可能被清）；仍拦截 → 该站引擎指纹被针对（如 101kks），结论记规则 notes，见 scrape-rules.md |
| list 提取 0 本 | 站点改版，选择器失效：直连（系统 curl）看真实 HTML 校准 listRule，参考 24-d 两次校准记录（ggd66 #gengxin、x2552 #centeri）；改完可用 `bun scripts/engine-rule-test.mjs` 三段试测 |
| 章节正文被限速熔断 | 站点对高频掐流量（aijjxs/23qb/xinjianpan 实训）：等冷却后重启/恢复任务，骨架自动续传 |

### 8.6 CSS 类名不生效（模板改了但页面没样式）

Tailwind 只认构建时扫描到的类名：改 Go 模板 / static JS 后**必须** `bun run build:css` 重新生成 `tw.css`（§3 步骤 5；`bun run build` 已内置该步）。

---

## 9. 生产部署建议（systemd 双进程）

1. **进程管理换 systemd**：本仓库的看护循环（dev-go 自愈 / 互监护 / ensure-services）是为无 systemd 的沙箱设计的兜底；生产环境建议**两个 unit**（backend-go / scraper-go）+ `Restart=always`，看护语义等价且更透明。Next 时代的第三个 unit 已不需要——3000 由 backend-go 直接承载。

```ini
# /etc/systemd/system/novel-backend.service
[Unit]
Description=novel backend-go (web+api+runner)
After=network.target

[Service]
WorkingDirectory=/opt/my-project/mini-services/backend-go
Environment=BACKEND_PORT=3000
Environment=BACKEND_MODE=all
Environment=DB_PATH=/opt/my-project/db/custom.db
ExecStart=/opt/my-project/mini-services/backend-go/backend-go.bin
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/novel-scraper.service
[Unit]
Description=novel scraper-go engine
After=network.target

[Service]
WorkingDirectory=/opt/my-project/mini-services/scraper-go
Environment=SCRAPER_PORT=3030
Environment=PATH=/home/deploy/.local/bin:/usr/local/bin:/usr/bin:/bin   # 含 curl-impersonate
ExecStart=/opt/my-project/mini-services/scraper-go/scraper-go.bin
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

2. **反向代理**：Nginx/Caddy 直接指向 **3000**（backend-go 已渲染全部页面与 API，单栈后无第二跳可选）。
3. **备份**：cron 每日 `sqlite3 .backup`（§7.1 方式 A）+ 异机存放；规则资产已有种子兜底（§1.4），备份仍有价值（种子只保空表初值，不保运行期编辑）。
4. **构建**：`bash scripts/build-go.sh` 一步构建双二进制 + CSS；`go build` 可加 `-trimpath -ldflags "-s -w"` 缩小二进制。**部署产物必须携带 `web/` 目录**（模板为磁盘加载，二进制不内嵌模板）。
5. **合规**：引擎内置域名限速 ≥1.2s、robots warn-only、无验证码破解/登录态伪造；请遵守目标站 robots 与当地法规，仅采集公开内容。

---

## 10. 目录结构与脚本清单

### 10.1 关键目录

```
my-project/
├─ mini-services/backend-go/         # :3000 单进程（web.go/web_data.go/api_*.go/worker.go/runner.go/seed.go/…）
│  ├─ seed/seed.json                 # 内嵌种子：15 规则 + 9 分类 + homeConfig 三区块
│  ├─ web/templates/{10 主题,_fallback,admin}/
│  ├─ web/static/{css/tw.css, js/}
│  └─ web-src/tw-input.css           # Tailwind 入口（@source 扫模板/静态资源/gradient-tokens.txt）
├─ mini-services/scraper-go/         # :3030 引擎（chain.go/strategies.go/curlimp.go/fetchcurl.go/…）
├─ prisma/schema.prisma              # 表结构权威参考（Go 直连共享库；db:push 建库/同步用）
├─ db/custom.db(-shm/-wal)           # 唯一存储（SQLite WAL）
├─ public/covers/                    # 采集封面落盘
├─ docs/                             # 本文档 + scrape-rules.md + anti-anti-crawl.md
└─ scripts/                          # 运维脚本（见下表）
```

> `src/`、`next.config.ts`、`postcss.config.mjs`（Next CSS 管线）已随 Next.js 拆除删除；`package.json` 仅剩 5 个依赖包。

### 10.2 scripts/ 活跃脚本（Task 27-d 清理后，共 6 项）

| 脚本 | 用途 | 运行 |
|------|------|------|
| `dev-go.sh` | dev 入口自愈循环：启动 backend-go（:3000 mode=all，页面+API+runner），崩溃 2s 重拉，防双实例预检 | `bun run dev` |
| `build-go.sh` | 构建双二进制（backend-go.bin / scraper-go.bin）+ Tailwind CSS | `bun run build` |
| `ensure-services.sh` | 二级兜底：3000/3030 不通才拉起（幂等，可挂 cron） | `bash scripts/ensure-services.sh` |
| `build-web-css.mjs` | Tailwind v4 构建（扫 Go 模板/静态资源/gradient-tokens → tw.css） | `bun run build:css` |
| `engine-rule-test.mjs` | 规则三段试测（读 DB 规则 → 直连 3030 引擎，不入库） | `bun scripts/engine-rule-test.mjs <规则名> <URL> [list\|book\|chapter]` |
| `install-curl-impersonate.sh` | 重装 curl-impersonate 21 二进制到 ~/.local/bin | `bash scripts/install-curl-impersonate.sh` |

> 历史脚本（TS 时代诊断 probe-*、forensic-*、check-*、fix-*、规则补数 add-new-rules/dump-rules/check-rules-integrity、Next 看护 dev-supervisor.sh、任务监控 26a-monitor.mjs 等 44 项）已归档至 `scripts/archive/`（历史留档，硬编码路径可能失效，不再维护；部分仍可 bun 直跑）。

### 10.3 package.json scripts 速查

| 命令 | 实际执行 | 说明 |
|------|----------|------|
| `bun run dev` | `bash scripts/dev-go.sh` | backend-go :3000 自愈循环（页面+API+runner） |
| `bun run start` | `bash scripts/dev-go.sh` | 同 dev |
| `bun run build` | `bash scripts/build-go.sh` | 双 Go 二进制 + tw.css |
| `bun run build:css` | `bun scripts/build-web-css.mjs` | 模板类名变更后必跑 |
| `bun run db:push` | `prisma db push --accept-data-loss` | 建库/同步 schema |
| `bun run db:generate` | `prisma generate` | 生成 Prisma Client（engine-rule-test 等工具用） |
| `bun run lint` | `eslint .` | 代码检查 |
