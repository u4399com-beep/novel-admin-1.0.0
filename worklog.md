# Worklog

---
Task ID: 1
Agent: main (Z.ai Code)
Task: 移植 novel-admin-1.0.0 到沙箱并恢复运行环境

Work Log:
- 克隆 https://github.com/u4399com-beep/novel-admin-1.0.0 到 /tmp/novel-admin-review 并全面审查（含原仓库 worklog Task 0-25 记录）
- 移植 src/prisma/db/mini-services/public/docs/tests 至 /home/z/my-project；package.json 与脚手架完全一致无需变更
- 删除 public/robots.txt（与 src/app/robots.ts 元数据路由冲突，会 500）
- prisma generate + db:push（schema 已同步，41 本书数据完好）；重启 dev server 后 /api/settings、/api/novels 恢复 200
- 启动 mini-services/scraper-service（bun install + bun --hot，端口 3030），/api/strategies 返回 6 策略全 available
- 环境重要发现：IM 网关传输层会吞掉 bash 输出中 `[h...]` 类方括号模式（如 `history[history.length - 1]` 显示为 `historyistory...`），属显示假象而非代码损坏；判断文件内容一律以 Read 工具 + tsc/bun 编译结果为准

Stage Summary:
- 项目已完整恢复运行：Next.js :3000（ggd66 主题激活，41 本书）、采集引擎 :3030（6 策略链）
- 10 套主题就绪：aijjxs/ddyueshu/pilishuwu/23qb/101kks/huangjinwu/ggd66/shipsay/x2552/trxsw
- 待办：①收藏本站(Ctrl+D)/阅读记录/繁体版 全主题实装（当前多为占位 span/title 提示）②11 站点采集规则编写+实测 ③深度抓 bug ④代码精简

