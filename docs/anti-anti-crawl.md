# 反反爬技术选型报告（scrapling / cloakBrowser / BrowserAct / invisible-playwright / MediaCrawler / curl-impersonate / aiohttp / Dokobot / Trafilatura / Obscura）

> ⚠️ 时效说明：本篇为 TS 引擎（scraper-service）时代的选型报告，结论与思路仍有效；**引擎已退役为 Go 版 scraper-go（:3030，逐行移植 + 增强），现行策略链现状见文末「Go 引擎下策略链现状」章节**。
> 结论先行：在本项目（Bun + TypeScript 沙箱、单机部署）中，性价比最高的组合是
> **「完整浏览器头 fetch（默认） + curl-impersonate（可选 TLS 指纹伪装） + got-scraping（HTTP/2 与真实头） + Playwright 渲染（JS 站兜底）」**
> 四级策略链，配合 **字符集检测（GBK/GB18030）** 与 **域名级限速 + 指数退避 + robots 提示**。
> 以上已全部实现在 `mini-services/scraper-service`（端口 3030；历史版本，现行实现见文末 §六 scraper-go）。

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
export PATH=$PATH:~/.local/bin   # 重启引擎（现行 scraper-go）后 GET /api/strategies 自动亮绿
```

## 四、合规红线（内置于代码，不可配置绕过）

1. 默认每域名 ≥1.2 秒间隔，禁止并发轰炸；
2. robots.txt 解析并对 Disallow 路径返回明确 warning；
3. 不实现、不预留任何验证码破解、登录态伪造、付费内容绕过逻辑；
4. 仅抓取规则中显式配置的公开页面，章节正文入库前由主站管理员审校。

## 五、规则适配（10 站点）

基于对目标站点的结构分析，主站 `采集中心` 内置了 4 组 CMS 家族规则模板
（笔趣阁系 / 顶点系(GBK) / ShipSay / 现代卡片式），一键种子入库后可在规则编辑器里
按站点微调选择器，用「测试」面板实时验证提取效果（列表/书籍/正文三类规则）。

---

## 六、Go 引擎下策略链现状（Task 24/25，现行权威）

> TS 版 scraper-service 已退役（目录已于 Task 33-c 确认零活引用后删除）；现行引擎为 `mini-services/scraper-go`（:3030，go1.22），策略链/提取器/清洗链逐行移植自 TS 版并做下列增强。本节为现行权威描述，上文一至五节保留作选型存档。

### 6.1 现行策略链（7 级，顺序与 TS 版一致、中间扩容）

```
请求 → SSRF 逐跳校验 → 熔断检查 → robots 检查(warn-only) → 主机限流退避
     → 策略链（55s 整体时间预算，逐级降级直到成功）：
        1) fetch-browser    完整 Chrome 头 fetch（默认首选）
        2) fetch-ua-rotate  UA 轮换
        3) fetch-mobile     移动端画像
        4) fetch-spider     爬虫画像
        5) curl-impersonate TLS/JA3 指纹伪装（探测 ~/.local/bin 二进制才启用，多指纹轮换）
        6) got-scraping     header-generator + HTTP/2
        7) browser          Playwright 渲染兜底（检测到 Chromium 才启用）
     → 按主机策略亲和提位（recordStrategySuccess：命中策略置首，重启失忆自动重走全链）
     → 字符集解码（HTTP 头 → meta → 字节嗅探，GBK/GB2312/GB18030/BIG5）
     → 全败返回结构化 502（含 attempts 逐次明细：状态/耗时/画像/挑战页标记）
```

### 6.2 相对 TS 版的增强

| 能力 | 说明 |
|------|------|
| 站点级代理池轮换 | 规则 `proxy` 支持出口代理；站级游标原子轮换（Go race 实证修复） |
| `insecureTLS` 规则级开关 | 跳过目标站证书校验（自签/裸 IP 站，如 38.34.172.127），全策略链生效 |
| 挑战页误报修复 | `challenge-platform`/`cdn-cgi/challenge` 从强特征降级为「近空正文才判定」弱特征——CF Bot Fight Mode 会在正常页面注入前置脚本（101kks 实测复现） |
| 互监护 | backend-go runner 每 ≈30s 探活 :3030，不可达杀残留托孤拉起（见 deployment.md §7.1 与 §1.3 看护关系图） |
| JSON 目录接口 | `bookRule.chapterListApi`：书页不内嵌全目录时走 POST 接口拉目录（ixdzs8 实战） |

### 6.3 实测遗留问题（截至 24-d 审计）

- **101kks**：系统 curl 200、引擎全策略 challenge-page——引擎传输指纹被站点针对性识别（非 CF IP 封锁），待指纹对策升级；listRule 已校准 `/last`。
- **pilishuwu**：CF 对数据中心 IP 全 TLS 指纹 403（curl_chrome116/ff117/edge101、Playwright 真浏览器均 403），需住宅 IP。
- **77shuku**：TCP 层不可达疑关停，策略链无解。

### 6.4 合规红线（Go 版逐条继承，不可配置绕过）

1. 默认每域名 ≥1.2 秒间隔，禁止并发轰炸；2. robots.txt 解析并对 Disallow 路径返回 warning（warn-only）；3. 不实现、不预留任何验证码破解、登录态伪造、付费内容绕过逻辑；4. 仅抓取规则中显式配置的公开页面。
