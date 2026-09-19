# 反反爬技术选型报告（scrapling / cloakBrowser / BrowserAct / invisible-playwright / MediaCrawler / curl-impersonate / aiohttp / Dokobot / Trafilatura / Obscura）

> 结论先行：在本项目（Bun + TypeScript 沙箱、单机部署）中，性价比最高的组合是
> **「完整浏览器头 fetch（默认） + curl-impersonate（可选 TLS 指纹伪装） + got-scraping（HTTP/2 与真实头） + Playwright 渲染（JS 站兜底）」**
> 四级策略链，配合 **字符集检测（GBK/GB18030）** 与 **域名级限速 + 指数退避 + robots 提示**。
> 以上已全部实现在 `mini-services/scraper-service`（端口 3030）。

## 一、逐库评估

| 库 | 定位 | 反反爬能力 | 维护/获取 | 本项目可行性 | 结论 |
|---|---|---|---|---|---|
| **scrapling** | Python 自适应抓取库（元素定位自愈、隐形抓取模式） | 强（ StealthyFetcher/Fetcher 多模式，可对抗基础指纹检测） | 活跃，但 Python 生态 | ❌ 运行时不可用（沙箱主栈是 Bun/TS，引入 Python 常驻进程成本高、双语言运维复杂） | 不采纳运行时；其「选择器自愈」思想已在 extract.ts 的“逗号分隔备选选择器 + 兜底 title/正文猜测”中部分吸收 |
| **cloakBrowser** | 社区小众的隐身浏览器封装 | 声称反指纹，但公开资料极少、无可靠版本发布与审计 | ⚠️ 无法确认活跃度与安全性 | ❌ 供应链风险大于收益 | 不采纳（信息不足，不引入不可审计的依赖） |
| **BrowserAct** | 商业云端浏览器自动化 SaaS（可视化工作流） | 中（云端 IP 池 + 渲染），按次付费 | 商业闭源 | ❌ 依赖外部付费服务，不适合自托管开源栈；且数据需经过第三方 | 不采纳；若未来需要大规模 JS 站采集，可作商业备选评估 |
| **invisible-playwright / playwright-stealth** | Playwright 隐身补丁（去除 webdriver 痕迹等） | 中（对基础 webdriver 检测有效；对高级指纹仍会被识别） | 社区活跃（多个 fork） | ✅ 已作为第 4 级策略接入（检测到 Playwright/Chromium 才启用；未安装时优雅降级为不可用） | 采纳（可选级） |
| **MediaCrawler** | 小红书/抖音/B站/微博/贴吧/知乎社媒爬虫 | 强（针对特定平台签名） | 活跃，但专注社媒平台 | ❌ 与小说站场景不符；且涉及平台登录态，合规风险高 | 不采纳（场景不符） |
| **curl-impersonate** | 修改版 curl，模拟 Chrome/Safari 的 TLS(JA3)/HTTP2 指纹 | 强（TLS 指纹层面，流量与真浏览器几乎一致） | 活跃，C 二进制分发 | ✅ 已接入：运行时探测 PATH 中 `curl_chrome*`/`curl-impersonate-*` 二进制，存在即启用（本沙箱暂未安装二进制，装好即自动生效，无需改代码） | 采纳（推荐安装：`见下文安装指引`） |
| **aiohttp** | Python 异步 HTTP 客户端 | 弱（本身不带伪装，需自配） | 活跃 | ❌ Python 栈；且 Bun 原生 fetch + HTTP/2 已覆盖 | 不采纳 |
| **Dokobot** | 社区资料极少的抓取/自动化工具 | 无法评估 | ⚠️ 无法确认 | ❌ 同 cloakBrowser，供应链不可审计 | 不采纳 |
| **Trafilatura** | Python 正文/元数据提取库（去噪、可读性） | 与反反爬无关，属于**提取质量**层 | 活跃，质量口碑好 | ⚠️ Python 栈不可直接用；其正文去噪思想已用 cheerio 实现等效子集（去 script/style/广告链接、段落规范化、正文标签猜测） | 思想采纳，实现自研（extract.ts） |
| **Obscura** | 社区资料极少（疑似代理/匿名工具链） | 无法评估 | ⚠️ 无法确认 | ❌ 不引入不可审计依赖 | 不采纳 |

