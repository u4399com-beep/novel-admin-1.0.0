# 采集规则分析报告（11 站点 × 实测结论）

> ⚠️ 本篇为 Task 3 时代（11 站首测）的历史版本，实测结论仍有效但部分站点已改版/降级；**最新结论（15 规则总表 + 24-d 校准与审计）见文末「Task 24-d/25 快填实测」章节**。引擎已由 TS scraper-service 退役为 Go scraper-go（同为 ：3030，策略链同名扩至 7 级）。
> Task 3 产出 · 2026-09 实测。规则已落库（/api/scrape-rules，当时 11 条）。
> 引擎：mini-services/scraper-service（:3030，已退役，现为 scraper-go）策略链 fetch-browser → fetch-ua-rotate → fetch-mobile → fetch-spider → curl-impersonate → got-scraping → browser(Playwright 兜底)。

## 结果总览

| # | 站点 | 状态 | 命中策略 | 关键说明 |
|---|------|------|----------|----------|
| 1 | aijjxs.com | ✅ 三段实测通过 | fetch-browser | 帝国 CMS。书页无章节列表，catalogLinkSelector=`a[href^="/read/"]` 二次抓目录（170 章）；正文 `#view_content_txt` |
| 2 | ddyueshu.cc | ✅ 三段实测通过（800 章） | fetch-browser | 顶点系 GBK。书页内嵌 800 章全目录 `#list dl dd a`；正文 `#content`。个别失效章节站点自身返回 chaptererror() 空壳（非规则问题，worker 有软 404 哨兵提示） |
| 3 | 23qb.net | ✅ 三段实测通过 | fetch-browser | 铅笔系 module 模板。书页最新 9 章 + `a.catalog-more` 整目；单章实测 26003 字 |
| 4 | 101kks.com | ✅ 三段实测通过 | **curl-impersonate** | 繁体站。CF Bot Fight Mode 全页注入挑战前置脚本 + WAF 对 Bun fetch TLS 指纹 403 → 本次反反爬增强突破（见下）。og:meta 全套提取，目录 `#allchapter li a`，正文 `#txtcontent` |
| 5 | huangjinwu.org | ✅ 三段实测通过 | fetch-browser | 书页内嵌 112 章全目录；正文实测 2107 字 |
| 6 | ggd66.com | ✅ 三段实测通过 | fetch-browser | 列表页为 /sort/{cid}/{page}/（首页非列表页，勿用首页测 list）。书页 202 章；章节分页 `_2.html` 由 worker 自动跟随 |
| 7 | xinjianpan.com | ✅ 三段实测通过 | fetch-browser | 章节 CMS 分页 (第1/2页)，nextSelector 跟随；标题分页后缀由引擎自动剥离（本次增强） |
| 8 | x2552.com | ✅ 三段实测通过 | fetch-browser | 杰奇 GBK。列表 /list/{cid}_{page}.html 30 条/页；书页 /book/{id}.html h1 带「全文阅读」样板后缀（引擎自动剥离）；目录 a.read → /html/{a}/{b}/ #at td.L a；正文 dd#contents |
| 9 | pilishuwu.com | ❌ 网络层封锁（草稿规则已建） | — | Cloudflare 对数据中心 IP 信誉封锁：全 TLS 指纹 403（curl_chrome116/ff117/edge101、Bun fetch、Playwright 真浏览器均 403），CF 边缘偶发 520（源站故障）。需住宅 IP 恢复后实测 |
| 10 | trxsw.com | ❌ 网络层不可达（草稿规则已建） | — | TCP 层被重置（socket closed），全部策略失败，疑 IP 封锁或站点关停 |
| 11 | 77shuku.info | ❌ 站点关停（草稿规则已建） | — | TCP 连接超时（178.107.155.19 无响应），http/https 均失败 |

草稿规则（9/10/11）基于同族模板反推：trxsw/pilishuwu 为杰奇族（与已验证的 x2552 同构），77shuku 采用经典笔趣阁模板选择器；notes 已标注「未实测」，站点可达后应先跑三段实测。

## 端到端入库验证

x2552 list 模式任务（pages=1）：30 本书被发现、逐章采集稳定入库（取消前已入库 1 本新书 89 章，含 `假太监：我乃大明九千岁` 等），任务 PATCH cancel 协作停止正常。

## 本次反反爬增强（引擎改动）

1. **curl-impersonate 二进制安装**（此前策略不可用）：`~/.local/bin/` 安装 21 个 curl_chrome/ff/edge/safari 二进制（BoringSSL TLS/JA3 指纹级伪装），引擎启动 PATH 需包含该目录；策略自动多二进制轮换指纹。
2. **挑战检测器误报修复**（challenge.ts）：`challenge-platform` / `cdn-cgi/challenge` 从「强特征」降级为「近空正文才判定」的弱特征——CF Bot Fight Mode 会在站点**所有正常页面**注入 challenge-platform 前置脚本，原强特征会把真实书页整体误杀（101kks 实测复现）。
3. **cleanBookTitle 样板后缀剥离**（extract.ts）：杰奇系 h1 常见的「全文阅读/最新章节(列表)/无弹窗阅读/笔趣阁…」SEO 后缀自动剥离（仅整词后缀且剥后非空）。
4. **章节标题分页后缀剥离**（extract.ts）：「第1章 xx(第1/2页)」类 CMS 分页后缀自动清理。

## 维护提示