---
Task ID: 4
Agent: auditor
Task: 小说站系统逐行深度代码审查 + 抓 bug + 修复（辖区：src/app/api/**、src/lib/**、src/hooks/use-novel-data.ts、src/components/admin/**、SeoSync/ThemeRenderer/page/layout/robots/sitemap）

Work Log:

## 已修复 bug 清单（文件:行号 → 问题 → 根因 → 修复 → 验证）

1. **src/app/api/settings/route.ts(PATCH) + src/lib/seo.ts → TDK 配置可被注入非字符串值，前台白屏**
   - 问题：PATCH `{"seo":{"homeTitle":{"evil":"<script>"}}}` 后 GET 回读 homeTitle 为 object；SeoSync 的 renderTpl 对非字符串调 `.replace` 抛 TypeError，且发生在 useEffect 内 → React 卸载整树、全站白屏。实测复现（PATCH 200 → GET typeof object）。
   - 根因：旧 PATCH 将 `body.seo` 原样 spread 进 seoConfig 入库，零类型校验；GET 读回也只 spread 不过滤。
   - 修复：①seo.ts 新增 `sanitizeSeoConfig`（DEFAULT_SEO 白名单键、非字符串回落默认、autoFromContent 布尔归一、截断 1000；`pseo` 子对象透传，防保存 TDK 时误删 PSEO 运行配置）；②GET 读回同过白名单（防历史脏数据行）；③renderTpl 加 `String(tpl ?? '')` 兜底；④pseo.ts generatePendingPages 改用 sanitizeSeoConfig 读模板（原裸 JSON.parse spread）。
   - 验证：PATCH 脏对象 → GET 返回默认字符串、自定义字符串 bookTitle 生效、`pseo.seeds:["科幻末日","无限流副本"]` 完整保留；测试后配置已还原原值。

2. **src/app/api/chapters/route.ts:24 → POST content 非字符串 500**
   - 问题：`content: 123` 时 `content.replace` 抛 TypeError → 500（实测）。
   - 根因：`body.content ?? ''` 只防 null/undefined 不防类型错。
   - 修复：`typeof body.content === 'string' ? body.content : ''`（与 PUT「非字符串忽略」语义一致）。
   - 验证：`content:123` → 201（wordCount=0），测试章节已删除、书 36 字数恢复 12873。

3. **src/app/api/novels/route.ts:17 → 负 categoryId 静默降级为全库查询**
   - 问题：注释承诺 `abc/1.5/-3 → 400`，但 `-3` 是合法整数且后续 `>0` 判断使其等价 0（分类页渲染成全站书单）。
   - 修复：校验追加 `|| categoryIdNum < 0` → 400。grep 全部主题确认只传真实分类 id，无回归。
   - 验证：`?categoryId=-3` → 400。

4. **src/app/api/novels/[id]/route.ts:78、src/app/api/categories/[id]/route.ts:22 → P2025 语义混乱**
   - 问题：PUT 不存在的书返回 400「更新失败（分类不存在？）」（误导）；categories PUT 不存在/重名一律 400。dev.log 有对应 prisma:error 记录。
   - 修复：novels PUT P2025→404；categories PUT P2025→404、P2002→409「分类名称已存在」。
   - 验证：curl 实测 404/404/409 三态正确。

5. **src/app/api/novels/[id]/route.ts:13(GET) → 书详情页全量加载章节（性能）**
   - 问题：include 全量 chapters（数千章书每次浏览拉上千行）只为取首/尾章和 totalChapters。
   - 修复：`take:12`（首页 12 章）+ `findFirst orderBy idx desc`（尾章）+ `_count.chapters`（totalChapters，与旧值恒等）。响应契约逐字段不变。
   - 验证：28 章书 GET → chapters 12 条、firstChapterId=73(idx1)、lastChapterId=100(idx28) 与旧行为一致。

6. **src/lib/db.ts + settings GET/PATCH + lib/pseo.ts(savePseoConfig) → 单例读改写竞态**
   - 问题：①SiteSetting 首次并发 GET 双 create 撞 id 唯一约束 → 500；②seoConfig JSON「读旧→合并→写回」并发 PATCH 丢更新（TDK 与 PSEO 配置共用一行存储）。
   - 修复：db.ts 新增 `serializeSettingsWrite`（globalThis Promise 链进程内串行写，HMR 重载共享不失效）；GET/PATCH/savePseoConfig 全部改 upsert（`update:{}, create:{id:1}`）并置于锁内。
   - 取舍：进程内锁覆盖本应用全部写路径（均在此 Next 进程），SQLite 无跨进程写者；不引入 raw SQL/可串行化事务的复杂度。
   - 验证：pseo/config PATCH 保存/回读/还原 200，TDK PATCH 与 PSEO PATCH 互不丢字段。

7. **src/app/api/pseo/route.ts(POST) → 手工关键词入库无 P2002 容错**
   - 问题：逐条 `create` 前先查 existing，并发窗口内撞 keyword 唯一约束 → 500；且逻辑与 lib/pseo.insertKeywords 重复。
   - 修复：复用 `insertKeywords(cleaned.map(k=>({word:k,engine:'manual'})), 500)`，响应 `{added}` 形状不变。
   - 验证：新增 added=1 / 重复 added=0 / 模拟竞态（外部先入库同名）added=0，全部 200。

8. **500 响应 detail 泄露服务器内部路径（chapters/clean-all、scrape-rules 共 5 处）**
   - 问题：Prisma 错误 message 含 `/home/z/my-project/src/...` 调用点路径，原样返回客户端。
   - 修复：统一 `firstLine(e)`（取首行 + 200 字截断，首行不含路径）。
   - 验证：lint/tsc 通过；detail 生成路径静态可达。

9. **src/app/api/novels/route.ts:12 → 分页参数小数不确定**
   - 问题：page/pageSize 未取整，`page=1.3` 产生小数 skip（SQLite 静默截断，行为依赖实现）。
   - 修复：Math.floor 钳制。验证：`page=1.3&pageSize=4` 与 `page=1&pageSize=4` 返回完全一致（scrape-tasks GET 原本已有 floor，无此问题）。

10. **src/components/admin/panels.tsx → react-query 缓存失效遗漏**
    - 问题：①NovelsTab save/remove 未失效 qk.categories（分类列表 novelCount 陈旧至 staleTime 60s 过期）；②ChaptersDialog saveEdit 未失效 ['novels']/qk.home（书级字数陈旧 30s，add/remove 有而 saveEdit 漏）。
    - 修复：invalidate 列表分别补 qk.categories / ['novels'], qk.home。

11. **src/app/api/chapters/[id]/route.ts(DELETE) → 删章不触碰 novel.updatedAt**
    - 问题：PUT/POST 同步字数时触碰 updatedAt，DELETE 不碰 → 「最近更新」排序不反映删章，三处语义不一致。
    - 修复：DELETE 同步 wordCount 时一并 `updatedAt: new Date()`。

12. **prisma/schema.prisma → Novel.categoryId 无索引**
    - 问题：分类页/首页按 categoryId 过滤，随采集书量增长全表扫。修复：`@@index([categoryId])` + db:push（sqlite_master 确认 Novel_categoryId_idx 落库，数据无损）。Chapter 的 `@@index([novelId])` 与 `@@unique([novelId, idx])` 前缀重复属冗余，删除无收益，保留。

## 评估后不修（重要取舍）
- **contains 大小写（历史遗留项）**：实测本栈不成立——Prisma/SQLite `contains` 编译为 LIKE，对 ASCII 大小写不敏感（`author contains 'm'` 命中「追星少女M」，count 均为 1），CJK 无大小写概念。无需 lower/raw COLLATE 改造。
- **chapters POST 同书并发 idx 冲突（历史遗留项）**：代码已有 P2002 catch + 回读重试 1 次；采集路径 storeChapter 更有 5 次顺延重试（MAX_IDX_BUMPS=4）。评估维持现状（追加并发概率极低且二次失败才 500）。
- **PUT novels 无法清空 author（空串静默忽略）**：前端表单无清空作者场景，POST 空作者默认「佚名」；改动收益低于契约风险，记录不改。
- **insertKeywords cap 截断先于去重**：极端重复批实际入库 < cap，语义无害。
- **activeTheme 无服务端白名单**：getTheme 有 aijjxs 兜底不会崩；server 引入 'use client' 的 registry 代价大于收益。
- **admin 全 API 无鉴权**：本工具定位即本地单管理员（浮动齿轮入口），加鉴权超出本次审查范围，如需公网部署必须补。

## 深审未发现问题（覆盖面记录）
home route（每书 take:1 相关子查询无 N+1）、scrape worker/store/run-log/engine-client（取消协作/僵尸回收/条件更新竞态防护完备）、suggest.ts（限并发/超时隔离/白名单）、footer.ts（href 白名单防 javascript: 伪协议）、content-clean.ts、format.ts/covers.ts、use-novel-data.ts（queryKey 参数完备、enabled 翻转不入 key、staleTime 合理）、admin scrape 组件族/ui-shared（runBusy 防重提交统一）、SeoSync（TDK 边界：未命中 {var}→空串、超长截断 120/300/200、DOM API 写 meta 天然防注入）、ThemeRenderer/page/layout/robots/sitemap。全 src 无 dangerouslySetInnerHTML、无 $queryRaw（无 XSS/注入面）；JSON spread 均走 CreateDataProperty，无原型污染路径。

## 基线与验证
- `bunx tsc --noEmit`：src 内 0 错误；全项目 11 错误全部位于 src 外（examples/websocket、mini-services/scraper-service、scripts-t3、skills/**，改动前即存在，属环境基线非本次引入）。
- `bun run lint`：0 错误。
- curl 回归：settings PATCH/GET、novels GET/PUT/DELETE、categories PUT、chapters POST/GET/DELETE、pseo POST/DELETE/config、home、scrape-rules、strategies 全部语义正确；测试数据（临时章节 831、临时关键词）已清理，seoConfig/footerConfig/activeTheme 均还原原值。
- dev.log 无新运行时错误（唯一 unique constraint 日志为 409 测试的预期 Prisma log）。

## 转交问题清单（非本辖区，不修只记录）
1. **themes/**（Task 2）：大量裸 `JSON.parse(window.localStorage.getItem(...) ?? '[]'|'{}')` 无 try/catch —— 101kks/ui.tsx:62,80、23qb/ui.tsx:50、23qb/views.tsx:61、trxsw/index.tsx:586、aijjxs/parts.tsx:40、aijjxs/Book.tsx:208、ggd66/views.tsx:886、pilishuwu/index.tsx:579、ddyueshu/parts.tsx:33。localStorage 值损坏时书架/书签渲染抛错白屏；建议统一 safeParse。src/hooks/use-reader-prefs.ts:130 的 `JSON.parse(raw)` 同样裸 parse（158 行有 sanitize 但 130 行先崩）。
2. **mini-services/scraper-service**（Task 3）：src/clean.ts 与 src/lib/content-clean.ts 为同源双实现（跨进程无法共享模块），改 NOISE_PATTERNS/isNoiseLine 时两边必须同步（clean-all 存量清洗只覆盖主应用侧规则）。
3. **环境基线**：mini-services/examples 的 tsc 报错（缺 @types/bun、socket.io 类型）与运行无关，如需收紧可在 tsconfig exclude 处理（不影响 Next 构建）。

Stage Summary:
- 辖区逐文件审查完成：12 处修复（1 个可致全站白屏的配置注入、2 个 500、2 个状态码语义、1 个静默降级、1 个竞态锁、1 个性能全量加载、1 个索引、2 个缓存失效、1 个字数一致性）、6 项评估后不修并记录取舍、3 项跨辖区问题转交。
- 两个历史遗留项经实证关闭：contains 大小写在本栈（Prisma/SQLite→LIKE）不成立；chapters POST 并发 idx 冲突已有 P2002 重试兜底。
- 验证闭环：tsc src 0 错误 + lint 0 错误 + curl 全端点回归 + dev.log 无新错误；DB 终态与审查前一致（仅新增 Novel_categoryId_idx 索引）。

---
Task ID: 3
Agent: scrape-rules（第三轮由主控直接接管完成）
Task: 11 站点采集规则编写 + 实测 + 反反爬突破

Work Log:
- 前两轮 agent 超时，交接产物：6 条规则（aijjxs/ddyueshu/23qb/huangjinwu/ggd66/xinjianpan）+ scripts-t3 诊断脚本
- 反反爬突破（核心）：
  ① 安装 curl-impersonate 二进制 21 个（curl_chrome/ff/edge/safari 系，BoringSSL）至 ~/.local/bin，curl-impersonate 策略从不可用变可用（此前 status:0 缺二进制）
  ② 修复挑战检测器误报（challenge.ts）：challenge-platform/cdn-cgi/challenge 降级为「近空正文才判定」弱特征——101kks 开启 CF Bot Fight Mode 后全站正常页均注入 challenge-platform 前置脚本，原强特征把真实书页整体误杀（28KB 真实页被判挑战）；修复后 101kks 全链恢复
  ③ cleanBookTitle 增强（extract.ts）：剥离杰奇系 h1「全文阅读/最新章节列表/无弹窗阅读/笔趣阁」等 SEO 样板后缀（x2552 书名「葬神棺全文阅读」→「葬神棺」实测生效）
  ④ extractChapter 增强：剥离 CMS 分页标题后缀「(第1/2页)」（xinjianpan 实测）
- 8 站点三段实测全通过（列表 items>0 + 书页 title/author + 章节 wordCount 合理）：
  aijjxs 62 items/170 章/3240 字；ddyueshu 4/800 章/4570 字（失效章为站点自身空壳，非规则问题）；23qb 16/9+整目/26003 字；101kks 10/36 章/2504 字（curl-impersonate 突破）；huangjinwu 24/112 章/2107 字；ggd66 10/202 章/1116 字（注意列表页是 /sort/{cid}/{page}/ 非首页）；xinjianpan 30/100 章/420 字；x2552 30/30 条每页+全目/2136 字
- 3 站网络层不可达，建诚实标注的草稿规则（notes 写明拦截形态与依据）：pilishuwu=CF 数据中心 IP 信誉封锁（全指纹 403 + Playwright 403 + 边缘 520）；trxsw=TCP 重置；77shuku=TCP 超时疑似关停。trxsw/pilishuwu 按已验证的杰奇族模板反推，77shuku 按经典笔趣阁模板
- 端到端入库验证：x2552 list 任务（pages=1）30 本书被发现、逐章稳定入库（1 本新书 89 章后取消，PATCH cancel 协作停止正常），novel id=51 真实入库
- 清理：删除 5 条旧种子规则（books.toscrape/ShipSay demo/笔趣阁系/顶点系/爱尚系，与现规则重复或非目标站），规则表精确 11 条；删除 scripts-t3/ 诊断脚本（结论沉淀至 docs/scrape-rules.md）
- 顺带修复：src/lib/scrape/types.ts ChapterData 补 paragraphs 可选字段（与引擎真实契约对齐，修 tsc 报错）；browser.ts execFile env 断言修 NODE_ENV 必填报错；根 tsconfig 排除 mini-services/examples/skills（独立项目不应进根 tsc，且 examples 因缺 socket.io 依赖报错）

Stage Summary:
- 规则集：11 条（8 条三段实测通过 + 3 条诚实草稿），全部落库可从管理后台使用
- 反反爬能力净增：curl-impersonate JA3 指纹伪装上线 + CF BFM 注入误报修复 + 标题清洗 2 项增强
- 文档：docs/scrape-rules.md（站点×结果表 + 选择器速查 + 维护提示）
- 验证：根 tsc 0 错误、eslint 0 错误、引擎 tsc 0 错误、引擎重启后 /api/strategies 全策略 available、端到端任务实测通过

---
Task ID: 2（验证补记）
Agent: main (Z.ai Code)
Task: Task 2 agent 超时后的浏览器端到端验证与崩溃修复

Work Log:
- 发现并修复关键崩溃：shipsay/x2552 在 Layout 顶层调用 useTrad()，而 TradProvider 在同一组件 JSX 内才挂载（provider 包不住自身的 hook 调用）→ context 为 null 直接 throw，整页白屏。修复：ThemeRenderer 层统一挂载 SiteToolsProvider（ThemeRenderer.tsx），任何主题的任何层级都能安全消费
- 10 主题遍历浏览器验证：0 崩溃（修复前 shipsay 100% 白屏）；三件套入口全部在位（101kks 为繁体站故为「简体版」反向切换、shipsay 阅读记录入口主题化为「足迹」、trxsw 顶部工具行由死 span 变为真实按钮）
- 功能实测：繁体切换（热门→熱門，localStorage 持久化，整页翻译含站名/菜单/正文）；收藏本站（toast 引导 Ctrl/⌘+D）；阅读记录（章节视图自动写入→面板展示→点条目跳回章节，跨主题共享）
- 移动端 375px：横向溢出 0；footer 贴底（gap=1px）

Stage Summary:
- 主题工具链组件：SiteToolsProvider/TradProvider/TradToggle/trad-engine/HistoryPanel/ReadingHistoryRecorder/FavoriteSite/site-tools/reading-history/s2t（Task 2 agent 产出）+ ThemeRenderer 级全局挂载（本验证修复）
- 全部 10 主题生产可用

---
Task ID: 5
Agent: main (Z.ai Code)
Task: 代码清理整合优化精简

Work Log:
- Provider 整合：删除 10 个主题内的冗余 SiteToolsProvider 包装（11 处 import+开闭标签），全局仅 ThemeRenderer 一处挂载——消除双层 TradProvider 重复 applyTradMode、章节视图双份 ReadingHistoryRecorder
- 删除污染源：scripts-t3/ 诊断脚本（污染根 tsc）、tool-results/、public/robots.txt（与 app/robots.ts 路由冲突）、5 条旧种子采集规则
- tsconfig 排除独立项目（mini-services/examples/skills/download/upload）——根 tsc 从 11 错误降到 0，且排除 examples（缺 socket.io 依赖的参考 demo）
- 修复类型债：engine-client ChapterData 补 paragraphs 可选字段（对齐引擎真实契约）；scraper browser.ts execFile env 类型断言（next-env NODE_ENV 增强）
- DB VACUUM；activeTheme 还原 ggd66

Stage Summary:
- 根 tsc 0 错误 / eslint 0 错误 / 引擎 tsc 0 错误；DB 终态 42 书 901 章 11 规则
- 全站单 Provider 架构，主题零样板接入站点工具

---
Task ID: 6
Agent: main (Z.ai Code)
Task: Agent Browser 最终端到端验证

Work Log:
- 桌面 1280px：ggd66 首页→书页→章节→下一章全链路点击通过；章节正文渲染、阅读记录随翻章更新（第一章→第二章）
- 管理后台：进入站点管理后台→采集中心，11 条站点规则渲染 ✓、任务中心 ✓、引擎/策略信息 ✓
- 移动端 375px：横向溢出 0px；页脚贴底（窗口底部 gap=1px）
- 控制台：0 page errors；dev.log 无新增运行时错误（历史报错均为修复前旧日志）
- 服务终态：站点 :3000 200、采集引擎 :3030 200

Stage Summary:
- 全部用户诉求交付完毕，端到端验证通过