> 诚实说明：cloakBrowser、Dokobot、Obscura 三个名字在主流开源社区可见资料极少，以上判断基于可获得信息，如你掌握其官方仓库/文档，可再评估。

## 二、实际集成方案（已实现并启动）

```
请求 → 域名级限速(1200ms±抖动) → robots.txt 检查(提示)
     → 策略链（依次尝试直到成功）：
        1) fetch-browser      —— 始终可用，完整 Chrome 头(UA/Accept/Sec-Fetch 族/Referer 链)
        2) curl-impersonate   —— 探测到二进制才启用（TLS 指纹级）
        3) got-scraping       —— header-generator + HTTP/2（已安装启用）
        4) browser(playwright)—— 检测到 Chromium 才启用（JS 渲染兜底）
     → 字符集检测(HTTP头 → meta → 字节嗅探) + iconv-lite 解码 GBK/GB2312/GB18030/BIG5
     → cheerio 规则提取（ListRule/BookRule/ChapterRule，备选选择器容错）
     → 失败重试：仅对网络错误/5xx，指数退避，最多 3 次
```

**API**（主站 `/api/scrape` 已代理）：
- `GET /api/strategies` — 各策略可用性
- `POST /api/test` — `{url, rule:{listRule/bookRule/chapterRule}, strategy?, charset?}` 抓取+提取
- `POST /api/chapter` — 单章正文提取

## 三、curl-impersonate 安装指引（可选增强）

```bash
# Linux x86_64 示例：下载预编译二进制放入 PATH
curl -L -o /tmp/curl-impersonate.tar.gz https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
mkdir -p ~/.local/bin && tar -xzf /tmp/curl-impersonate.tar.gz -C ~/.local/bin
export PATH=$PATH:~/.local/bin   # 重启 scraper-service 后 GET /api/strategies 自动亮绿
```

## 四、合规红线（内置于代码，不可配置绕过）

1. 默认每域名 ≥1.2 秒间隔，禁止并发轰炸；
2. robots.txt 解析并对 Disallow 路径返回明确 warning；
3. 不实现、不预留任何验证码破解、登录态伪造、付费内容绕过逻辑；
4. 仅抓取规则中显式配置的公开页面，章节正文入库前由主站管理员审校。

## 五、规则适配（10 站点）

基于对目标站点的结构分析，主站 `采集中心` 内置了 4 组 CMS 家族规则模板
（笔趣阁系 / 顶点系(GBK) / ShipSay / 现代卡片式），一键种子入库后可在规则编辑器里
按站点微调选择器，用「测试」面板实时验证提取效果（列表/书籍/章节三类规则）。

## 六、工具链选型评估（Task 10-d）

> 评估基准：本引擎现状 —— Bun + TS 策略链（fetch 画像族 → curl-impersonate → got-scraping →
> Playwright 渲染兜底）+ 挑战页检测 + 策略亲和 + 主机熔断/健康度退避。以下结论基于公开资料与
> 本轮联网检索交叉验证；对资料稀少的工具如实标注「信息有限」，不做能力夸大。

### 6.1 能力维度速览（TLS 指纹 / IP 信誉 / JS 挑战 / 行为模拟）

