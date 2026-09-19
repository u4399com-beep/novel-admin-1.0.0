# 采集规则分析报告（11 站点 × 实测结论）

> Task 3 产出 · 2026-09 实测。规则已落库（/api/scrape-rules，11 条）。
> 引擎：mini-services/scraper-service（:3030）策略链 fetch-browser → fetch-ua-rotate → fetch-mobile → fetch-spider → curl-impersonate → got-scraping → browser(Playwright 兜底)。

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
- 列表页 URL 速查：aijjxs=首页、ddyueshu=首页、23qb=首页、huangjinwu=首页、ggd66=`/sort/{cid}/{page}/`、xinjianpan=`/rank/lastupdate/?page=N`、101kks=`/novels/class/0_{page}.html`、x2552=`/list/{cid}_{page}.html`。
