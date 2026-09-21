# novel-admin 安装部署图文教程

> 适用版本：Go 后端架构（backend-go + scraper-go，Task 13/18 迁移完成后的形态）。
> 本教程所有命令均按「可直接复制执行」标准编写；**已在本环境（/home/z/my-project）实测验证过的命令**会标注 ✅，无法在本环境重放（有副作用或会干扰运行中服务）的命令标注 ⚠️ 未验证。
> 专题文档：[反反爬技术选型](anti-anti-crawl.md) · [采集规则分析（11 站点实测）](scrape-rules.md)

---

## 目录

1. [项目简介与架构总览](#1-项目简介与架构总览)
2. [环境要求](#2-环境要求)
3. [安装步骤](#3-安装步骤)
4. [界面截图](#4-界面截图真实截图)
5. [采集规则配置指南](#5-采集规则配置指南)
6. [日常使用：创建与管理采集任务](#6-日常使用创建与管理采集任务)
7. [PSEO 关键词引擎使用](#7-pseo-关键词引擎使用)
8. [反反爬与合规](#8-反反爬与合规)
9. [自愈机制与运维](#9-自愈机制与运维)
10. [故障排查表](#10-故障排查表)
11. [生产部署建议](#11-生产部署建议)
12. [目录结构说明](#12-目录结构说明)

---

## 1. 项目简介与架构总览

novel-admin 是一个小说内容管理后台，采用 **Next.js 16 UI + 全 Go 后端** 的双层架构：

- **Next.js（端口 3000）**：负责页面渲染（8 套可切换主题、哈希路由管理后台 `/#/admin`），并通过一个 20 行的 catch-all 代理（`src/app/api/[...path]/route.ts`）把全部 `/api/*` 请求原样转发到 Go 后端。
- **backend-go（端口 3005）**：全部业务 API（书籍/章节/分类/设置/PSEO/采集任务）+ 采集编排 runner，`BACKEND_MODE=all` 时一个进程两个职责，是 SQLite 数据库的**唯一写入方**。
- **scraper-go（端口 3030）**：反反爬抓取引擎，内置 7 策略链（fetch-browser / ua-rotate / mobile / spider → curl-impersonate → got-scraping 等价 → browser Playwright 桥接）。
- **SQLite（db/custom.db，WAL 模式）**：唯一存储；封面文件落盘 `public/covers/{id}.jpg`。

### 1.1 架构图

```mermaid
flowchart LR
    B["浏览器<br/>前台阅读页 / #/admin 管理后台"] -->|"HTTP :3000"| N["Next.js 16<br/>UI 渲染 + catch-all 代理<br/>src/app/api/[...path]/route.ts"]
    N -->|"转发 /api/*<br/>127.0.0.1:3005（65s 超时）"| BG["backend-go :3005<br/>BACKEND_MODE=all<br/>业务 API + 采集 runner"]
    BG -->|"SQL（唯一写入方）"| DB[("SQLite db/custom.db<br/>WAL 模式")]
    BG -->|"POST /api/test /api/chapter<br/>127.0.0.1:3030（60s 预算）"| SG["scraper-go :3030<br/>反反爬引擎 · 7 策略链"]
    SG -->|"策略链依次降级"| T["目标网站<br/>（限速 ≥1.2s/域名 · robots warn-only）"]
    SG -.->|"可选 browser 策略"| PY["Python3 + Playwright<br/>scripts/render.py 桥接"]
    SG -.->|"可选 TLS 指纹伪装"| CI["curl-impersonate 二进制<br/>~/.local/bin"]

    subgraph S ["自愈三层"]
        L1["① Next 进程内 supervisor<br/>src/lib/backend-supervisor.ts<br/>502 自动重拉 backend-go（秒级）"]
        L2["② scripts/ensure-services.sh<br/>定时兜底拉起 3005/3030（分钟级）"]
        L3["③ runner ⇄ 引擎互监护<br/>每 30s 互相探活拉起"]
    end
    L1 -.-> BG
    L2 -.-> BG
    L2 -.-> SG
    L3 -.-> BG
    L3 -.-> SG
```

### 1.2 组件职责表

| 组件 | 端口 | 语言/运行时 | 职责 | 源码目录 |
|------|------|-------------|------|----------|
| Next.js 前端 | 3000 | TypeScript（Bun ≥1.3 / Node ≥20） | 主题化 UI 渲染、`/#/admin` 管理后台、`/api/*` catch-all 代理转发 | `src/`（代理层 `src/app/api/[...path]/route.ts`） |
| backend-go | 3005 | Go ≥1.22 | 全部业务 API；采集编排 runner（任务轮询/两阶段管线/心跳/封面落盘/LLM 归类）；`BACKEND_MODE=all` 同进程承载 | `mini-services/backend-go/` |
| scraper-go | 3030 | Go ≥1.22 | 反反爬抓取引擎：策略链、字符集解码（GBK/GB18030）、SSRF 防护、限速、JSON 目录接口 | `mini-services/scraper-go/` |
| scraper-service | — | TypeScript（已退役） | 旧 TS 引擎，**仅作回滚备份，不再运行**（与 Go runner 并存会双写任务） | `mini-services/scraper-service/` |
| SQLite | — | — | 唯一存储 `db/custom.db`（WAL + busy_timeout 5s + FK）；由 Prisma `db push` 建表 | `db/`、`prisma/schema.prisma` |
| curl-impersonate | 可选 | C 二进制 | TLS/JA3 指纹级伪装（Chrome/Firefox/Edge/Safari），突破 TLS 指纹检测 | `~/.local/bin`（安装脚本 `scripts/install-curl-impersonate.sh`） |

> 说明：Prisma 在 Next 侧已无运行时引用（仅用于建表/生成客户端）；backend-go 直连同一个 SQLite 文件，库路径由环境变量 `DB_PATH` 指定，缺省回退 `/home/z/my-project/db/custom.db`。

---

## 2. 环境要求

| 组件 | 版本要求 | 本环境实测 | 是否必需 |
|------|----------|------------|----------|
| Bun | ≥ 1.3 | 1.3.14 ✅ | 必需（前端依赖安装、dev/start 脚本） |
| Go | ≥ 1.22（两个 `go.mod` 均声明 `go 1.22`） | 1.22.5 ✅ | 必需（编译 backend-go / scraper-go） |
| Node.js | ≥ 20（Next.js 16 要求） | v24.21.0 ✅ | 必需（Next dev 运行时；生产 standalone 也可用 Bun 启动） |
| Python 3 | ≥ 3.8 | 3.12.14 ✅ | 可选（browser 策略的 Playwright 桥接 `scripts/render.py`） |
| Playwright（Python） | — | 沙箱已内置 Chromium | 可选（未安装时 browser 策略自动显示不可用，其余 6 策略不受影响） |
| curl-impersonate | v0.6.1 | 已安装（~/.local/bin） | 可选（TLS 指纹伪装，见 §8） |

### 2.1 Linux（Debian/Ubuntu）安装命令

```bash
# Bun（官方脚本，装到 ~/.bun）
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Go 1.22（官方 tarball）
curl -sL -o /tmp/go.tgz https://go.dev/dl/go1.22.5.linux-amd64.tar.gz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tgz
export PATH=$PATH:/usr/local/go/bin

# Node.js 20+（任选其一：nvm / NodeSource）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs

# Python3 + Playwright（可选，browser 策略）
sudo apt-get install -y python3 python3-pip
pip3 install playwright && python3 -m playwright install chromium
```

### 2.2 macOS 安装命令

```bash
brew install bun go node@20          # 三件套
brew install python@3.12 && pip3 install playwright && python3 -m playwright install chromium  # 可选
```

> **本沙箱特例**：Go 安装在 `/home/z/go-sdk/go/bin`（不在默认 PATH），执行 go 命令前需
> `export PATH=$PATH:/home/z/go-sdk/go/bin`（仓库内 `run.sh` 已自动处理）。

---

## 3. 安装步骤

> 以下命令以全新机器为例，项目根目录写作 `~/my-project`（本沙箱为 `/home/z/my-project`，请按实际替换）。
> 步骤 1-4 涉及依赖安装与建库，⚠️ 未在本环境重放（依赖已装、库已建，重放会改动数据/服务）；步骤 5 的 go build ✅ 已实测；步骤 7 的三条健康检查 ✅ 已实测并附真实输出。

### 步骤 1：获取代码并进入目录

```bash
git clone <你的仓库地址> my-project
cd my-project
```

### 步骤 2：安装前端依赖

```bash
bun install
```

> `@prisma/client` 的 postinstall 会自动执行 `prisma generate` 生成客户端；若未自动生成，补跑 `bun run db:generate`。

### 步骤 3：配置环境变量

仓库根目录的 `.env` 只需要一项（数据库连接，供 Prisma CLI 建表用）：

```bash
# .env（按你的实际部署路径修改；目录必须先存在）
mkdir -p db
cat > .env <<'EOF'
DATABASE_URL=file:/home/z/my-project/db/custom.db
EOF
```

| 变量 | 作用 | 谁在用 |
|------|------|--------|
| `DATABASE_URL` | SQLite 文件路径（Prisma 建表/生成客户端） | Prisma CLI |
| `DB_PATH` | backend-go 运行时读库路径（**缺省硬编码 `/home/z/my-project/db/custom.db`，部署到其他机器必须显式设置**） | backend-go |
| `BACKEND_PORT` | backend-go 监听端口（缺省 3005） | backend-go |
| `BACKEND_MODE` | `api` / `runner` / `all`（缺省建议 `all`） | backend-go |
| `SCRAPER_PORT` | 引擎端口（缺省 3030） | scraper-go |
| `COVERS_DIR` | 封面落盘目录（缺省自动向上查找 `public/covers`） | backend-go |

> 两处路径必须指向**同一个文件**：`DATABASE_URL`（建表时）= `DB_PATH`（运行时）。

### 步骤 4：初始化数据库

```bash
bun run db:push
```

> 实际执行 `prisma db push --accept-data-loss`：按 `prisma/schema.prisma` 在 `DATABASE_URL` 指向的路径创建/同步 SQLite 文件（即 `db/custom.db`）与全部表（Novel/Chapter/Category/SiteSetting/ScrapeRule/ScrapeTask/PseoKeyword），并生成 Prisma Client。
> ⚠️ 该命令对既有库有 schema 同步语义，请勿对生产库随手执行。

### 步骤 5：编译两个 Go 服务 ✅（已实测）

```bash
# 编译 backend-go（业务 API + 采集 runner）
cd mini-services/backend-go && go build -o backend-go.bin .

# 编译 scraper-go（抓取引擎）
cd ../scraper-go && go build -o scraper-go.bin .

# 回到项目根目录
cd ../..
```

> - 两个服务依赖极少（backend-go 仅 `modernc.org/sqlite` 纯 Go 驱动；scraper-go 仅 goquery），首次编译约 1-2 分钟。
> - 实测产物大小：backend-go.bin ≈ 15MB，scraper-go.bin ≈ 10MB。
> - 也可用一键脚本 `bash mini-services/backend-go/run.sh`（构建 + 前台运行，自动补 PATH）。
> - 本教程编写时已将两条 go build 命令完整跑通验证（产物输出到 /tmp 后删除）。

### 步骤 6：启动服务（顺序：scraper-go → backend-go → Next）

**前台启动（调试用，各开一个终端）：**

```bash
# 1) 引擎（先起，runner 探测到 3030 才会标记引擎在线）
cd mini-services/scraper-go && ./scraper-go.bin

# 2) 业务后端 + 采集 runner（all 模式）
cd mini-services/backend-go && BACKEND_PORT=3005 BACKEND_MODE=all ./backend-go.bin

# 3) Next 前端（开发模式）
cd ../.. && bun run dev
```

**后台化启动（生产/长跑用 `setsid nohup`，与仓库 `scripts/ensure-services.sh` 内的写法一致）：**

```bash
cd /home/z/my-project

# 引擎 → 日志 /tmp/engine.log
cd mini-services/scraper-go && \
  setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 </dev/null &

# 后端（all 模式）→ 日志 /tmp/backend-go-api.log；DB_PATH 按需设置
cd ../backend-go && \
  setsid nohup env BACKEND_PORT=3005 BACKEND_MODE=all \
  DB_PATH=/home/z/my-project/db/custom.db \
  ./backend-go.bin >> /tmp/backend-go-api.log 2>&1 </dev/null &

# Next 开发模式 → 日志 dev.log（项目根目录，脚本自带 tee）
cd /home/z/my-project && setsid nohup bun run dev >> /dev/null 2>&1 </dev/null &
```

> ⚠️ 以上后台化命令未在本环境重放（当前三服务均在运行中，重放会造成端口冲突/进程双开）；命令形态与仓库 `scripts/ensure-services.sh`（该脚本正在生产执行）完全一致。
> **生产模式 Next**：`bun run build && bun run start`（build 脚本会把 `.next/static` 与 `public/` 拷入 standalone 目录；start 以 `NODE_ENV=production bun .next/standalone/server.js` 启动，日志 tee 到 `server.log`）。构建类命令未在本环境重放。

**一键兜底**（幂等，探测 3005/3030 不通才拉起，可挂 cron 每分钟）：

```bash
bash scripts/ensure-services.sh
```

### 步骤 7：验证安装 ✅（已实测，以下为真实输出）

```bash
# ① Next 前端（3000）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
# → 200

# ② backend-go 健康检查（3005）
curl -s http://127.0.0.1:3005/api/health
# → {"db":"/home/z/my-project/db/custom.db","dbOk":true,"ok":true,"runtime":"go1.22",
#    "service":"backend-go","time":"2026-09-21T15:58:58.920Z","version":"1.0.0"}

# ③ 引擎健康检查（3030）
curl -s http://127.0.0.1:3030/api/health
# → {"ok":true,"port":3030,"service":"scraper-service","time":"2026-09-21T15:58:58.928063305Z"}

# ④ 经 Next 代理的链路验证（3000 → 3005）
curl -s http://127.0.0.1:3000/api/health | head -c 120
```

**浏览器验证**：

- 打开 `http://localhost:3000/` → 应看到前台首页（当前启用主题的渲染效果，见 §4 图 1）；
- 打开 `http://localhost:3000/#/admin` → 应看到「站点管理控制台」（左侧导航：主题/书籍/分类/SEO/采集中心/目录体检/PSEO/设置）；
- 进入「采集中心」→ 顶部「采集引擎状态（scraper-service :3030)」卡片应显示引擎在线与各策略可用性（见 §4 图 3）。

---

## 4. 界面截图（真实截图）

> 以下截图全部来自本环境实际运行中的系统（viewport 1280×900，2026-09 实拍），非示意图。

### 图 1：前台首页（主题渲染效果）

![前台首页](images/home.png)

前台首页由当前启用主题（站点设置中的 `activeTheme`，截图时为 aijjxs 系）渲染：书封卡片、分类导航、排行榜与最近更新等板块全部来自 `db/custom.db` 真实数据；标题「青阅文学」可在管理后台「设置」中修改。

### 图 2：管理后台概览（`/#/admin` 默认落地「主题」页）

![管理后台概览](images/admin-overview.png)

`/#/admin` 为哈希路由的管理后台，左侧导航含 8 个区块：主题、书籍、分类、SEO、采集中心、目录体检、PSEO、设置；「主题」页可一键启用 8 套内置主题（点击「启用」即时切换全站皮肤）。

### 图 3：采集中心（引擎状态 + 规则卡列表 + 新建任务 + 任务列表）

![采集中心](images/admin-scrape.png)

采集中心自上而下：

- **引擎状态卡**：scraper-go :3030 在线状态与 7 策略可用性（含 curl-impersonate 是否可用）；
- **采集规则列表**：每条规则一张卡（启用开关 / 编辑 / 删除），右上「新建规则」「内置模板入库」「清洗存量章节」；
- **新建采集任务**：单本采集（书页 URL）与范围采集（列表页 URL + 页数）两种模式，可指定规则；
- **任务列表**：ID/模式/目标 URL/状态/进度/成果/时间/操作（日志、取消、删除）。

### 图 4：规则编辑弹窗（以「大悟读书网(5165)」为例）

![规则编辑弹窗](images/admin-rules.png)

编辑弹窗按「基本 → 列表页规则 → 书籍页规则 → 章节页规则 → 备注」分组：

- 基本：名称、`siteUrl`、`charset`（GBK 站点必改）、站点级代理、启用开关、**跳过 TLS 证书校验**（insecureTLS，自签/裸 IP 站点用）；
- 列表页：条目/标题/链接/作者/分类选择器 + 分页模板（`{k}` 页码占位）；
- 书籍页：标题/作者/简介/封面/状态/目录链接选择器 + **目录接口（chapterListApi）** JSON 配置框（图中回显 ixdzs8 的完整配置）；
- 章节页：标题/正文选择器、下一页选择器、剔除节点、备注。

### 图 5：PSEO 页面（多引擎下拉词 + 关键词库 + 自动生成）

![PSEO 页面](images/admin-pseo.png)

PSEO 页面包含：多引擎下拉词开关（百度/必应/DuckDuckGo/搜狗/360）、种子关键词（每行一个，最多 20 个）、每种子保留词数、单次入库上限、获取后自动生成聚合页开关、二级挖掘开关、「试取预览」「开始批量获取」按钮，以及关键词库（手工添加/重新生成聚合页）。

---

## 5. 采集规则配置指南

采集规则存储在 `ScrapeRule` 表（管理后台「采集中心 → 新建/编辑规则」可视化编辑，字段与数据库一一对应）。

### 5.1 ScrapeRule 字段总表

| 字段 | 类型/缺省 | 说明 |
|------|-----------|------|
| `name` | String，唯一 | 规则名，如「大悟读书网(5165)」 |
| `siteUrl` | String | 站点根 URL（**必须是真实列表页可达的站点根**；列表/书页/章节 URL 均相对它解析） |
| `enabled` | Boolean，缺省 true | 停用的规则不参与任务执行（草稿规则用） |
| `charset` | String，缺省 `utf-8` | 目标站编码；GBK/GB2312 老站**必填** `gbk`（引擎七级解码：BOM→响应头→meta→UTF-8 嗅探→GB18030→latin1） |
| `proxy` | String，缺省空 | 站点级出口代理，空=直连；支持 `http(s)://`、`socks5://`、`socks5h://user:pass@host:port`（反爬 IP 信誉突破） |
| `insecureTLS` | Boolean，缺省 false | 跳过目标站 TLS 证书校验，适用于自签证书/裸 IP 站点（如 `https://38.34.172.127`），全策略链生效 |
| `listRule` | JSON 字符串 | 列表页选择器（范围采集入口） |
| `bookRule` | JSON 字符串 | 书籍页选择器；可内嵌 `chapterListApi`（JSON 目录接口） |
| `chapterRule` | JSON 字符串 | 章节正文页选择器 |
| `notes` | String | 站点结构说明/实测结论/维护提示（强烈建议填写实测日期与结论） |

### 5.2 选择器 JSON 结构（真实示例）

选择器值支持 **CSS 选择器 + `@attr` 后缀**：`sel` 取 textContent，`sel@src`/`sel@href`/`sel@content`/`sel@value` 取对应属性；多个选择器用**英文逗号分隔表示备选**（从左到右命中即用）。以下为规则 #5「大悟读书网(5165)」的真实落库配置（WordPress 结构站点）：

```json
{
  "listRule": {
    "itemSelector": ".entry-content ul li",
    "titleSelector": "p a, a",
    "linkSelector": "a",
    "authorSelector": "span.text-muted",
    "paginationTemplate": ""
  },
  "bookRule": {
    "titleSelector": "h1.page-title",
    "authorSelector": "#category-description-author",
    "descriptionSelector": "#category-description-text",
    "coverSelector": "#category-description-image img@src",
    "chapterLinkSelector": "a[rel=\"contents\"]"
  },
  "chapterRule": {
    "titleSelector": "h1",
    "contentSelector": ".entry-content"
  }
}
```

**listRule 字段**：

| 字段 | 必填 | 说明 |
|------|------|------|
| `itemSelector` | ✅ | 列表条目选择器（每个命中的元素视为一本书） |
| `titleSelector` | 建议 | 条目内标题选择器（备选逗号分隔） |
| `linkSelector` | ✅ | 条目内书页链接选择器（相对 `siteUrl` 解析） |
| `authorSelector` / `categorySelector` | 可选 | 作者 / 分类 |
| `paginationTemplate` | 可选 | 列表翻页模板，见 5.3 |

**bookRule 字段**：`titleSelector`、`authorSelector`、`descriptionSelector`、`coverSelector`（`@src`/`@content` 取图址，og:image 亦可）、`statusSelector`（连载/完本）、`chapterLinkSelector`（书页内嵌目录链接）、`catalogLinkSelector`（书页只有「点击阅读」入口时，二次抓整目页）、`chapterTitleInLinkSelector`（链接内标题）、`removeSelectors`（提取前剔除的噪声节点）、`chapterListApi`（见 5.4）。

**chapterRule 字段**：`titleSelector`、`contentSelector`（正文容器，支持逗号备选）、`nextSelector`（下一页链接，CMS 分页自动跟随拼接）、`removeSelectors`（剔除广告/推荐块）。

> 杰奇 CMS（GBK 老站常见）的完整实战示例与 11 站点实测结论，见 [`docs/scrape-rules.md`](scrape-rules.md)。

### 5.3 列表分页模板

`listRule.paginationTemplate` 严格按模板生成各页 URL（不配置时引擎按常见规律自动猜测翻页）：

- `{k}` = 页码（1, 2, 3, …），例如 ixdzs8 的真实配置：`https://ixdzs8.com/new/?page={k}`；
- `{url}` = 首页 URL 的 `encodeURIComponent` 编码值（个别站点把列表地址作为参数传递时使用）。

### 5.4 chapterListApi：JSON 目录接口（书页不内嵌全目录时用）

部分现代 CMS 书页只显示最新几章，全量目录藏在 POST 接口里。此时在 `bookRule.chapterListApi` 内嵌一段 JSON 配置（读取规则 #8「爱下电子书(ixdzs8)」的真实落库值）：

```json
{
  "url": "/novel/clist/",
  "method": "POST",
  "body": "bid={bookId}",
  "bookIdSelector": "#bid@value",
  "listPath": "data",
  "titleField": "title",
  "orderField": "ordernum",
  "skipField": "ctype",
  "skipValue": "1",
  "urlTemplate": "/read/{bookId}/p{order}.html"
}
```

| 字段 | 说明 |
|------|------|
| `url` | 目录接口地址（**强制同源校验**，相对 `siteUrl` 解析，带 SSRF 防护） |
| `method` / `body` | 请求方法与表单体；`{bookId}` 占位符替换为书内编号 |
| `bookIdSelector` | 从书页提取书编号的选择器（如隐藏 input `#bid@value`） |
| `listPath` | 响应 JSON 中章节数组所在路径（如 `data`） |
| `titleField` / `orderField` | 每个条目的标题字段 / 排序字段 |
| `skipField` / `skipValue` | 跳过卷标行（如 `ctype=1` 为卷名不采） |
| `urlTemplate` | 章节正文页 URL 模板，`{bookId}`/`{order}` 占位 |

> 仅当接口返回条目多于书页内嵌目录时才采用接口结果（条目上限 10000）。

### 5.5 建规则方法论

推荐流程（详细案例拆解见 [`docs/scrape-rules.md`](scrape-rules.md)）：

1. 打开目标站首页，找到「最近更新 / 最新入库」模块 —— 该模块天然是一个列表页；
2. 浏览器 DevTools 检查模块 HTML，确定 `itemSelector`（条目）、`linkSelector`（书页链接）；
3. 打开一本样例书页，确定书籍元数据与目录选择器；再打开一个章节页确定正文选择器；
4. 管理后台「新建规则」填入三段选择器并保存；先用「新建任务 → 单本采集」验证一本书能否完整入库，再开范围采集；
5. 把实测结论写进 `notes`（站点模板族、编码、翻页规律、坑点），方便后续维护。

---

## 6. 日常使用：创建与管理采集任务

### 6.1 创建任务

入口：管理后台 → 采集中心 → 「新建采集任务」。

| 模式 | 填写 | 行为 |
|------|------|------|
| **单本采集**（single） | 书页 URL（如 `https://www.ddyueshu.cc/2_2246/`），可选规则 | 采一本书：Phase 1 解析全目录建骨架 → Phase 2 并发填充正文 |
| **范围采集**（list） | 列表页 URL（规则 `siteUrl` 下的真实列表页），指定规则与**页数**（1-999） | 按分页模板逐页收集书籍 → 逐书建骨架 → 跨书平铺填充正文 |

规则不选时任务无法确定选择器（下拉里「不使用规则」仅用于任务URL直采等特殊场景，常规必须绑定规则）。

### 6.2 任务状态机

```
pending（排队，等 runner 每 2s 轮询领取）
   └→ running（执行中）
        ├→ success   全部成功
        ├→ partial   部分成功（个别书/章失败，看 log）
        ├→ failed    整体失败
        ├→ canceled  手工取消（协作式停止：当前章节采完即停）
        └→ paused    手工暂停（协作式安全停手，进度保留，可随时恢复）
             └→ pending（恢复：重新入队，已采进度保留，缺失正文自动续传）
```

- **编辑**：`pending` 与 `paused` 状态均可改（mode/targetUrl/ruleId/pages）；`running` 需先暂停（「暂停 → 改参数 → 恢复」即可按新参数续采），终态任务引导新建。
- **暂停**：`pending` / `running` 状态点「暂停」。执行中任务由 worker 协作式感知（≤数秒在安全点停手，绝不覆盖 paused 状态），进度字段（done/total/chaptersDone 等）全部保留；待执行任务暂停后直接脱离 runner 轮询池。
- **恢复**：仅 `paused` 可恢复，重新入队 `pending`（日志追加恢复记录）；runner 领取后 Phase 1/2 依骨架自动续传——已有正文跳过、缺失正文补抓，不会重复采集。
- **取消**：`running` 状态点「取消」，协作式停止（非强杀），进度与已采数据保留，日志记录 cancel 位置。
- **删除**：终态与 `paused` 任务可删（任务记录与数据无关，删任务不动已入库书籍）。
- **服务重启保护**：backend-go 重启时，遗留 `running` 任务自动转为 `paused`（日志记录「服务重启，任务中断自动暂停」），不再误标 `failed`；遗留 `pending` 任务保持不动（新 runner 2s 内自动领取）。重启后到 PSEO/采集中心点「恢复」即可无损续采。

### 6.3 进度字段含义

| 字段 | single 模式 | list 模式 |
|------|-------------|-----------|
| `total` / `done` | 章节数（分母/分子） | 书籍数（分母/分子） |
| `chaptersDone` / `chaptersTotal` | — | 章节级副进度（跨书累计 / 随书页解析逐步累加） |
| `created` / `updated` | 新建/更新的书籍数（single 恒 0/1） | 新建/更新书籍数 |
| `chapters` | 采集章节数 | 采集章节数 |
| `log` | 追加式运行日志（`\n` 分隔，保留最近 100 行），任务列表点「日志」查看 | 同左 |

> `done` 按 200 章/批 flush 属正常设计；Phase 1（建骨架）快、Phase 2（填正文）慢且受目标站限速约束（每域名 ≥1.2s），速率以每小时数万章为正常区间。

### 6.4 日志查看

- **任务级日志**：采集中心任务列表 →「日志」按钮（读取 `ScrapeTask.log`）；
- **runner 在线判定**：任务创建后若长期 `pending`，先看 §9 心跳与进程；
- **进程日志**：`dev.log`（Next，项目根）、`/tmp/backend-go-api.log`（ensure-services 拉起的 backend-go）、`/tmp/engine.log`（引擎）、`/tmp/watchdog.log`（兜底脚本动作）。

---

## 7. PSEO 关键词引擎使用

PSEO（程序化 SEO）通过搜索引擎**下拉词**批量获取长尾关键词入库，并自动生成聚合页。

### 7.0 书籍种子自动化（默认开启，无需配置）

**每本小说的书名即 PSEO 种子**（`mini-services/backend-go/pseo_book.go`）：

1. **入库即登记**：采集任务每入库/更新一本书（`upsertBook`），自动把书名写入关键词库（来源标记 `书籍种子`，状态 `pending`）。纯 DB 操作，零网络调用，不拖慢采集。
2. **后台富集**：runner 内置富集循环每 12 秒处理 1 个书名种子——取多引擎下拉词长尾（每种子保留词数遵循 PSEO 设置）→ 长尾词入库 → 为 pending 关键词生成聚合页（TDK 自动模板）。约百本书 ≈ 20 分钟全量富集；引擎全部故障时书名词仍会生成聚合页（按书名 LIKE 命中本书），功能不因引擎失效。
3. **书籍页标签**：书籍详情 API 返回 `tags`（书名词 + 作者词 + 已生成的含书名长尾词，上限 10 个），全部 10 套主题在**简介下方**渲染「相关标签」chips，点击进入对应聚合页（聚合页实时计算兜底，任何状态的关键词都有可用页面）。
4. 关键词库中来源徽标显示 `书籍种子` 的即自动登记词；手工添加/批量获取流程（下文）与其互不影响，去重由关键词唯一约束兜底。

### 7.1 多引擎下拉词（suggest）

入口：管理后台 → PSEO。支持 5 个引擎（`mini-services/backend-go/pseo_suggest.go`）：

| 引擎 | 接口 | 说明 |
|------|------|------|
| `baidu` | `www.baidu.com/sugrec` | JSON |
| `bing` | `api.bing.com/osjson.aspx` | JSON |
| `duckduckgo` | `duckduckgo.com/ac/` | JSON；**经引擎策略链**抓取（Go TLS 栈下可能被 Cloudflare 指纹识别超时，属已知差异——聚合语义允许可用引擎子集，其余引擎不受影响） |
| `sogou` | `www.sugproxy` 文本接口 | 括号格式解析 |
| `so360` | `sug.so.360.cn/suggest` | 文本 |

配置项：种子关键词（每行一个，最多 20 个）、每种子保留词数（3-20，缺省 12）、单次入库上限（10-500，缺省 200）、**获取后自动生成聚合页**开关、**二级挖掘**开关（以下拉词为新种子再挖一轮）。

### 7.2 使用流程

1. 勾选引擎、填种子词（如「都市小说」「玄幻完本」）→ 「开始批量获取」；
2. 下拉词去重后写入 `PseoKeyword` 表（`source` 记录来源引擎，`status=pending`）；
3. 若开启自动生成：每条关键词立即生成聚合页（命中站内书籍 + LLM 生成 TDK，写入 `pageData`，`status=generated`；LLM 失败记 `failed` 可重试）；
4. 「试取预览」只取首个种子做 dry-run 不入库；关键词库支持手工添加与「重新生成聚合页」。

---

## 8. 反反爬与合规

> 技术选型与策略链原理详见 [`docs/anti-anti-crawl.md`](anti-anti-crawl.md)；11 站点实测命中策略见 [`docs/scrape-rules.md`](scrape-rules.md)。本节只讲部署者需要做的事。

### 8.1 内置合规红线（代码级，不可配置绕过）

- 每域名限速 **≥1.2s**（1200ms±300ms 抖动），禁并发轰炸；
- `robots.txt` 解析为 **warn-only**（命中 Disallow 在结果中附 warning，不硬拦——由部署者自行判断合规性）；
- `Retry-After` 响应头优先遵守（30s 封顶）；
- 无验证码破解、无登录态伪造、无付费内容绕过逻辑；
- SSRF 逐跳校验（含重定向每一跳、IPv4/IPv6 全文本形态、DNS 校验 fail-closed）。

### 8.2 部署者可控的反反爬手段

| 手段 | 配置位置 | 适用场景 |
|------|----------|----------|
| 低频采集 | 天然约束，无需配置 | 一切场景；任务量大时分批发、避免夜间连续轰炸 |
| 站点代理 | 规则 `proxy` 字段（`socks5h://user:pass@host:port`） | IP 信誉被拉黑、需要住宅/机房出口切换 |
| insecureTLS | 规则开关「跳过 TLS 证书校验」 | 自签证书/裸 IP 站点（如 `https://38.34.172.127`） |
| charset | 规则 `charset` 字段填 `gbk` | GBK/GB2312 老站，避免正文乱码 |
| browser 策略 | 安装 Python3+Playwright 即自动启用 | JS 挑战/渲染型站点（每请求独立子进程浏览器，cookie 经环境变量注入回存） |
| curl-impersonate | 见下 | TLS/JA3 指纹检测（如 Cloudflare 对非浏览器指纹 403） |

### 8.3 curl-impersonate 安装与丢失重装

```bash
# 一键安装/重装（v0.6.1 x86_64-linux-gnu，21 个二进制 → ~/.local/bin）
bash scripts/install-curl-impersonate.sh
```

- 引擎启动时探测 PATH 与 `~/.local/bin` 中的 `curl_chrome*` / `curl-impersonate-*` 二进制；探测结果见采集中心引擎状态卡（或 `GET :3030/api/strategies`）。
- **空结果只缓存 60s**：重装后无需重启引擎，最多 1 分钟后自动亮起。
- 若显示 `available:false`：多半是二进制被环境清理（沙箱已多次发生），重跑安装脚本即可；`~/.local/bin` 不在引擎进程 PATH 时引擎侧已有 homedir 兜底探测。

---

## 9. 自愈机制与运维

### 9.1 三层自愈

| 层级 | 机制 | 触发/周期 | 源码 |
|------|------|-----------|------|
| ① 秒级 | Next 进程内 supervisor：catch-all 代理遇 502 → 自动重拉 backend-go（detached 托孤，5s 冷却）；首次任意 API 请求也会幂等拉起 | 每 502 一次 | `src/lib/backend-supervisor.ts`、`src/app/api/[...path]/route.ts` |
| ② 分钟级 | `scripts/ensure-services.sh`：探测 3005 `/api/health` 与 3030 `/api/strategies`，不通则 `pkill` 残留后拉起（**绝不拉起 TS runner**） | cron 每分钟或手动 | `scripts/ensure-services.sh` |
| ③ 30s 级 | runner ⇄ 引擎互监护：runner 每 30s 探引擎（拉起）；引擎每 30s 查 runner 心跳文件（超时拉起） | 常驻循环 | `mini-services/backend-go/runner.go`、`mini-services/scraper-go/main.go` |

### 9.2 心跳与日志位置

| 文件 | 含义 |
|------|------|
| `/tmp/scrape-runner-heartbeat` | runner 心跳（每轮刷新；采集 API 据此判定 runner 在线，10s 内视为存活） |
| `dev.log`（项目根） | Next dev 输出（脚本自带 `tee dev.log`） |
| `/tmp/backend-go-api.log` | ensure-services.sh 拉起的 backend-go 输出 |
| `/tmp/engine.log` | ensure-services.sh 拉起的引擎输出 |
| `/tmp/watchdog.log` | ensure-services.sh 每轮探测/拉起动作记录 |
| `server.log`（项目根） | 生产模式 `bun run start` 输出 |

> 注意：backend-go 由 Next supervisor 拉起时 stdout 被丢弃（detached+ignore）——此时以**任务 log 字段**与 `/api/health` 为准。

### 9.3 ⚠️ 严禁第二个 TS runner

- `bun scripts/worker-runner.ts`（TS 时代采集编排层）**已退役**，且**严禁与 Go runner 并存运行**：任务防重集是进程内的，双 runner 会**双写同一 ScrapeTask**（重复建书/重复采章/进度互相覆盖）。
- Go runner 具备外来 TS runner 的自动清理能力（互监护拉起命令用 `[g]`/`[r]` 字符类防自匹配），但请不要依赖兜底——部署时确保没有遗留的 TS runner 进程：
  ```bash
  ps aux | grep '[w]orker-runner'   # 应无输出
  ```
- 同理，`mini-services/scraper-service`（TS 引擎）仅作回滚备份，不要与 `scraper-go` 同时占用 3030。

---

## 10. 故障排查表

| 症状 | 可能原因 | 解决 |
|------|----------|------|
| 页面能开但 API 全部 502「后端服务不可用」 | backend-go 挂了 | 正常情况 supervisor 秒级自动拉起（等 5-10s 刷新）；持续 502 → 手动 `bash scripts/ensure-services.sh`，看 `/tmp/backend-go-api.log`；检查二进制是否存在（§3 步骤 5） |
| 采集中心「引擎状态」显示离线 / 采集报「引擎不可达」 | scraper-go 3030 未运行 | `curl -s http://127.0.0.1:3030/api/health` 验证；`bash scripts/ensure-services.sh` 拉起；看 `/tmp/engine.log` |
| 报 SQLite busy / `database is locked` | 多进程写竞争超预算（WAL 下罕见） | 确认只有 backend-go 一个写入方（无第二个 runner/手开 sqlite 写连接）；`busy_timeout` 已内置 5s；仍频发 → 检查是否有备份/杀毒类进程长时间持锁 |
| 端口被占用（3000/3005/3030 起不来） | 旧实例残留 | `lsof -i :3005` 找 PID kill；或 `pkill -f 'backend-go[.]bin'`（注意 `[.]` 防自匹配）后重拉 |
| 封面不显示 | 封面文件缺失（如沙箱回滚丢文件） | 前端对 404 封面自动降级为渐变封面（`cover` token g1-g12），属可接受降级；重新对该书发起采集会重下封面；检查 `public/covers/` 目录存在且可写 |
| 任务一直 `pending` 不动 | runner 死亡或心跳停 | `cat /tmp/scrape-runner-heartbeat`（10s 内为新鲜）；确认 backend-go 以 `BACKEND_MODE=all` 运行（`api` 模式没有 runner！）；看是否有遗留 TS runner 被清理（§9.3） |
| 正文/标题 GBK 乱码 | 规则 `charset` 未设或设错 | 规则编辑框把 charset 改为 `gbk`（引擎按 BOM→头→meta→嗅探→GB18030 七级解码，显式声明最稳） |
| 全策略失败、疑似 Cloudflare 挑战 | TLS 指纹被识别 / IP 信誉差 | 看引擎返回的 `attempts` 明细定位失败策略；装 curl-impersonate（§8.3）；换规则 `proxy` 出口；仍不行 → 装 Playwright 启用 browser 策略；个别站对数据中心 IP 全封（如 pilishuwu 实测），只能换 IP |
| 引擎状态卡 curl-impersonate `available:false` | 二进制被清理 / 不在 PATH | `bash scripts/install-curl-impersonate.sh` 重装；60s 内自动重探，无需重启引擎 |
| `bun run db:push` 报错找不到目录 | `db/` 目录不存在 | `mkdir -p db` 后重试（SQLite 不会自建父目录） |
| 经 3000 访问 API 65s 超时 | 引擎策略链预算（55s）+ 转发超时（65s）被慢站吃满 | 属极端慢站表现；降低该站采集频率或加代理后重试 |

---

## 11. 生产部署建议

### 11.1 沙箱内（当前形态）

当前沙箱即「开发模式」生产形态：`bun run dev`（3000）+ backend-go（3005，all 模式）+ scraper-go（3030），由三层自愈保活，无需额外操作。沙箱特有注意事项：

- `/home` 可能被周期性快照回滚：重要产物尽早 git push、定期快照 `db/custom.db` 到 `/tmp`；
- `~/.local/bin` 可能被清理：curl-impersonate 失效时重跑安装脚本；
- 由 bash 会话直接 `setsid` 派生的进程可能被环境回收：**优先依赖** Next supervisor 与 ensure-services.sh 拉起（挂靠长寿进程），而不是手工后台化。

### 11.2 通用 Linux 服务器（systemd 推荐）

1. 代码放置 `/opt/novel-admin`，按 §3 步骤 1-5 完成安装与编译，`.env` 与 `DB_PATH` 指向同一库文件；
2. 前端构建：`bun run build`（产出 `.next/standalone/`，build 脚本已拷贝 static 与 public）；
3. 三个 systemd 单元：

`/etc/systemd/system/novel-engine.service`：

```ini
[Unit]
Description=novel-admin scraper-go engine (:3030)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/novel-admin/mini-services/scraper-go
ExecStart=/opt/novel-admin/mini-services/scraper-go/scraper-go.bin
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/novel-backend.service`：

```ini
[Unit]
Description=novel-admin backend-go API + scrape runner (:3005)
After=network.target novel-engine.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/novel-admin/mini-services/backend-go
Environment=BACKEND_PORT=3005
Environment=BACKEND_MODE=all
Environment=DB_PATH=/opt/novel-admin/db/custom.db
ExecStart=/opt/novel-admin/mini-services/backend-go/backend-go.bin
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/novel-web.service`：

```ini
[Unit]
Description=novel-admin Next.js standalone (:3000)
After=network.target novel-backend.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/novel-admin
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DB_PATH=/opt/novel-admin/db/custom.db
ExecStart=/usr/local/bin/bun /opt/novel-admin/.next/standalone/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now novel-engine novel-backend novel-web
systemctl status novel-backend   # 三单元均应 active (running)
```

> systemd 托管下 Restart=always 即自愈主体；`backend-supervisor.ts` 在生产无副作用（backend-go 存活时它什么都不做），`ensure-services.sh` 可不再挂 cron。

### 11.3 反向代理

本仓库 `Caddyfile`（沙箱网关）即生产反代参考——核心是把外部流量反代到 localhost:3000，并带标准转发头。生产可直接复用：

```caddyfile
# Caddy：自动 HTTPS
example.com {
    reverse_proxy localhost:3000 {
        header_up Host {host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
    }
}
```

Nginx 等价配置：

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;   # 采集 API 预算 65s，留余量
    }
}
```

> 只需对外暴露 80/443；3005/3030 仅监听本机，切勿直接暴露公网。

---

## 12. 目录结构说明

```text
my-project/
├── src/                        # Next.js 前端
│   ├── app/                    #   App Router（page.tsx / layout.tsx / sitemap / robots）
│   │   └── api/[...path]/      #   catch-all 代理：全部 /api/* → 127.0.0.1:3005
│   ├── components/
│   │   ├── admin/              #   管理后台（AdminConsole + 采集中心 ScrapeCenter 等）
│   │   ├── theme-tools/        #   繁简切换/阅读记录/收藏等站点工具
│   │   └── ui/                 #   shadcn/ui 基础组件
│   ├── lib/                    #   客户端/服务端工具库
│   │   └── backend-supervisor.ts   # backend-go 进程看护（自愈第①层）
│   └── themes/                 #   8 套站点主题（aijjxs/x2552/ggd66/trxsw/shipsay/huangjinwu/23qb/101kks…）
├── mini-services/
│   ├── backend-go/             # Go 业务后端 :3005（API + runner，BACKEND_MODE=all）
│   │   ├── main.go             #   入口：端口/模式解析、路由注册
│   │   ├── api_*.go            #   各域 API（novels/chapters/categories/scrape/pseo/settings…）
│   │   ├── worker.go           #   采集两阶段管线（骨架→填充）
│   │   ├── runner.go           #   runner 循环（轮询 pending/心跳/互监护/LLM 归类）
│   │   ├── db.go               #   SQLite 连接（WAL/busy_timeout/FK；DB_PATH）
│   │   └── run.sh              #   构建+前台运行一键脚本
│   ├── scraper-go/             # Go 抓取引擎 :3030
│   │   ├── strategies.go       #   7 策略实现
│   │   ├── chain.go            #   策略链编排（预算/退避/亲和/熔断）
│   │   ├── extract.go 等       #   选择器提取/正文清洗/JSON 目录
│   │   ├── scripts/render.py   #   browser 策略的 Python Playwright 桥接
│   │   └── run.sh
│   └── scraper-service/        # 旧 TS 引擎（退役备份，勿运行）
├── prisma/
│   └── schema.prisma           # 数据模型（Novel/Chapter/Category/ScrapeRule/ScrapeTask/SiteSetting/PseoKeyword）
├── db/                         # SQLite 库（custom.db + WAL/SHM）
├── public/covers/              # 采集封面落盘（{id}.jpg；前端 404 自动渐变兜底）
├── docs/                       # 本教程 + anti-anti-crawl.md + scrape-rules.md + images/
├── scripts/
│   ├── ensure-services.sh      # 自愈第②层（cron 兜底拉起 3005/3030）
│   ├── install-curl-impersonate.sh  # curl-impersonate 一键安装/重装
│   ├── worker-runner.ts        # ⚠️ 已退役的 TS runner（严禁运行，见 §9.3）
│   └── *.ts                    # 规则探测/数据修复等一次性工具脚本
├── Caddyfile                   # 沙箱网关反代配置（生产反代参考，见 §11.3）
├── .env                        # DATABASE_URL（Prisma 建表用）
├── dev.log                     # Next dev 运行日志
└── package.json                # dev/build/start/db:push 等脚本
```

---

## 附：本教程验证状态汇总

| 项目 | 状态 |
|------|------|
| `go build -o backend-go.bin .` / `go build -o scraper-go.bin .` | ✅ 已实测编译通过（产物 /tmp 验证后删除） |
| 三条健康检查 curl（3000/3005/3030） | ✅ 已实测，真实输出见 §3 步骤 7 |
| `bun install` / `bun run db:push` / `bun run dev` / `build && start` | ⚠️ 未在本环境重放（依赖已装/库已建/服务在跑；命令与 package.json 逐字核对） |
| 后台化 `setsid nohup` 启动命令 | ⚠️ 未在本环境重放（与服务在跑的形态一致，写法对齐 `scripts/ensure-services.sh`） |
| systemd / Nginx 配置 | ⚠️ 通用模板，按 §11 核对路径后使用；Caddy 段落与仓库 Caddyfile 逐字一致 |
| §4 全部截图 | ✅ 本环境实拍（1280×900） |
| §5 规则 JSON 示例 | ✅ 从生产库规则 #5/#8 原样读取 |