| # | 工具 | 原理一句话 | TLS指纹 | IP信誉 | JS挑战 | 行为模拟 | 与本引擎集成成本 | 性价比结论 |
|---|---|---|---|---|---|---|---|---|
| 1 | **scrapling** | Python 自适应抓取框架（选择器自愈 + StealthyFetcher 多模式，底层 fetch 用 curl_cffi、浏览器用 Playwright/Camoufox） | ●●（经 curl_cffi） | ○（需自配代理） | ●●（stealth 模式） | ●（有限） | 高：Python 常驻/子进程桥接，fetch 能力与现有策略链整体重叠 | **不引入**（运行时）；「选择器自愈」思想已在 extract.ts 备选选择器+兜底猜测中吸收 |
| 2 | **cloakBrowser**（CloakHQ/CloakBrowser） | stealth Chromium 桌面应用（profile 制管理指纹，免费档需 GitHub 登录、单 profile） | ●（随 Chromium） | ○ | ●●（主打过检测） | ● | 高：桌面 profile 形态不适合无头服务集成；闭源分发不可审计 | **不引入**（供应链与形态不符；公开资料仍偏少，如有官方仓库可复议） |
| 3 | **BrowserAct** | 商业云端浏览器自动化 SaaS（可视化工作流 + 云端 IP 池 + 定时任务） | —（不暴露） | ●●（云 IP 池） | ●●（托管浏览器） | ●●（云端会话） | 中（API 接入），但按次付费、数据经第三方 | **不引入**（自托管合规红线：数据不出域；大规模 JS 站采集时可作商业备选再评估） |
| 4 | **invisible_playwright** | 打补丁的 Playwright 等价替换（Python，主打 patch 过的 Firefox，stealth 做在引擎层而非注入 JS） | ● | ○ | ●●●（引擎级） | ●●（含 stealth levels 文档化分档） | 中高：pip 新依赖（当前禁止安装）+ Firefox 生态，与本引擎「Node Playwright + Chromium 主路径」不符 | **观察/思想采纳，不引入**；其「引擎级 stealth、stealth 分档」思路已按本引擎形态落到 render.py 的 init-script（见 6.7） |
| 5 | **MediaCrawler** | 社媒平台爬虫（小红书/抖音/B站/微博/贴吧/知乎，平台签名 + Playwright 登录态） | ○ | ○ | ●（平台定向） | ●●（登录态会话） | 高：场景不符 + 登录态/平台签名合规风险高 | **不引入**（与小说站公开页面采集场景不符，维持原评估） |
| 6 | **curl-impersonate** | 修改版 curl，模拟 Chrome/FF/Safari 的 TLS(JA3)/HTTP2 指纹 | ●●●（指纹级） | ○（IP 层不管） | ○ | ○ | **零成本：已集成**（策略链第 5 级，多二进制 JA3 轮换、手动逐跳 SSRF 校验），只差部署二进制 | **已集成可复用（推荐部署二进制启用）**——见 6.5 依赖清单 |
| 7 | **aiohttp** | Python 异步 HTTP 客户端（无任何内建伪装） | ○ | ○ | ○ | ○ | 高（Python 栈）且零增量：Bun fetch + got-scraping 已覆盖 | **不引入** |
| 8 | **Dokobot** | ——（本轮检索仅命中泛「scraping tools」榜单与 GitHub topics，无独立官方仓库/文档） | ? | ? | ? | ? | 不可评估 | **不引入**（信息不足，无法审计供应链；如提供官方仓库可复议） |
| 9 | **Trafilatura** | Python 正文/元数据提取库（去噪、可读性算法） | — | — | — | — | 高（Python 栈）；与反反爬无关，属提取质量层 | **思想采纳，不引入**（等效子集已用 cheerio 自研于 extract.ts） |
| 10 | **Obscura** | Rust 实现的轻量 headless browser（面向 AI agent 抓取，主打内存/体积小、内建反检测、加载快） | ● | ○ | ●●（内建反检测，声明缺独立审计） | ● | 中高：需仿 render.py 做子进程桥接；项目新、生态未成熟 | **观察**：若 Chromium 渲染的内存/耗时成为瓶颈可试点桥接；当前不引入 |
| 11 | **browser-use** | 让 LLM agent 驱动真实浏览器完成任务（Python，Playwright 之上的 agent 层） | ○（取决于底层浏览器） | ○ | ●（继承底层） | ●●●（LLM 决策） | 高：每步 LLM 调用，延迟/成本高；输出不确定性大 | **不引入**（本项目是规则驱动的确定性提取，LLM 导航与之相悖；不伪造登录态的合规边界也难以在其框架内保证） |

图例：●●● 强 / ●● 中 / ● 弱 / ○ 不覆盖 / — 不适用 / ? 无法评估

### 6.2 重复投资 vs 增量价值

- **重复投资（明确不引入）**：scrapling（fetch/浏览器能力与策略链整体重叠）、aiohttp（零伪装零增量）、
  curl_cffi（= curl-impersonate 的 Python 绑定，同一 TLS 引擎换语言，本引擎 TS 侧直接调二进制等效）、
  browser-use（LLM agent 层，成本/确定性与规则驱动提取相悖）、MediaCrawler（场景不符）。