- 101kks 命中 curl-impersonate 后亲和缓存会将其置首；若引擎重启后失忆，策略链会自动重走全链恢复。
- 引擎合规约束不变：域名限速 ≥1.2s、robots warn-only、SSRF 逐跳校验、禁验证码破解/账号伪装/付费内容。
- 列表页 URL 速查：aijjxs=首页、ddyueshu=首页、23qb=首页、huangjinwu=首页、ggd66=`/sort/{cid}/{page}/`、xinjianpan=`/rank/lastupdate/?page=N`、101kks=`/last`（24-d 改版校准：原 /novels/class/0_{page}.html 已下线，首页改为书单聚合）、x2552=`/list/{cid}_{page}.html`。

---

## Task 24-d/25 快填实测（2026-09-22，最新结论）

> 库曾被清空后从 git 历史快照恢复 11 旧站规则，逐站实采审计（本地样本 4 本 240 章零噪声 + 串行快填实采），并幂等重建 4 新站规则（scripts/add-new-rules.ts），当前共 **15 条规则**。审计结论已逐条落档规则 notes（`[噪声审计 2026-09-22]` 字样）。

### 15 规则总表

| id | 站点 | 规则名 | 列表页 URL | 状态（24-d 审计） | 结论摘要 |
|----|------|--------|-----------|------------------|----------|
| 10 | aijjxs.com | aijjxs | 首页 | ✅ 可用 | 本地样本 4 本 240 章零噪声，清洗链健康 |
| 11 | ddyueshu.cc | ddyueshu | 首页 | ✅ 可用 | 本地样本零噪声（GBK 顶点系） |
| 12 | 23qb.net | 23qb | 首页 | ✅ 可用 | 16 本实采正常 |
| 13 | huangjinwu.org | huangjinwu | 首页 | ✅ 可用 | 24 本实采正常（一次瞬时全策略超时后重试成功） |
| 14 | ggd66.com | ggd66 | `/sort/{cid}/{page}/` | ✅ 可用（24-d 校准） | 首页改版 listRule 失效 → 校准 `#gengxin ul li` 五段式（.s2 书名/.s4 作者），30 本验证通过 |
| 15 | xinjianpan.com | xinjianpan | `/rank/lastupdate/?page=N` | ✅ 可用 | 30 本实采正常 |
| 16 | 101kks.com | 101kks | `/last`（24-d 校准） | ❌ **硬反爬** | 站点改版校准 `/last` + `.newnovels2 ul li`；重试仍 challenge-page 全策略拦截——系统 curl 可过、引擎传输指纹被针对识别（Task 22-c 同诊断），待指纹对策 |
| 17 | x2552.com | x2552 | `/list/{cid}_{page}.html` | ✅ 可用（24-d 校准） | listRule 校准 `#centeri ul.update li`（p.ul1 a.poptext 书名/p:last-child 作者），35 本验证通过 |
| 18 | trxsw.com | trxsw | `/lastupdate/` | ✅ 可用 | 50 本 Phase 1 正常（经站点级代理出口，直连 TCP 被重置） |
| 19 | pilishuwu.com | pilishuwu | 首页 | ❌ **硬反爬** | CF 对数据中心 IP 全 TLS 指纹 403（curl_chrome116/ff117/edge101、Playwright 真浏览器均 403），需住宅 IP |
| 20 | 77shuku.info | 77shuku | 首页 | ⚠️ **不可达** | TCP 层超时/网络错误，疑站点关停；全策略失败 |
| 21 | 5165.org | 大悟读书网(5165) | 首页板块 | ✅ 新站·可用 | WordPress 结构；Task 25 新增引擎 `fetch-curl` 策略（普通 curl + 浏览器 UA，针对「拦已知爬虫指纹但放行 curl」的 WAF）后突破：全策略 403 → 262 本提取成功 |
| 22 | 23uswx.la | 顶点小说(23uswx) | 首页 `#newscontent .l` | ✅ 新站·可用 | 杰奇结构五段式；Task 25 快填 30 本骨架成功、正文持续填充 |
| 23 | 38.34.172.127 | 夜伴书屋(38.34.172.127) | 首页 `/index.html` | 🚫 新站·草稿停用（enabled=false） | 裸 IP 自签证书（insecureTLS 旁路）；首页列表规则可用，但书页/分类页源站一律 403，无采集价值 |
| 24 | ixdzs8.com | 爱下电子书(ixdzs8) | 首页最新更新模块 | ✅ 新站·可用 | 现代 CMS + JSON 目录接口 chapterListApi（POST /novel/clist/）；Task 25 快填 15 本骨架成功 |

**汇总：11 可用（8 旧站含 2 现场校准 + 3 新站实证）· 2 硬反爬（101kks、pilishuwu）· 1 不可达（77shuku）· 1 新站草稿停用（38.34 裸 IP，无采集价值）。**

### 维护提示（增量）

- 规则编辑接口为**全字段覆盖** PUT：改单字段也必须带全量 listRule/bookRule/chapterRule 对象，否则未传部分被清空（24-d 实训教训）。
- 101kks 的 `/last` 改版校准已落库但引擎仍拦截：区别于 CF IP 封锁（pilishuwu），101kks 是「系统 curl 200、引擎全策略 challenge」的传输指纹识别，恢复依赖引擎指纹对策升级。
- **Task 25 反反爬新增 `fetch-curl` 策略**（链位：curl-impersonate → fetch-curl → got-scraping）：普通系统 curl + 浏览器 UA 轮换，专攻「拦已知爬虫 JA3 指纹但放行普通 curl」的 WAF（5165.org 实证突破）；5165 恢复后也印证 101kks 属同类指纹识别，待该策略亲和验证是否同样受益。
- 4 新站规则可用 `bun scripts/add-new-rules.ts` 幂等重建（按 name upsert，任务关联不受影响）。
- 可用站快填节奏：pages=2 起步（约 40-60 本/站），Phase 1 建骨架 + Phase 2 骨架续传填正文，失败/暂停任务用后台「重启/恢复」无损续采。