- **有增量价值（已吸收/待启用）**：
  1. **curl-impersonate 二进制部署**——全链唯一真实缺口：got-scraping 只做「真实头生成 + HTTP/2」
     （Node TLS 栈不伪装 JA3），TLS 指纹层完全依赖 curl-impersonate；沙箱尚未装二进制（见 6.5），
     装好即自动生效，无需改代码。
  2. **invisible_playwright 的 stealth 思路**——本轮已把 playwright-stealth/puppeteer-extra-stealth
     的最小有效子集落到渲染层（见 6.7），引擎级 stealth 方案保持观察。
  3. scrapling 的「选择器自愈」→ 已有等效（备选选择器 + title/正文兜底猜测）。

### 6.3 信息不足工具的诚实说明

- **Dokobot**：两轮检索（github/topics、通用搜索）均无独立官方仓库、文档或可辨识的发布物，
  无法验证其宣称能力与供应链安全性 → 按「不可审计」处理，不引入。
- **cloakBrowser**：检索到 CloakHQ/CloakBrowser（stealth Chromium 桌面应用、profile 制、
  免费档需 GitHub 登录且单 profile），除官网/仓库 README 外缺第三方审计与运行报告；
  桌面 profile 形态无法嵌入无头采集服务。
- **Obscura**：检索确认为 Rust headless browser（面向 AI agent 抓取场景），反检测为内建特性，
  但项目较新、缺独立基准测试；结论保守给「观察」而非采纳。

### 6.4 最终工具链决策表

| 工具 | 决策 | 一句话理由 |
|---|---|---|
| curl-impersonate | ✅ 已集成，推荐部署二进制启用 | TLS/JA3 指纹层唯一覆盖，策略已就绪（含多二进制指纹轮换），部署即生效 |
| invisible_playwright | 👁 观察（思想已落地） | Python/Firefox 生态与本引擎 Node+Chromium 主路径不符；其 stealth 分档思路已按需落进 render.py |
| Obscura | 👁 观察 | Rust 轻量渲染备选；项目成熟度与审计不足，Chromium 成本可控时无必要 |
| scrapling | ❌ 不引入（思想已吸收） | fetch/渲染能力与策略链重复；选择器自愈已有等效实现 |
| cloakBrowser | ❌ 不引入 | 桌面 profile 形态 + 闭源不可审计 + 第三方资料少 |
| BrowserAct | ❌ 不引入 | 商业 SaaS，数据出域违反自托管合规；留存为未来商业备选 |
| MediaCrawler | ❌ 不引入 | 社媒平台场景 + 登录态合规风险 |
| aiohttp | ❌ 不引入 | 无伪装能力，Python 栈零增量 |
| Dokobot | ❌ 不引入 | 公开资料不足，无法评估/审计 |
| Trafilatura | ❌ 不引入（思想已自研） | 提取质量层非反反爬，extract.ts 已实现等效子集 |
| browser-use | ❌ 不引入 | LLM agent 式抓取成本高、不确定性强，与规则驱动确定性提取相悖 |

### 6.5 部署依赖清单（沙箱实测核查）

| 依赖 | 沙箱现状（本轮核查） | 影响策略 |
|---|---|---|
| curl-impersonate 二进制（`curl_chrome*`/`curl_ff*`/`curl_edge*`/`curl_safari*`/`curl-impersonate-*`） | **❌ 未安装**。核查：`src/strategies/curl-impersonate.ts` 按 `PATH` 全目录扫描上述命名（正则 `CURL_IMPERSONATE_RE`），逐目录 `ls` 均无命中；系统 `curl 8.14.1` 为 Debian 标准版（非 impersonate 构建） | curl-impersonate 策略 `probe=false` 自动跳过（优雅降级）；**安装后无需改码自动启用**（指引见「三、curl-impersonate 安装指引」） |
| Python Playwright | ✅ `/home/z/.venv/lib/python3.12/site-packages/playwright`（`sync_api` 可导入），Chromium 内核就位（`~/.cache/ms-playwright`：chromium-1200 / chromium-1243 / headless_shell-1200/1243） | browser 策略 Python 桥接（render.py）可用；本轮 stealth 加固落在此路径 |
| Node playwright（全局包） | ✅ `/home/z/.npm-global/lib/node_modules/playwright`（`import('playwright')` 可解析） | browser 策略 Node 路径优先；本轮已补 stealth 启动参数（与 render.py 同语义） |
| got-scraping / hpagent / socks-proxy-agent | ✅ `scraper-service/node_modules` 在位 | got-scraping 策略 + 代理 agent 支持 |
| Bun 原生 fetch proxy 选项 | ✅（`src/strategies/http.ts` 运行时带 `proxy` 选项） | fetch 画像族策略代理支持 |

### 6.6 代理配置格式（规则级 proxy 字段）

- **配置入口**：采集中心规则编辑器的 `proxy` 字段（主站 `/api/scrape-rules` 校验：
  `http://`、`https://`、`socks5://`、`socks5h://`、`socks4://` 形态，支持 `user:pass@host:port`，
  单值 ≤1024 字符，非法形态 400 拒绝）。
- **多出口池**：英文逗号分隔多个代理，每次 `fetchPage` 轮换一个出口（免费代理单点易失效的多出口容错）；
  https 目标经代理整链失败（连续快速 400/502）时自动降级 http 方案重走策略链；封面下载复用同一代理池。
- **各策略支持矩阵**：

  | 策略 | 代理实现 | 备注 |
  |---|---|---|
  | fetch 画像族 | Bun 原生 `fetch` `proxy` 选项 | http/https/socks5(h) 皆可 |
  | curl-impersonate | `--proxy` 参数 | 推荐 `socks5h://`（远端 DNS 解析，防本地 DNS 污染） |
  | got-scraping | hpagent（http/https）+ socks-proxy-agent（socks） | agent 依赖缺失时告警并降级直连 |
  | browser（Node） | Chromium `launch(proxy)` | 代理失效走导航失败自然降级 |
  | browser（Python 桥接） | `SCRAPER_PROXY` 环境变量 → Playwright `proxy` | 与 Node 路径同语义 |

- **典型场景**：境外可达性受限站点（如 trxsw）在规则上配美国出口代理、国内站点（如 77shuku）
  配国内出口代理——均为「按站点规则配置」，不影响其他站点直连。示例：
  `socks5h://user:pass@us-proxy.example.com:1080`（多出口：`socks5h://a.example:1080,http://b.example:8080`）。
- 代理与 stealth（6.7 渲染层加固）相互独立、同层生效，不改变任何请求语义与合规边界。

### 6.7 渲染层 stealth 加固（Task 10-d 已落地）

- **render.py（Python 桥接路径）**：
  1. `launch(ignore_default_args=["--enable-automation"])`——不注入 Playwright 默认追加的自动化开关；
     `--disable-blink-features=AutomationControlled` 原有保留；
  2. `context.add_init_script(STEALTH_INIT_SCRIPT)`——每次导航、页面脚本执行前注入：
     `navigator.webdriver → undefined`、`window.chrome` 伪造（runtime/app/loadTimes/csi）、
     `permissions.query` 修复（notifications 返回真实 Notification.permission）、
     `plugins`（Chrome PDF Viewer ×2 + item/namedItem/refresh）与 `languages`（zh-CN,zh,en-US,en）伪造、
     WebGL `UNMASKED_VENDOR/RENDERER`（37445/37446）伪装（GL1+GL2 双原型）。
     实测对照：无注入时 headless Chromium 的 WebGL vendor 返回 `null`（本身即是 headless 特征），注入后返回一致的真实形态。
  3. 每段脚本独立 try/catch：单项失败不影响其余项与渲染主流程；**stdin/stdout JSON 协议、
     argv、超时与看门狗完全不变**（端到端实测：单行 JSON 输出、cookie 回传正常）。
- **browser.ts（Node Playwright 主路径）**：启动参数补齐同语义 stealth（`--disable-blink-features=AutomationControlled`
  + `ignoreDefaultArgs: ['--enable-automation']`）；init-script 注入在本路径的对称落地留作后续增强
  （本轮改动范围受限于启动参数层）。
- 合规边界不变：stealth 仅消除自动化痕迹，不涉及验证码破解、登录态伪造或付费内容绕过。
