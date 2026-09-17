# Worklog

---
Task ID: 0
Agent: main (Z.ai Code)
Task: 项目初始化：审查 novel-admin-1.0.0、准备站点分析

Work Log:
- 克隆 https://github.com/u4399com-beep/novel-admin-1.0.0 到 /home/z/review-novel-admin 并完成初步审查
- 下载 10 个目标站点首页 HTML 到 /home/z/site-analysis/（9/10 成功）
- 当前沙箱项目 /home/z/my-project 为全新 Next.js 16 脚手架

Stage Summary:
- 仓库核心：小说后台管理系统（Novel/Chapter/Category/Theme/ScrapeTask 等模型 + scraper mini-service）
- 原仓库主题系统缺陷：Theme 模型仅存配色参数（colors/layout/typography JSON），并非真正的"页面结构级主题模版"；仅 1 套半成品布局主题（guichuideng）；公开站点页面结构固定，与主题脱节
- 计划：在沙箱重建精简版 novel-admin（数据层+API+管理端+阅读端 SPA），删除旧主题，重建 10 套结构级主题模版

---
Task ID: 7-c
Agent: theme-builder-c
Task: 实现 huangjinwu/ggd66 两套主题

Work Log:
- 通读 types.ts / use-novel-data.ts / types(DTO) / covers.ts / 两份设计规格 / 现有占位主题与 registry
- 重写 src/themes/huangjinwu/：拆分 index.tsx（Layout+模块定义）、views.tsx（6 视图）、ui.tsx（共享件）
- 重写 src/themes/ggd66/：同样三文件结构
- 修复 tsc 报错（漏 import useCategories）；按 react-hooks/set-state-in-effect 规则重构两处 Search（改为 key=query 重挂载的 SearchPanel）与 ggd66 书签复位（按章记忆的 state），消除自目录 lint 错误
- 验证：bunx tsc --noEmit 两目录 0 错误；bun run lint 两目录 0 错误（剩余 4 个错误均在 101kks/23qb 等他人目录，未触碰）

Stage Summary:
- 产出文件：
  - src/themes/huangjinwu/index.tsx / views.tsx / ui.tsx（ThemeModule id=huangjinwu，swatch ['#2563eb','#f0f4fb']）
  - src/themes/ggd66/index.tsx / views.tsx / ui.tsx（ThemeModule id=ggd66，swatch ['#1abc9c','#56ccb5']）
- huangjinwu 要点：1180px 居中单列、#f0f4fb 底 + 白色 10px 圆角卡 + 蓝竖条区块标题；毛玻璃白 sticky 导航（logo+横排菜单+250px 搜索框+移动端左抽屉）；首页=热门推荐 3×2 文字卡（分类实心/状态浅底/字数描边三态徽章）+ 分类排行榜 3×2 榜单模块（每榜 10 行，取 clicks/updates/finished/hot/featured/latest 六组）+ 最新更新卡流 + 胶囊栅格电子书区；详情页 180×250 渐变封面左置 + 简介展开/收起 + 最新章节胶囊 + 全量目录多列胶囊内嵌（useChapters）；正文页独立 900px 容器、字号/行距双滑杆（默认 20px/1.8）、#f8fafc 正文卡、缩进 2em/字距 0.2em、上一章|目录|下一章三段式、同作者作品推荐
- ggd66 要点：90%/1200px 容器、#f9f9f9 底、#1abc9c 顶栏 50px（桌面单行 60px 项，移动端第二行等分导航）；首页 73%/25% 双栏两行（封面+dl 简介卡 2 列 / 侧栏搜索+虚线排行榜；五列字段更新表 75/165/auto/85/85px 用 useNovels({sort:'latest',pageSize:30}) 拉满 30 行，<lg 隐作者列 <md 隐章节列 / 最新小说两字段榜单由 home 数据去重合并）；分类页分类导航条 + 3 列虚线盒（序号徽章 hover 橙 + 阅读 描边钮）+ 35px 方块数字分页；详情页 #cdf3eb 面包屑、22px 绿书名、红/蓝胶囊标签、最新章节 4 列 + 全部章节 4/3/2/1 列（移动端默认折叠按钮展开）；正文页 #FBF4EC 米黄卡、24px/180%/字距 0.1em 大字、46%/46%/94%（桌面 30%×3）三按钮翻页、Enter/←/→ 键盘翻页、相关阅读盒
- 通用约束落实：全部内部跳转走 navigate(ThemeView)，无 <a href>；封面一律 coverBgClass 渐变 + 书名首字，无 <img>；加载态同风格骨架屏、错误态 refetch 重试按钮；所有可点元素 cursor-pointer + hover 过渡
- 数据对接：Home=useHomeData（ggd66 另加一条 useNovels 拉取 30 行更新表）；Category=useNovels({categoryId,page,pageSize:20})+useCategories；Book=useNovel+useChapters；Toc=useNovel+useChapters；Chapter=useChapter(.content 按 \n 分段、prevId/nextId 翻章)；Search=本地输入+useNovels({q})

---
Task ID: 7-a2
Agent: theme-finisher-ddyueshu
Task: 补齐 ddyueshu 主题缺失视图

Work Log:
- 通读 types.ts（ThemeView/ViewProps/ThemeModule 契约）、use-novel-data.ts、lib/types.ts、covers.ts、specs/ddyueshu.md，以及 ddyueshu 现有 index.tsx / Home.tsx / parts.tsx / ddyueshu.css，确认组件签名与视觉令牌
- 修复 Home.tsx 第 5 行错误 import：CategoryDto 改从 '@/lib/types' 导入（themes/types 并不导出该类型）
- 新建 Category.tsx：分类切换条（全部+useCategories，激活态天蓝底白字）+ 全宽强推区（dd-box-c8 #C8D4E1 描边、CoverItem 三列封面卡）+ 695px/自适应两栏（左 TableHead+UpdateRow 20 行"好看的XX小说最近更新列表"+DdPager；右 SimpleRow×30 相关推荐）；数据 useNovels({categoryId,page,pageSize:20}) + featured 强推 + clicks 推荐三条查询
- 新建 Book.tsx：#E1ECED 面包屑条 + dd-box-strong 信息区（Cover 152×195 渐变首字封面、isFeatured 天蓝角标、黑体 28px 书名、作者/分类可点、状态/字数/点击/章节统计、最后更新可跳 lastChapterId、开始阅读 firstChapterId / 进入目录按钮）+ 虚线上边简介(text-indent 2em) + 最新章节 dl（#C3DFEA 卷头 dt + dd 三栏 6 条 + 完整目录入口）
- 新建 Toc.tsx：面包屑 + 信息头（返回书页/开始阅读）+ dd-box-strong 内 dl 式目录："最新章节"置顶一组（novel.chapters 前 6 条，key 加 latest- 前缀防重）+ "《书名》正文"全量组按 idx 升序（useMemo 排序），dd 33% 三栏（dd-dd-grid 响应式 3/2/1 列）
- 新建 Chapter.tsx：面包屑（含分类名，useNovel 补充）+ 米黄 dd-box-strong 阅读盒：25px 黑体章名 + 章首/章尾双份"上一章←/章节目录/→下一章/加入书签"导航（MarkButton 复用 parts 的 getMarks/toggleMark，按章 key 重挂载、不读初始 localStorage 防水合不一致）+ 热门推荐行（clicks 榜前 10）+ 正文 dd-reader-content（19px/letter-spacing 0.2em/line-height 150%/宽 85% 居中/\n 分段缩进 2em）+ 章尾 SEO 行；chapterId 变更 window.scrollTo(0,0)
- 新建 Search.tsx：key=query 重挂载 SearchPanel（规避 set-state-in-effect），本地 input/page state + useNovels({q,page,pageSize:20})，空 query 显示全库列表；结果区 TableHead+UpdateRow 高密度行 + DdPager 本地翻页
- 全部骨架屏复用 parts 的 Sk/SkRows，视图级错误用 ErrBlock(refetch)，区块级错误用内联"点击重试"；跳转全走 navigate(view)，无 <a href>；可点元素均带 cursor-pointer/hover

Stage Summary:
- 产出文件：src/themes/ddyueshu/ 下修复 Home.tsx import；新增 Category.tsx / Book.tsx / Toc.tsx / Chapter.tsx / Search.tsx（均默认导出、签名与 index.tsx 引用一致）
- 验证：bunx tsc --noEmit 2>&1 | grep ddyueshu 为空；bun run lint 2>&1 | grep -i ddyueshu 为空（残余错误均在 mini-services/、skills/、themes/shipsay 等他人目录，未触碰）

---
Task ID: 8-a
Agent: theme-finisher-x2552
Task: 完成 x2552 主题（接线 index + 补 Toc/Chapter/Search）

Work Log:
- 通读 x2552 现有全部文件（parts/Layout/Home/Book/Category/Sidebar/index）+ types.ts + use-novel-data.ts + covers.ts + worklog；设计规格 /home/z/site-analysis/specs/x2552.md 已不存在（site-analysis 目录缺失），按任务约定改以现有 x2552 文件已确立的视觉语言（杰奇经典蓝白 + 橙点缀、960px 定宽、Block 渐变标题条）为重建依据
- 确认 API 已返回 ChapterDetail.prevId/nextId（src/app/api/chapters/[id]/route.ts），Chapter 视图直接消费，无需自行推导
- 新建 Toc.tsx：当前位置面包屑（首页>分类>书名>目录）→ 书籍信息头（2px 天蓝亮条白盒：书名 h1、作者/分类/状态/字数/点击/章数点线分隔 meta 行、开始阅读 BtnMain + 返回书页/最新章节 BtnGray）→ 全量目录盒（useChapters 按 idx 升序 useMemo 排序，1/2/4 列响应式网格，序号+XLink 章题，26px 行点线分隔）；useNovel+useChapters 双查询，错误态 ErrorBox 双 refetch，加载态面包屑/信息头/列表三级同风格骨架
- 新建 Chapter.tsx：面包屑（useNovel 补分类名）→ 白色正文盒（淡蓝页面底 #E6F3FF 上）：章名 20px 居中 + 第 N 章·字数 meta + 章首/章尾双份 NavRow（上一章|目录|下一章，prevId/nextId 为 null 时置灰不可点）+ 字号设置行（A-/A/A+，14–24px 步进 2，默认 16px）+ 正文 \n 分段缩进 2em（85% 宽居中、行高 1.9）；chapterId 变更 window.scrollTo(0,0)；同风格 ChapterSkeleton
- 新建 Search.tsx：外层 Search 以 key=query 重挂载 SearchPanel（规避 set-state-in-effect，输入框随 query 同步）；左 Sidebar 190 + 右 760（与 Category/Book 同构）；站内搜索 Block（输入框 + 橙渐变按钮）→ query 为空显示 EmptyHint 提示盒（返回首页/浏览全部分类），非空才挂载 ResultPanel（useNovels({q,page,pageSize:20})，Category 同款 h2 结果头 + NovelTable 6 列表 + Pager 本地翻页）
- 重写 index.tsx：ThemeModule 全量接线 Layout/Home/Category/Book/Toc/Chapter/Search（全部真实组件），name=杰奇经典、source=x2552.com、swatch=['#2F468F','#FF6600']（主题深蓝链接 + 橙点缀双主色），description 概述 960px 定宽/渐变标题条/紧凑顶栏/多列目录/淡蓝阅读器等布局特点
- 浏览器实测（agent-browser）：Home→Book→Toc→Chapter→Search 全链路点击通过；Toc 12 章升序、开始阅读跳第一章；Chapter 章首/章尾导航与 A+ 字号（16→18px）生效、段落 text-indent 32px(2em)、翻章回顶；Search "剑"4 条/"的"33 条分页翻页正常、输入框随 query 回填；页面 0 报错
- 验证：bunx tsc --noEmit 全项目 0 错误；bun run lint 0 输出（src/themes/x2552 无任何错误/警告）；未运行 build、未触碰其他主题与 registry.ts

Stage Summary:
- 产出文件：src/themes/x2552/ 下重写 index.tsx（占位符→真实 ThemeModule 接线）；新增 Toc.tsx / Chapter.tsx / Search.tsx（至此 6 视图 + Layout 全部为真实实现）
- x2552 主题要点：杰奇 CMS 经典蓝白模板重建——960px 定宽（min-w 760）、深蓝 #2F468F 链接 hover 橙 #FF6600 + 1px 按压位移（XLink）、Block 渐变标题条 + 2px #33CCFF/#D9EDFF 亮线；首页封面排行横条 + 760 最近更新长列表 + 190 双榜 + 竖排友情链接；分类/详情/搜索 = 左 190 排行侧栏 + 右 760 表格；目录/正文页自动切换 30px 紧凑顶栏 + #a_footer 网站地图页脚、正文页底色 #E6F3FF；全量目录 4 列网格、正文双导航 + 字号 A±设置、\n 分段缩进 2em
- 复用约束落实：全部复用 parts.tsx 的 XLink/Block/NovelTable/Pager/BtnMain/BtnGray/ErrorBox/RowsSkeleton/TableSkeleton 与封面渐变（无 <img>）；内部跳转全走 navigate(view)（无 <a href>）；加载/错误态与可点元素 cursor-pointer+hover 均符合既有规范


---
Task ID: 8-c
Agent: code-auditor
Task: 全站代码逐行深度审查+修复（API/hooks/lib/components/9 主题）

Work Log:
- API 健壮性：
  - src/app/api/novels/route.ts：删除 route.ts 中非法导出的 parseId（Next.js Route 不允许未知导出，会导致 next build 类型报错；该函数本身也未被使用）；POST 补 req.json() 非法 JSON → 400（原先 500）
  - src/app/api/novels/[id]/route.ts：DELETE 不存在/非法 ID 由未捕获 P2025→500 改为校验+catch→400/404
  - src/app/api/chapters/route.ts：POST 补 JSON 解析 400
  - src/app/api/chapters/[id]/route.ts：PUT/DELETE 补 ID 校验、JSON 解析 400、update/delete catch→404（原先非法 ID 或不存在的章节直接 500 泄栈）
  - src/app/api/categories/route.ts、categories/[id]/route.ts：POST/PUT 补 JSON 解析 400；DELETE 补非法 ID 校验 + catch→404
  - src/app/api/settings/route.ts：PATCH 修复 row.seoConfig 损坏时 JSON.parse 抛错导致 PATCH 永久 500（try/catch 回退 {}，与 GET 行为对齐）；补 JSON 解析 400
- 静态文件冲突：删除 public/robots.txt——它与 src/app/robots.ts 元数据路由冲突，导致 /robots.txt 直接 500（"conflicting public file and page file"），删后 /robots.txt 200 并输出 Sitemap 行
- robots/sitemap：sitemap.ts 的 url 原为相对路径 "/"（sitemap 协议要求绝对 URL，产出 <loc>/</loc> 非法），改为 NEXT_PUBLIC_SITE_URL（回退 http://localhost:3000）拼接绝对地址；robots.ts 同基准输出 sitemap 指向
- hooks（use-novel-data.ts）：useNovels 新增可选 enabled 透传（向后兼容，默认 true）
- 章节序号 off-by-one（DB 实测 idx 从 1 起，SQLite groupBy _min=1）：aijjxs/Chapter.tsx「第 {idx+1} 章」与章节下拉/跳转标签、aijjxs/Toc.tsx 章节前缀均改为直接用 idx（原先第一章显示"第 2 章"）
- "最新章节"区块数据错误（API /api/novels/[id] 的 chapters 按 idx 升序取前 12，多主题直接当"最新章节"渲染，实际展示的是最早章节，novel>12 章时全部错位）：倒序修复 aijjxs/Toc.tsx、ddyueshu/Book.tsx、ddyueshu/Toc.tsx、huangjinwu/views.tsx(Book)、23qb/views.tsx(BookView)、pilishuwu/index.tsx(BookView)、trxsw/index.tsx(BookView)（shipsay/ddyueshu-Book/ggd66 原本已正确反转，未动）
- 无效/多余请求：aijjxs/Book.tsx、23qb/views.tsx(BookView) 的相关推荐 useNovels({categoryId: novel.data?.categoryId}) 在 novel 未加载时以 categoryId=undefined 打全库查询，接 enabled=novel 已加载，消除每次进书页的浪费请求
- AdminDrawer.tsx：
  - 章节编辑按钮 async onClick 无错误处理（失败即 unhandled rejection 且无提示）→ try/catch + toast
  - 新增章节按钮加 adding 忙态防重复提交
  - 缓存失效补全：小说增/改/删后补失效 ['novel']（书页详情/章节预览陈旧）；章节增/删后补失效 ['novel']+home；章节编辑后补失效 ['chapter']+['novel']（阅读器正文陈旧）
  - ScraperTab/PseoTab 删除按钮 async onClick 无错误处理 → try/catch + toast + 成功提示
- SeoSync.tsx：search 视图空关键词落地页原先生成「“”的搜索结果 - 站名」畸形 TDK，改为退回首页 TDK 模板
- 审查未改动（确认无问题/不属确凿 bug）：lib/format.ts、lib/covers.ts、lib/store.ts、lib/utils.ts、lib/db.ts、ThemeRenderer.tsx、layout.tsx、api/home、api/novels/[id]/chapters、store navigate/goBack；主题中 key={i} 均用于静态骨架/静态分段，不存在重排列表用 index key 的问题；各分页器越界/禁用态完备；aijjxs Chapter 阅读器 localStorage 惰性初始化因视图仅客户端挂载而安全
- 验证：bunx tsc --noEmit 0 错误；bun run lint 基线 0 错误，当前全仓 1 错误位于 mini-services/scraper-service/src/strategies.ts（并行 agent 编辑中的文件，非本任务范围），对本人改动文件跑 eslint 全部 0 错误；dev.log 无本范围文件运行时报错；curl 实测 DELETE 不存在资源 404、非法 JSON 400、非法 ID 400、/robots.txt 与 /sitemap.xml 200

Stage Summary:
- 共修复 24 处确凿 bug：API 健壮性 8（非法导出致 build 失败、6 处 500→400/404、PATCH 永久 500）、SEO 基础设施 3（robots.txt 冲突 500、sitemap 相对 URL、空搜索畸形 TDK）、数据展示错位 9（章节序号 off-by-one 3 处 + "最新章节"显示最早章节 6 处）、请求浪费/缓存陈旧 4（enabled 短路 2、失效缺失 2 类）、交互健壮性 5（unhandled rejection 3、防重复提交 1、忙态 1，部分同文件合并计）
- 遗留风险：① GET /api/novels 的 q 用 SQLite contains 区分大小写（Prisma/SQLite 不支持 mode:insensitive，需迁移或自定义 COLLATE 才能改）；② chapters POST 并发同书添加存在 [novelId,idx] 唯一冲突→500 的理论竞态；③ sort 白名单外取值回退 updatedAt desc 属既定行为；④ mini-services/scraper-service/src/strategies.ts 存在解析级 lint 错误，属并行 agent 范围未触碰；⑤ 主题 Footer 的 new Date().getFullYear() 存在跨年瞬时水合偏差（业界惯例，未改）

---
Task ID: 8-b2
Agent: main-orchestrator
Task: 8-b（采集反反爬增强）成果验证与收尾（原 agent 超时，但代码已落地）

Work Log:
- 核验 strategies.ts（1057 行）：6 组策略链 fetch-browser（Chrome 全套 Sec-Fetch/客户端提示头）→ fetch-ua-rotate（Firefox/Safari/Edge 无 Referer 变体）→ fetch-mobile（Android/iPhone）→ fetch-spider（Googlebot/Baiduspider）→ curl-impersonate（二进制探测 binScore）→ got-scraping；全部带逐跳 redirect:'manual' SSRF 校验 + opaqueredirect 降级
- 核验 suggest.ts：Promise.allSettled + 限并发 3 + 跨引擎 Set 去重 + 4s 超时中断
- 核验 pseo generate：sources 引擎白名单校验（不支持的引擎返回 400 明细）
- 运行时验证：/api/health 200；/api/strategies 返回 6 策略全 available；POST /api/test 抓 example.com 成功（status 200、attempts 明细、robots 检查、charset 嗅探警告、正文提取 wordCount 正确）；SSRF 测试 127.0.0.1 被正确拒绝
- 服务以 bun --hot 常驻（自动重启），kill 掉临时的 bun run index.ts 实例避免双实例

Stage Summary:
- 采集引擎反反爬策略链完备且运行时验证通过；tsc 0 错误；scraper 目录 eslint 干净

---
Task ID: 9-11
Agent: main-orchestrator
Task: 汇总修复 + 代码精简 + Agent Browser 端到端验证

Work Log:
- Task 10 清理：删除脚手架残留 src/app/api/route.ts（Hello World）；next.config 增加 allowedDevOrigins 消除预览跨域警告；确认旧主题机制文件（prebuilt-themes/use-layout-theme）已不存在；shadcn ui 组件集按项目约定保留（tree-shake 零成本）
- Task 11 浏览器验证（agent-browser）：
  · 10 套主题遍历渲染：全部正常、无"构建中"占位残留、TDK 自动生成（书页 TDK 含书名/作者）
  · x2552 全链路：首页→书页→全文阅读→目录→第一章→下一章（翻章回顶）→目录→搜索，控制台 0 错误
  · aijjxs 全链路：首页→书页（TDK 正确）→章节（首章"上一章"正确置灰）；ggd66：书页→开始阅读
  · 发现并修复 x2552 移动端横向溢出 570px：Layout 头部 w-[960px]→w-full max-w-[960px]、根 min-w-[760px]→min-w-0、主导航/快捷条 overflow-x-auto；四视图 w-[760px]→min-w-0 flex-1 lg:flex-none；Sidebar/排行榜 190px→lg 以下隐藏；更新行 250/340px 单元格→flex 响应式；头部搜索行 min-[720px] 以下隐藏（与真实站移动端一致）→ 复测 0px
  · 发现并修复 4 套主题 footer 未贴底：aijjxs（root 加 flex min-h-screen flex-col + 内层 flex-1 + Footer 包 mt-auto）、ddyueshu（root flex-col + main flex-1）、ggd66（同上）、x2552（root flex min-h-screen flex-col + 内容区 flex-1）；aijjxs/ddyueshu/ggd66/x2552 四主题短页 footer距底=0px ✓，长页 footer 自然下推 ✓
- 终验：bunx tsc --noEmit 0 错误；bun run lint 0 错误；agent-browser errors/console/network 全干净

Stage Summary:
- 10 套主题全部达到生产可用：渲染 ✓ / 交互 ✓ / TDK ✓ / 移动端无溢出 ✓ / footer 贴底 ✓
- 修复文件：x2552（Layout/Home/Category/Search/Book/Sidebar 7 文件响应式）、aijjxs/ddyueshu/ggd66（index.tsx 贴底）、next.config.ts、删除 api/route.ts

---
Task ID: 12
Agent: main-orchestrator
Task: GitHub 推送

Work Log:
- 提交全部变更（commit 747c55e，含完整重建说明）
- 远端 main 为旧版 novel-admin 1.0.0（与本任务"删除重建"要求冲突），采用 force push 覆盖：1b6b07c → 747c55e
- token 仅用于一次性推送 URL，未写入任何代码/配置文件

Stage Summary:
- https://github.com/u4399com-beep/novel-admin-1.0.0 main 分支 = 本次重建版本

---
Task ID: 13-c
Agent: nav-scrollbar-fixer
Task: 10 主题导航条滚动条修复

Work Log:
- src/app/globals.css：末尾追加 `@utility no-scrollbar`（-ms-overflow-style:none + scrollbar-width:none + &::-webkit-scrollbar{display:none}），Tailwind 4 @utility 嵌套伪元素写法编译通过，未改动原有内容。
- aijjxs/index.tsx：①桌面分类导航 nav（overflow-x-auto [scrollbar-width:none]）→ 统一为 no-scrollbar；②≤lg 深色两列抽屉（max-h-[70vh] overflow-y-auto）加 no-scrollbar。360px 检查：顶条按钮均 flex-none、导航 hidden ≤lg，HeaderCard/页脚 flex-wrap，不撑破。
- ddyueshu/index.tsx：③主导航 40px 天蓝横条 [scrollbar-width:none] → no-scrollbar（w-full max-w-[980px] 约束成立，360px 仅内部滚动）。
- shipsay/Layout.tsx：④主导航条内层（max-w-[960px] overflow-x-auto）加 no-scrollbar；该 nav max-[767px]:hidden，360px 不渲染；页头搜索 min-w-0 flex-1 不溢出。
- x2552/Layout.tsx：⑤主导航 .m_menu、⑥目录/正文页紧凑顶栏，两处 [scrollbar-width:none] → no-scrollbar（均 w-full max-w-[960px]）；x2552/Home.tsx：⑦首页排行榜封面横条（h-[231px] overflow-x-auto）加 no-scrollbar。
- trxsw/index.tsx：⑧首页"编辑推荐"封面横条（overflow-x-auto pb-1）加 no-scrollbar；外层 max-w-[960px] px-2，双栏 grid 用 minmax(0,1fr)，360px 安全。
- 101kks/views.tsx：⑨分类页"小說分類"标签行（overflow-x-auto）加 no-scrollbar；101kks/Layout.tsx：⑩移动端抽屉列表（flex-1 overflow-y-auto）加 no-scrollbar。
- 23qb/Layout.tsx：⑪桌面横向分类导航（min-w-0 flex-1 + shrink-0 子项，原先溢出时按钮直接外溢盖住右侧控件，~1024–1200px 视口）补 overflow-x-auto + no-scrollbar 收敛溢出；⑫移动端分类抽屉列表加 no-scrollbar。≤lg 导航隐藏，360px 无影响。
- huangjinwu/index.tsx：⑬移动端左侧抽屉 aside（overflow-y-auto）加 no-scrollbar；桌面导航仅 6 个固定项，无溢出。
- pilishuwu：审查无改动——主导航为 flex-wrap 换行式（永不横向溢出、无滚动条），其余无横向滚动条。
- ggd66：审查无改动——导航为 grid / 等分 flex（移动端第二行 w-full 均分），无横向溢出；其余 overflow-hidden 均为封面/文本截断，不属于导航条。
- 未触碰 src/components/**、src/app/api/**、prisma/**；未改任何主题的颜色/间距/字体；components/admin/AdminConsole.tsx 自带的 [&::-webkit-scrollbar]:hidden 保持原样（不在本任务范围）。

Stage Summary:
- 修改 9 个文件（globals.css + 8 个主题文件），落地 13 处 no-scrollbar：8 处横向导航/标签/封面横条（其中 4 处由 [scrollbar-width:none] 统一迁移，修复 WebKit 下仍显示系统滚动条的问题），5 处浮层抽屉竖向列表；23qb 桌面导航额外补 overflow 溢出收敛。
- no-scrollbar 以 Tailwind 4 @utility 实现（支持任意断点/变体组合），编译产物验证：.no-scrollbar{scrollbar-width:none;-ms-overflow-style:none} 与 .no-scrollbar::-webkit-scrollbar{display:none} 均存在于 dev CSS chunk。
- 验证：bunx tsc --noEmit 0 错误；bun run lint 无错误；PATCH /api/settings 10 主题全部 200；主题客户端 bundle 中 13 处类名字符串全部命中；dev.log 无新增错误。

---
Task ID: 13-a
Agent: admin-console-builder
Task: 管理控制台改独立后台（hash #/admin 全页布局）

Work Log:
- 通读 worklog、AdminDrawer.tsx（802 行）、page.tsx、ScrapeCenter 桩、ThemeRenderer、eslint/tsconfig（确认 set-state-in-effect 等规则约束与 noUnusedLocals 未开）
- 新建 src/components/admin/panels.tsx：AdminDrawer 中 AdminTabs/AdminDrawer 之外的全部代码逐行原样搬入（api、ThemesTab、NovelsTab、Field、ChaptersDialog、CategoriesTab、SEO_FIELDS、SeoTab、ScraperTab、PseoTab、SettingsTab、EMPTY_FORM、NovelForm/PseoRow/StrategyInfo/Json 类型），导出 6 个 Tab 组件；仅清理冗余 import（Sheet/Tabs/ScrollArea、Settings/Sparkles 图标、未使用的 QueryClient），面板逻辑/请求/交互零改动
- 新建 src/components/admin/AdminConsole.tsx：全页后台壳——桌面端 w-52 深色 neutral-900 固定侧边栏（品牌区 + nav[aria-label=管理导航] + aria-current 高亮 + 底部"← 返回站点"，lg:sticky h-screen），右侧浅色主区（顶部标题条显示当前区块名 + max-w-4xl p-4/p-6 内容区）；移动端(<lg)侧边栏收起为顶部横向滚动标签条（overflow-x-auto + 内联 scrollbarWidth:'none' + [&::-webkit-scrollbar]:hidden）；activeSection 惰性初始化读 localStorage('admin-section')（AdminConsole 仅客户端挂载 + typeof window 守卫，SSR 安全）、select 时回写；采集中心区块渲染 ScrapeCenter 默认导出；附加 document.title 同步当前区块
- useHashAdmin()：useState 初始 false（SSR 安全）+ useEffect 挂载读取 window.location.hash==='#/admin' + hashchange 监听（支持前进/后退/直达/刷新），导出供 page.tsx 复用
- 改写 src/app/page.tsx：isAdmin ? <AdminConsole/> : <ThemeRenderer/>；齿轮按钮改为内联 AdminLauncher 组件（沿用原 fixed bottom-5 right-5 z-50 圆形样式），点击 location.hash='#/admin'，aria-label="进入站点管理后台"
- rg 确认 AdminDrawer 仅 page.tsx 引用后删除 src/components/AdminDrawer.tsx
- 浏览器实测（agent-browser）：齿轮→#/admin 渲染主题卡；切换书籍/采集中心区块正常（采集中心渲染 ScrapeCenter 桩"采集中心加载中…"）；返回站点恢复前台（URL #、标题恢复站点名）；直开 #/admin 刷新正常且恢复上次区块（localStorage admin-section=scraper）；移动端 390px 顶部横向标签条正常；console/page errors 全程为空
- 验证：bunx tsc --noEmit 0 错误；bun run lint 0 输出；curl / 200 正常 HTML；dev.log 无新增报错；未触碰 ScrapeCenter.tsx/prisma/api/themes/store；未运行 build

Stage Summary:
- 产出文件：新增 src/components/admin/panels.tsx（7 面板 + api 工具 + 类型/常量，6 个 Tab 具名导出）、src/components/admin/AdminConsole.tsx（AdminConsole + useHashAdmin + NavButton/BackButton/Brand 内部件）；改写 src/app/page.tsx（hash 路由分流 + AdminLauncher）；删除 src/components/AdminDrawer.tsx
- 结构：#/admin = 独立全页后台（桌面左侧栏/移动顶部标签条 + 区块条件渲染，无 shadcn Tabs 包裹）；前台 = ThemeRenderer + 浮动齿轮；两者经 useHashAdmin 单一数据源切换，浏览器前进/后退/直达/刷新均可用
- 验证结果：tsc 0 错误、lint 0 错误、curl 200、agent-browser 全链路 0 报错

---
Task ID: 14
Agent: scrape-chain-auditor
Task: 采集链路+后台控制台逐行深度审查修复

Work Log:
- src/app/api/scrape-rules/route.ts（重大）：
  - PUT 双重读取请求体流：PUT 先 req.json() 判 seed，非 seed 再调 handleSave(req) 内部第二次 req.json()——body 流只能读一次，第二次必失败 → 所有经 PUT 的规则保存（前端 RuleDialog 保存/开关启停全走 PUT）恒 400「请求体必须是 JSON 对象」。重构 handleSave 签名为接收已解析 body，POST/PUT 各自解析一次后传入；实测 PUT 创建 201 / 编辑路径恢复
  - 更新不存在的规则 id（P2025）由 500(带 Prisma detail) 改为 404「规则不存在」
- src/lib/scrape-worker.ts：
  - isCanceled 把 DB 瞬时错误(.catch→null) 与「记录已删除」混同 → 瞬时错误会被误判为已取消且 finalize 覆写 status=canceled；改为 catch 返回 undefined 时 fail-open（查询失败≠取消），记录不存在(null)仍视为取消
  - 章节入库唯一冲突后 idx 停滞：create 失败不递增 idx，后续章节全部撞同一 [novelId,idx] 连锁失败；新增 isUniqueConflict(P2002/unique 消息)，冲突时 idx+1 顺延重试一次，其余失败维持原语义
  - 书籍 upsert 未 trim：title/author 带空白时与既有记录查重不一致、空白标题绕过提取校验；改为 trim→slice(0,200/100)，trim 后空标题直接按失败返回
  - ENGINE_TIMEOUT_MS 30s 与引擎策略链 55s 预算（CHAIN_BUDGET_MS）/代理层 60s 不对齐，慢站点 31~55s 的合法响应会被提前切断；对齐为 60s
- src/app/api/scrape-tasks/[id]/route.ts：
  - PATCH cancel 无条件 update 可覆盖终态（worker 在 findUnique 与 update 间隙 finalize 写入 success/failed 会被改成 canceled）；改为条件 updateMany({status in [pending,running]})，count=0 时回查返回 400/404
  - DELETE running 任务原先直接删记录（靠 worker 兜底自停）；改为 running 拒绝 409 提示先取消；pending 仍可删（删除后 worker 的 pending→running 条件更新必然 count=0 安全退出）
- src/components/admin/ScrapeCenter.tsx：
  - LogDialog refetchInterval 用打开对话框时的 task.status 快照判断轮询，任务终态后仍每 2s 轮询直至手动关闭；改为 refetchInterval 回调内取 query.state.data?.task?.status ?? task.status，终态自动停轮询
  - 任务列表末页条目删空后停留在空页（page>totalPages 无自愈）；空态在 page>1 时显示「返回第一页」按钮
- prisma/schema.prisma：ScrapeTask 增加 @@index([status])（GET 按 status 过滤），db:push 同步
- 审查未改动（确认无问题）：scrape-tasks/route.ts（分页 NaN/负数回退、ruleId 存在性 400、URL 协议白名单、pages 范围校验均正确）；api/scrape/route.ts 代理（子路由白名单、60s 超时对齐、结构化 502）；worker 状态机（pending→running 唯一条件入口防双跑含模块热重载场景、finalize 仅 running 写终态防 canceled 被覆写 failed、日志 100 行/500 字符双截断、正文 5 万字截断、分类创建并发唯一冲突容错、list 翻页 ?page=k 与 /page/k 变体实测命中）；ScrapeCenter 规则对话框 key 重挂载无数据残留、保存/创建防重复提交、日志 pre 无 dangerouslySetInnerHTML（React 转义天然防 XSS）；AdminConsole/panels/page.tsx（localStorage 读写均 try-catch、admin 视图隐藏齿轮、站点视图状态存于 zustand 模块级 store 跨卸载保留、导入经 tsc 全量验证无丢失）；globals.css no-scrollbar 实现正确

Stage Summary:
- 共修复 8 处确凿 bug：API 级 2（PUT 双读 body 致规则保存全挂、P2025 500→404）、worker 竞态/正确性 4（isCanceled fail-open、idx 冲突顺延、title/author trim、引擎超时对齐）、API 语义 2（cancel 条件更新防覆盖终态、DELETE running 拒绝）、前端 2（日志轮询不停、空页卡住）
- curl 实测：POST single(ruleId=6) → 终态 failed，updated=1（书籍查重命中 #42）、日志干净（章节「正文为空」为 books.toscrape 演示站无正文内容的环境性结果，与基线一致）；notaurl/mode xxx/ruleId 99999/ftp 协议/pages 99/非法 JSON 全部 400；PUT ghost id → 404、PUT 创建 → 201、seed 幂等 200；DELETE running → 409、PATCH cancel → 200、8s 后状态保持 canceled 未被覆写、再次 cancel → 400、非法 action → 400；?status=failed&pageSize=2 过滤生效、page=abc&pageSize=-5 安全回退；tsc 0 错误、lint 0 错误、dev.log 无新增异常（仅 P2025 预期日志）
- 遗留风险：① list 模式 done/total 单位混用（total=书数，done 含当前书章节数，进度可瞬时 >100%，UI 已钳制 100%）；② Novel 无 title+author 唯一约束，两任务并发采集同一新书可产生重复书目（需迁移+存量去重才能加约束）；③ 沙箱对外网不可达时任务按引擎错误正常走 failed 状态机；④ PUT seed 循环非事务，部分失败可重入（幂等跳过已存在）

---
Task ID: 13-15
Agent: main-orchestrator
Task: 第三批需求收尾（独立后台/导航滚动条/采集任务）验证与整合

Work Log:
- 13-b agent 超时但成果完整落地（ScrapeTask 模型+API+worker 658 行+ScrapeCenter 888 行），由主控补全验证：
  · db push 成功；GET/POST /api/scrape-tasks 正常；single 任务 example.com → failed+详细日志（无规则时引擎仅基础信息，状态机正确）
  · 端到端：books.toscrape.com + 自建规则（itemSelector=article.product_pod 等）→ 任务 success 路径：书籍 "A Light in the Attic" 入库（new=1，分类自动创建），商店站无章节故章节段按预期失败
  · UI 冒烟：后台 7 区块渲染、采集中心规则编辑对话框三组选择器字段齐全（19 输入框）、UI 创建任务→列表状态流转→日志对话框（时间戳日志可见）
- Task 14 审查 agent 修复 8 bug：PUT 双读 body（规则保存恒 400，重大）、isCanceled fail-open、idx 唯一冲突顺延重试、upsert trim、引擎超时对齐 60s、cancel 条件更新防覆写终态、DELETE running 409、日志轮询自停+空页回退；schema 补 @@index([status])
- 终验：tsc 0 错误、lint 0 错误；后台→采集中心→返回站点全链路浏览器通过；前台 x2552 移动端 0 溢出、齿轮按钮在位、导航条 scrollbar-width:none 生效

Stage Summary:
- 独立后台（#/admin hash 路由）+ 采集任务系统（单本/范围）+ 规则编辑器 全部上线并经浏览器与 curl 双重验证

---
Task ID: 15-a
Agent: scraper-engine-auditor (超时，成果由主控逐行核验补记)
Task: 采集引擎+反反爬逐行深度审查增强

Work Log:
- strategies.ts：挑战页检测升级三层（①Cloudflare/DDoS-Guard/Incapsula/Sucuri/AWS WAF 平台强特征，任意体积、前 32KB 扫描——旧实现只看 <3KB 会漏检大体积拦截页；②极小页 <3KB 挑战专用关键词，移除误报率高的裸词 javascript；③极小页 0 秒 meta-refresh 跳板且正文近空 <80 字符）
- strategies.ts：UA 与 Sec-CH-UA 版本一致性修复——CHROME_MAJOR 进程启动时从 [124..133] 随机派生，UA/Sec-CH-UA/Edge 全部同源派生，消除「UA 124 但提示头报别的版本」可检测矛盾 + 固定版本指纹
- strategies.ts：策略间指数退避+jitter（429/5xx 触发，受 55s 硬预算约束：剩余 <3s 不退避、cap=remaining-2500；末策略不退避）
- strategies.ts：browser 策略 page.content() 加 race 硬上限（1-5s，防策略链预算超支）；Node Playwright resourceType() 方法与 Python 桥接 resource_type 属性兼容判断（旧代码只读属性致 Node 路径拦截永不生效）；render 桥 execFile 超时 +15s→+4s 收敛
- extract.ts：toAbs 过滤全部 # 锚点伪链接（旧只过滤纯 "#"）；extractList 链接统一走 pickHref，linkSelector 的 @attr 后缀（如 a@data-url）不再被静默忽略
- charset.ts：GB18030 别名表补全（gb18030/2000/2005/2022）；UTF-8 失败兜底由 GBK 升级为 GB18030（严格超集，四字节字符不再乱码）
- rate-limit.ts（安全修复）：robots.txt 抓取改 redirect:'manual' + 最多 3 跳逐跳 SSRF 校验——旧实现 redirect:'follow'，恶意站点可用 robots.txt 302 引擎对内网发起 GET；限速槽位 key 与策略层对齐（含端口）；robotsCache 加 256 条上限防无界增长
- render.py：看门狗 5s→3s 余量，与上层 execFile timeout+4s 保持余量递减关系，保住 55s 预算

Stage Summary:
- 引擎增强 9 项（检测/指纹/退避/编码/提取）+ 安全修复 2 项（robots SSRF、限速 key）全部经 git diff 逐行核验；实测 example.com 抓取成功、任务状态机正常；合规红线未动（robots warn-only、限速≥1.2s、禁验证码破解）

---
Task ID: 15-a2
Agent: scrape-worker-finisher (超时，成果由主控逐行核验补记)
Task: 采集 worker 进度语义 + Novel 唯一约束 + chapters 竞态补完

Work Log:
- schema.prisma：Novel 加 @@unique([title, author])（DB 层防并发重复入库）；ScrapeTask 加 chaptersDone/chaptersTotal（章节级副进度）；db:push 成功，存量无重复数据，UNIQUE INDEX Novel_title_author_key 已确认存在
- scrape-worker.ts：进度语义重构——single 模式 done/total=章节；list 模式 done/total=书（done=已完成书数），章节进度独立累计进 chaptersDone/chaptersTotal，任何时刻 done≤total；并发 upsert 兜底：create 撞 P2002 时回读 winner 走更新路径（命中查重）而非失败
- scrape-worker.ts：chaptersDone/chaptersTotal 写入用 $executeRaw 兜底（运行中 dev 进程可能持有 schema 变更前 Prisma Client，类型化 update 报 Unknown field；原生 SQL 不依赖 dmmf）
- scrape-tasks API：列表/详情响应均用原生 SQL 透出 chaptersDone/chaptersTotal（同上理由）；列表用 Prisma.join 批量 IN 查询
- chapters POST：P2002 捕获 → 读回最大 idx 重试一次（并发同书加章竞态），再失败才 500
- novels POST：create 捕获 P2002 → 409「同名同作者的书已存在」（不再 500）
- scrape-rules PUT seed：循环包 $transaction（仅 4 条、远低于 5s 超时），部分失败整体回滚可幂等重试

Stage Summary:
- 实测：single 任务 example.com/books.toscrape 状态机正常（无规则 failed+日志、有规则 updated=1 命中查重）；list 任务（books.toscrape travel 分类 2 页 11 本）done/total=书口径、chaptersDone/chaptersTotal 独立累计，进度不再 >100%；tsc 0 错误 lint 0 错误

---
Task ID: 15-b
Agent: admin-frontend-auditor (超时，成果由主控逐行核验补记)
Task: 管理后台前端+数据层逐行深度审查修复

Work Log:
- panels.tsx：ScraperTab 整体移除（与 ScrapeCenter 采集中心重复，去重收敛）；新增 useDialogEscape hook（Esc 关闭，嵌套对话框 capture=true 保证只关最上层）；小说表单 saving 态防重复提交；列表末页删空自愈（仅剩 1 条且 page>1 回退一页）+ 空态「返回第一页」按钮；对话框补 role=dialog/aria-modal/aria-label
- ScrapeCenter.tsx：规则 URL 前置校验（http/https + URL 格式，与服务端对齐，免一趟无效请求）；启停/删除 busyId 防重复提交；删除加 confirm 确认；任务行类型补 chaptersDone/chaptersTotal，进度条副文案「已采集 N/M 章」；single/list 进度语义对齐 worker 新口径
- ThemeRenderer.tsx：PSEO 结果卡补 role=link/tabIndex/aria-label + Enter/Space 键盘导航（无障碍）

Stage Summary:
- 后台交互健壮性 10+ 处修复（防重复提交/Esc 分层/末页自愈/URL 前校验/键盘可达）；ScraperTab 去重减代码；tsc 0 错误 lint 0 错误

---
Task ID: 15-c
Agent: themes-auditor (超时，成果由主控逐行核验补记)
Task: 10 套主题逐行深度审查修复（不破坏 1:1 克隆视觉）

Work Log:
- 「最新章节」显示最早章节的错位bug再修 7 处：pilishuwu/ddyueshu/ggd66/huangjinwu/shipsay/101kks/23qb 的 Book/Toc 视图统一改为 useChapters 全量 → slice(-N).reverse()（详情接口 chapters 是最早 12 章，旧 [...novel.chapters].reverse() 仍是早章倒序）
- 书签/收藏/书架持久化统一修复：pilishuwu 书架（pls-shelf）、ddyueshu 收藏、ggd66 书签（ggd66-marks-按书分组，cap 200 条）等均改 localStorage 惰性初始化 + 事件回调写入，跨视图/跨会话一致；换书 key=novelId 重挂载重读 storage，消除水合不一致
- 键盘翻章误触防护：pilishuwu/ggd66 等主题 ←/→ 翻章在焦点位于 INPUT/TEXTAREA/SELECT/BUTTON/contentEditable 时不再触发
- aijjxs Book/Search、23qb、101kks、trxsw 等视图：加载/错误/空三态补齐（章节区骨架+ErrorBox refetch+暂无章节占位）、enabled 短路消除无效请求、章节下拉/跳转序号口径复查

Stage Summary:
- 13 个主题文件修复约 20 处确凿 bug（数据错位 7、持久化 6、键盘误触 3、三态/请求 4+）；全部为行为修复未动视觉设计；tsc 0 错误 lint 0 错误

---
Task ID: 16
Agent: main-orchestrator
Task: 代码清理整合精简

Work Log:
- 删除过程产物：.tmp-fake-site.ts、.verify-13b-e2e.sh、.verify-13b.sh、tool-results/（21 个调试转储）、agent-ctx/（2 个子 agent 记录，已并入 worklog）、scripts-tmp/（4 个审查临时脚本）
- git rm --cached 出库运行时产物：db/custom.db（3.4MB SQLite，fresh clone 走 db:push+seed）、.zscripts/（沙箱运行时脚本，本地保留）
- .gitignore 追加：.zscripts/、tool-results/、agent-ctx/、scripts-tmp/、.tmp-*、.verify-*、db/*.db、db/*.db-journal
- 代码去重：panels.tsx 中与 ScrapeCenter 重复的 ScraperTab 整体移除（-276 行级重构含此去重）

Stage Summary:
- 仓库仅剩项目源码与必要配置；数据库文件与沙箱运行时产物全部出库并加 gitignore 防回归

---
Task ID: 17
Agent: main-orchestrator
Task: 第四批收尾终验 + 推送

Work Log:
- 终验：bunx tsc --noEmit 0 错误；bun run lint 0 错误；dev.log 无新增运行时报错
- 浏览器 E2E（agent-browser）：前台渲染/TDK 正确 → 齿轮 → #/admin 七区块 → 采集中心规则列表/新建任务/任务列表（list 任务显示「进度 36% 已采集 39/45 章」双口径）→ 返回站点 → 书页 → 目录 → 第一章（第1章序号正确）→ 键盘 → 翻章（第2章）；console/page errors 全程为空
- 运行时实测：single 任务章节口径 3/3、list 任务书本口径 6/11 + 章节副进度 54/54；63 本书 0 重复（唯一约束生效）；并发采集防重复入库路径（P2002 回读）已就位
- 推送 GitHub main（token 仅用于一次性推送 URL，未落盘）

Stage Summary:
- 第四批全部完成：采集引擎反反爬增强 11 项（含 robots SSRF 安全修复）、worker 进度语义重构、Novel 唯一约束、chapters 竞态修复、后台交互健壮性 10+ 处、主题 bug 约 20 处、仓库清理出库；tsc/lint/browser 三重验证全绿

---
Task ID: 18-a
Agent: noise-cleaner
Task: 正文噪声清洗管线（清洗模块+worker集成+存量清洗+UI）

Work Log:
- 新建 src/lib/content-clean.ts（主应用规范清洗器）：cleanChapterContent(raw)→{text,removedLines}；步骤 \r\n|\r→\n → 逐行去行首全角空格(\u3000)/NBSP(\u00A0)/BOM/半角空白 → 行内连续空白折叠为单空格 → 丢空行 → 噪声行过滤 → 单 \n 连接（存储契约：无空行、无行首缩进，缩进交给主题 CSS）；导出 NOISE_PATTERNS 常量与 isNoiseLine() 供复用/测试
- 新建 mini-services/scraper-service/src/clean.ts（引擎侧同源实现）：规则与主应用完全一致，cleanChapterText(raw)→{text,removed,total}（total=进入过滤的非空候选行数）；两文件互相注明「同源实现、改规则需两边同步」（跨 Bun/Next 进程无法共享模块）
- extract.ts 集成：extractChapter 得到容器文本后调用 cleanChapterText 重建 paragraphs/content；removed/total>0.5 且 total≥10 时向 warnings push「清洗移除了 X/Y 行，请检查 contentSelector 是否命中了导航/广告容器」（引擎容器级清洗 NOISE_SELECTOR/AD_TOKEN/WATERMARK 保留不动，行级规则为其补充层）
- scrape-worker.ts 集成：入库前 cleanChapterContent，存 cleaned.text.slice(0,5万)；wordCount 基于清洗后文本；removedLines>0 时记「章节「title」清洗 N 行噪声」日志（每本书最多 3 条节流防刷屏）
- 新建 src/app/api/chapters/clean-all/route.ts：POST 分批（500/批，id 游标）遍历全章节，text 有变化才 update（content+wordCount 重算），并重算受影响书籍字数合计，返回 {checked,cleaned,novels}；GET（?dryRun=1）恒只读预览返回 {checked,toClean,dryRun}；POST 以 globalThis 标志互斥防并发（进行中→409）
- ScrapeCenter.tsx：规则区块头部新增「清洗存量章节」按钮（Eraser 图标）——confirm 确认 → dryRun 预览（toClean=0 直接 toast 成功并终止）→ POST 正式清洗 → toast「检查 N 章，清洗 M 章」+ qc.invalidateQueries() 全量失效缓存；cleaning 忙态 disabled 防重复点击
- 单元实测（26 断言全过）：\r\n/\r 归一、全角/NBSP 缩进移除、连续空行压平、16 类脏行（域名/URL/推广/导航/JS/符号）全清除、行内空白折叠、长行含「点击/书签/目录/无弹窗」叙事零误杀、短行非精确匹配保留、引擎侧 total=10/removed=7 统计正确、空串安全
- E2E 引擎级（fixture /tmp/dirty-site.ts @8899，笔趣阁式脏正文）：SCRAPER_ALLOW_PRIVATE=1 重启引擎后直连 /api/chapter 与经主站 POST /api/scrape?proxy=test 双路径验证——6 行正文全部干净（无缩进/\r/空行/广告/导航/JS），含「点击」的 31 字正常叙事行保留，warnings 出现「清洗移除了 8/14 行…」
- E2E 全链路：建临时规则（bookRule+chapterRule 选择器）→ single 任务抓 fixture 书页 → 任务 success（3/3 章，日志含 3 条引擎清洗提示）→ 入库《雾隐山门》#42 三章 content 均 6 行干净文本、wordCount=156 与清洗后文本一致 → 清理：删任务/规则/测试书，库恢复 41 书 812 章种子态
- 存量清洗实测：dryRun BEFORE {checked:812,toClean:812}（与预期一致：812 章种子全部带全角缩进）→ POST {checked:812,cleaned:812,novels:41} → dryRun AFTER {toClean:0}；DB 抽查：行首缩进 0、空行 0、\r 0、wordCount 与 content 重算全量一致（812/812）、书籍级字数同步（novel#1 wordCount=sum(chapters)）；并发双 POST 实测 200+409 互斥生效
- 浏览器验证：pilishuwu 与 x2552 两主题章节页——段落 textContent 不再以 \u3000 开头，缩进由 CSS text-indent（40px/32px=2em）统一呈现，console/page errors 全空；后台采集中心「清洗存量章节」按钮实点全流程（confirm 文案→预览 toast「检查 812 章，无需要清洗的章节」）通过
- 收尾：scraper-service 恢复无 SCRAPER_ALLOW_PRIVATE 正常模式重启（SSRF 拒内网实测恢复），删 /tmp 临时脚本与 fixture

Stage Summary:
- 清洗规则清单（除纯符号行外仅对 ≤30 字符短行生效，防误杀叙事长句）：①URL/域名类：含 www./http、常见 TLD 后缀（.com/.net/.cc/.org/.info/.xyz/.top/.vip）或整行像域名；②站点推广类：笔趣阁|顶点小说|飞卢|起点中文|纵横中文|天才一秒记住|本章未完|点击下一页|继续阅读请|最新章节|手机阅读|无弹窗|全本小说|请记住本书|首发域名|记得收藏|求收藏|求推荐票|求月票|投推荐票|加入书签|书迷交流；③导航/UI 残留（整行精确匹配）：上一章|上一页|下一章|下一页|目录|章节目录|章节列表|返回|返回目录|返回书页|返回列表|返回首页|首页|书页|书签|加入书签|加入收藏|收藏本站|收藏本书|推荐票|点击进入|第一页|末页（规范列表基础上加了同族变体）；④JS/CSS 残留：javascript:|function(|document.|window.|花括号成对短行；⑤纯符号行（无任何字母/数字，不限长度——零误杀风险，文档化偏离）
- 证据：fixture 章节清洗前后对比（18 行脏文本→6 行干净正文，8/14 行行级噪声移除，引擎 warning 触发）；存量清洗 812→812→0（dryRun 前后归零）；DB 抽查 0 缩进/0 空行/0 CR/812 wordCount 全对齐；单元 26/26 断言；并发 409 互斥；pilishuwu/x2552 双主题 CSS 缩进渲染正常
- 分层设计说明：引擎侧（提取时）与 worker 侧（入库前）规则同源，正常链路下引擎层先清干净、worker 层 removedLines=0 故日志静默（节流日志仅对绕过引擎清洗的内容触发，为防御性第二层）
- 遗留风险：①站点推广/导航关键词为中文规则，英文短行（如 "He closed the window."）理论上可被 window. 规则误杀（目标站为中文网文，风险极低）；②≤30 字符含推广词的极短正常句会被整行移除（如「他点击了下一页的按钮」9 字含「点击下一页」）——按任务规格接受；③clean-all POST 为逐章 update（812 章约 2-4s），百万级章节需改批量事务，当前量级无压力

---
Task ID: 18-c
Agent: render-auditor
Task: 正文渲染一致性专项+前端边角逐行审查

Work Log:
- 专项·10 主题 Chapter 视图逐一核查段落管线（split→trim→filter）：10/10 均已有 `.map(s=>s.trim()).filter(Boolean)`（x2552/ddyueshu/ggd66/huangjinwu/shipsay/101kks/23qb 为 split('\n')，aijjxs/pilishuwu/trxsw 为 split(/\n+/)，配 filter 等价），JS trim() 原生吃 U+3000 全角空格，行首全角缩进在渲染端天然剥离——实测确认 DOM 文本首字无 '　'，缩进完全由 CSS text-indent 提供（x2552 32px=2em、aijjxs 55.2px=2.4em、pilishuwu 40px、ddyueshu 38px 等），无双重缩进
- 专项·空内容占位补齐 4 处（原先 paragraphs 为空数组时正文卡直接空白页）：aijjxs「本章内容为空，请返回目录选择其他章节。」、shipsay（同文案，夜间模式继承 bodyText 色不写死）、101kks（繁体「本章內容為空，請返回目錄選擇其他章節。」+ night 色切换）、23qb（简体同款）；x2552/ddyueshu/ggd66/huangjinwu/pilishuwu/trxsw 原有占位，核查通过
- 专项·超长内容溢出加固 10 处：全部正文容器/段落补 `break-words`（overflow-wrap:break-word，仅影响无空格长串的断行，对正常 CJK 排版零视觉变化，不破坏克隆视觉）——aijjxs/shipsay/101kks/23qb 加在段落级，x2552/ddyueshu/ggd66/huangjinwu/pilishuwu/trxsw 加在正文容器级（overflow-wrap 可继承）
- 专项·段落 key：10 主题均为静态文本数组上的 index key（无重排/增删场景），按任务要求仅报告不改
- 专项·wordCount 口径核查：POST/PUT /api/chapters 均为 `content.replace(/\s/g,'').length`（\s 含 U+3000），与各主题 fmtWords「约 X 字」显示口径一致；实测 novel1 全 12 章 stored==real 零偏差
- 边角·API 输入校验 6 文件：
  · novels/route.ts GET：categoryId=abc 原先静默降级为全库查询（NaN>0 为 false 漏过滤）、categoryId=1.5 靠 SQLite 截断碰巧命中——改为非法值明确 400；q 截断 100 字符
  · novels/[id]/route.ts：PUT 补 JSON 解析 try/catch（原畸形 JSON 直接 500）+ ID 整数校验 + categoryId 仅接受正整数；GET/DELETE isFinite→isInteger
  · chapters/[id]/route.ts、novels/[id]/chapters/route.ts、categories/[id]/route.ts：ID 校验统一 isFinite→isInteger（Prisma/SQLite 对 12.5 静默截断取整，语义应为 400）；categories PUT 补 sort 整数校验
  · chapters/route.ts POST、novels/route.ts POST：novelId/categoryId isFinite→isInteger
- 边角·SeoSync.tsx：TDK 写入点统一截断（title 120/description 300/keywords 200，truncate 复用 seo.ts），防超长书名撑爆搜索引擎上限；特殊字符安全性核查结论：document.title 与 setAttribute 为 DOM API 天然安全，无需手工转义（已在代码注释说明）
- 边角·use-novel-data.ts：useNovels 的 queryKey 原样含 enabled 字段，翻转时产生幽灵缓存条目——解构剥离 enabled 后再入 key（请求 URL 构造不变）
- 边角·审查未改动（确认无问题）：panels.tsx（表单字段均服务端 slice 兜底、对话框重开用 EMPTY_FORM/重挂载无状态残留、列表全 id key、末页自愈已在位）；AdminConsole（未知 hash 回落前台、admin-section 损坏值有 SECTIONS.some 守卫回落 themes、移动端标签条 overflow-x-auto+滚动条隐藏）；suggest.ts（单发+引擎隔离+allSettled+4s 超时为既定语义，pseoKeyword 表本身即持久化缓存，不再叠加内存缓存）；store.ts（history cap 20）、covers.ts/format.ts/registry.ts（getTheme 非法 id 回落 aijjxs）——逐一核查通过
- 浏览器验证（agent-browser，独立 session）：①10 主题全部实测 stress 章节（4 段：全角缩进段/320 字符无空格 ASCII 段/1200 字超长中文段/短段）——10/10 无横向溢出（scrollWidth==clientWidth、document hOverflow=0）、无空 <p>、行首无全角残留；②空内容占位：raw SQL 临时置空 ch2 实测 aijjxs/x2552/ggd66/23qb 四主题均渲染占位文案非空白页，测毕恢复；③console 全程 0 error/0 warning
- 数据恢复说明：测试用 ch2/ch3 内容、ch3 wordCount(1097)、novel1 字数聚合(12863=sum)均按新存储契约（无行首缩进）复原，与 18-a 清洗后的库状态一致（期间 18-a 并行清洗实际覆盖了我置入的测试数据，复原脚本按契约先行 trim 再写回）

Stage Summary:
- 修复清单：①正文渲染 10 主题：空内容占位 4 处（aijjxs/shipsay/101kks/23qb）+ break-words 10 处（全主题，段落级 4/容器级 6）；②API 校验 6 文件 10 处（非法 categoryId 静默降级为全库查询是最实质的一处、PUT novels 畸形 JSON 500、ID isFinite→isInteger 5 文件、q 截断）；③SeoSync TDK 截断 1 处；④hooks queryKey 剥离 enabled 1 处
- 浏览器证据：10 主题 stress 章节渲染零溢出零空段零双重缩进；4 主题空内容占位实测；console/page errors 全程为空；tsc 0 错误、lint 0 错误、dev.log 无本范围新增报错
- 遗留风险：①PseoTab 引擎复选框全不选时服务端默认跑全部 5 引擎（服务端既定 default 语义，未改，仅提示）；②novels GET 非整数 ID（如 /api/novels/12.5）现统一 400，比原先「静默截断取整返回」更严格，前端不受影响（id 均来自 API 整数）；③主题/设置由并行 agent 共用，验证期间观察到 activeTheme 被并行改动，最终已复原为 aijjxs

---
Task ID: 18-b
Agent: engine-auditor-2 (超时，成果由主控逐行核验补记)
Task: 采集引擎第二轮逐行审查与反反爬增强

Work Log:
- strategies.ts 新增第 7 策略 browser：Playwright+Chromium 真实渲染（Node 包缺失自动降级 Python 桥接），对抗 JS 挑战/动态渲染；渲染期每个子请求做 SSRF 校验（私网主机拦截+去重告警）、MAX_BYTES 上限、probe 探测不可用优雅跳过
- strategies.ts curl-impersonate 策略加固：--max-filesize 在 curl 层中止超大响应（exit 63 单独标记）；HTTP/2 失败降级 --http1.1
- rate-limit.ts：新增 parseRetryAfterMs（RFC 7231 秒数/HTTP-date，cap 30s 防恶意大值吃满预算，429 时尊重 Retry-After 退避）；IPv6 zone id 等 fail-closed 按内网拒绝；DNS 解析加 3s 超时防慢速拖穿策略预算；错误响应体主动 cancel 释放连接；robots.txt 加体积上限（此前无上限可被撑爆内存）
- render.py：渲染期 SSRF 守卫（入口+每个子请求/跳转，ipaddress 判定+getaddrinfo 解析，进程内缓存 256 条）；协议白名单（file/ftp/ws 等可达本机的一律拦截）
- 运维恢复：沙箱会话重置清掉了 curl-impersonate 二进制 → 从官方 release 重装至 ~/.local/bin 并 symlink /usr/local/bin，7 策略全部 available 恢复

Stage Summary:
- 反反爬矩阵升级为 7 策略（新增真实浏览器渲染）；SSRF 防护扩展到渲染期子请求与 robots 抓取；Retry-After 尊重与连接释放补齐；tsc/lint 0 错误；example.com 实测 fetch-browser 直抓成功
---
Task ID: 19
Agent: 主控（Z.ai Code）
Task: PSEO 设置——应用 multi-search-engine 获取搜索引擎下拉词（持久化配置 + 批量应用 + 试取预览）

Work Log:
- 盘点现状：suggest.ts 已有 5 引擎下拉词聚合（baidu/bing/duckduckgo/sogou/so360，allSettled+限并发3+跨引擎去重），但 PseoTab 引擎选择是临时本地态不持久化、只有单种子即时流、无种子词库/批量入口
- 设计决策：PseoRunnerConfig 存入现有 SiteSetting.seoConfig JSON 的 pseo 子字段（零 schema 变更、免 db:push、免重启 dev server）；新增 src/lib/pseo.ts 承载定义/校验/读写/共享逻辑
- 新建 src/lib/pseo.ts：DEFAULT_PSEO_CONFIG、sanitizePseoConfig（引擎白名单+sanitizeKeyword 清洗种子限20+数值夹取 perSeedLimit 3-20/maxKeywords 10-500+布尔归一）、getPseoConfig/savePseoConfig（服务端读改写 seoConfig JSON 只动 pseo 字段，TDK 模板零影响）、insertKeywords（批内去重+按首现标记 source+P2002 竞态容错，修复原 generate 里种子词可能同时出现在下拉词中导致二次 create 撞 UNIQUE 的隐患）、generatePendingPages+matchNovels（自 generate 路由迁入共享）
- 新建路由：GET/PATCH /api/pseo/config（读取/保存配置）；POST /api/pseo/suggest（试取预览，不入库不生成，输出 per-engine 统计+聚合词表 cap40）；POST /api/pseo/batch（应用设置批量获取：种子×引擎→入库→可选二级挖掘→可选自动生成聚合页；globalThis 单飞锁 TTL 180s 防僵尸+409；种子限并发 2、批量场景引擎超时放宽 6s；body.config 提供时先持久化再执行=「保存+应用」一步）
- 重构 /api/pseo/generate 复用 lib（insertKeywords/generatePendingPages），API 契约不变，useSuggest=false 语义保留为「重新生成聚合页」入口
- PseoTab 重写（panels.tsx）：①「PSEO 设置」卡——5 引擎中文复选框（百度/必应/DuckDuckGo/搜狗/360搜索）、种子关键词多行 Textarea（独立文本草稿避免逐键拆行）、每种子保留词数/单次入库上限数值框、自动生成聚合页与二级挖掘 Switch、保存设置+试取预览按钮（overrides 合并模式与 SeoTab 一致，保存后清草稿回读）；②「应用设置·批量获取」卡——单按钮运行（自动持久化当前配置），报告区逐种子×逐引擎渲染（含失败原因与词数）；③关键词库——保留预览(hash 清空回前台)/删除，新增手工添加输入框(Enter/按钮)与「重新生成聚合页」按钮（TDK 模板变更后重跑）
- 实测（curl）：config GET/PATCH 回读闭环 ✓；settings GET 确认 TDK 模板与 pseo 共存 ✓；suggest 玄幻→bing+10/duckduckgo+8、失败引擎如实上报 ✓；batch（2 种子+二级挖掘）added 44/generated 44/level2 8 种子 45 词 ✓；并发第二请求 409 ✓；重复运行 added=0 幂等去重 ✓；非法引擎 400 带可用列表 ✓；空种子 400 ✓；超限数值静默夹取 ✓
- 实测（agent-browser E2E）：#/admin→PSEO——设置卡引擎勾选态=持久化值 ✓；试取预览渲染引擎状态+下拉词 ✓；批量获取→报告「新增 5 个关键词，生成 5 个聚合页」逐种子引擎明细 ✓ 关键词库 70→75 ✓；关键词「预览」→ hash 清空回前台渲染 PSEO 聚合页（title/H1 按模板、12 本命中书）✓；手工添加 76 ✓ toast 双确认 ✓；保存设置 perSeedLimit=7 落库 ✓；console/page errors 全程为空；375px 视口无横向溢出
- 收尾：清测试词/恢复合理配置（seeds=科幻末日+无限流副本, perSeedLimit 10, maxKeywords 200）；误跟踪的 __pycache__ 出库+.gitignore 补规则；3 个文件误变的执行位还原；tsc/ESLint 0 错误；dev.log 无新增报错

Stage Summary:
- 用户诉求落地：「PSEO设置」= 持久化运行配置（引擎/种子/词数/上限/二级挖掘/自动生成）+「应用 multi-search-engine 获取下拉词」= 试取预览（只看不入库）与批量获取（种子×引擎→去重入库→可选自动生成聚合页）两条路径，单种子 generate 接口保留兼容
- 架构要点：配置寄生 seoConfig JSON（pseo 子字段）零迁移；共享逻辑收敛到 lib/pseo.ts 三路由复用；批量单飞锁+幂等去重+P2002 容错；失败引擎逐项如实报告不阻塞
- 环境备注：沙箱内 bing/duckduckgo 稳定可用，baidu 服务端返回空（直连 curl 有数据，疑服务端出口指纹差异）、sogou/so360 网络受限——均被引擎隔离设计如实呈现，不影响功能

---
Task ID: 20-c
Agent: ui-refactor-auditor
Task: ScrapeCenter 组件化拆分 + PseoTab 引擎守卫 + 全局走查修复

Work Log:
- 通读 worklog（Task 13-a/14/15-b/16/17/18/19 的 UI 约定与既往修复）后开工；全程只改 src/components/**，未触碰 src/lib/scrape-worker.ts、src/app/api/scrape*、mini-services（并行引擎 agent 范围）
- 任务一·拆分：src/components/admin/ScrapeCenter.tsx（975 行）逐行原样迁移至 src/components/admin/scrape/ 目录：
  · types.ts（TaskRow/TaskDetail/StrategyInfo/RuleFormState/FieldDef）+ shared.ts（api/cleanRule/truncate，原样搬运）
  · RuleDialog.tsx（对话框 + 三组选择器字段常量 + RuleFieldGroup，URL 前置校验/saving 防重/key 挂载等原样保留）
  · RulesCard.tsx（规则列表启停 busyId/删除 confirm/模板入库/存量清洗 dryRun→POST 全链路原样）
  · NewTaskCard.tsx（单本/范围单选、规则下拉、页数校验、creating 防重原样）
  · TasksCard.tsx（3s 轮询终态自停、双口径进度、LogDialog 2s 轮询自停+自动滚底、取消/删除 busyId、分页与空态「返回第一页」原样）
  · ScrapeCenter.tsx 保留原路径作薄组合层（46 行，默认导出名与 import 路径不变，AdminConsole.tsx 零改动兼容）
- 重要发现：任务描述称 ScrapeCenter 原含「引擎状态」区块，实测拆分前文件并无此区块（引擎策略卡在旧 AdminDrawer 的 ScraperTab 中，Task 15-b 去重时一并移除）。按任务规格（建议文件名 EngineCard.tsx + 验收标准「引擎状态显示 7 策略」）新建 scrape/EngineCard.tsx：GET /api/scrape?proxy=strategies 沿用旧 query key 'scraper-strategies' + 30s 重询，UI 复刻旧策略卡（可用/未启用 Badge + 名称 + 描述），并补加载中/引擎降级（502）提示行，置于组合层首位（与旧 ScraperTab 排布一致）
- 逐行过手就地修复 3 处（均为拆分中发现的实际缺陷，行为增强已记录）：
  ① RulesCard「内置模板入库」无防重复点击（服务端幂等但会重复请求+重复 toast）→ 补 seeding 忙态 + 按钮 disabled，与 busyId/cleaning 模式对齐
  ② RulesCard 头部按钮行（清洗存量章节/内置模板入库/新建规则 三按钮 ≈328px）在 375px 视口超出容器 ≈311px 造成横向溢出 → 按钮行加 flex-wrap（375px 实测溢出归零，桌面端视觉不变）
  ③ TasksCard 删除任务补末页删空自愈（rows.length===1 && page>1 → 回退一页），与 NovelsTab 既有口径一致（Task 14 的手动「返回第一页」按钮保留）
- 既往修复回退核查：对话框 Esc、防重复提交（saving/creating/busyId/cleaning）、列表 id key、LogDialog/列表轮询自停、URL 前置校验、删除 confirm、taskListKey 重挂载回第一页——全部保留，零回退
- 任务二·PseoTab 守卫（panels.tsx）：noEngines = form.sources.length===0 时①引擎区下方显示红字提示「至少选择一个搜索引擎」②禁用「保存设置」「试取预览（首个种子）」「开始批量获取」三按钮；该状态下不发任何请求，服务端 sanitizePseoConfig 语义未动。附带两处微修：addKw 补 busy 守卫（Enter 键路径绕过按钮 disabled）；关键词行「预览/删除」按钮 h-5 px-1 → h-6 px-1.5（最小交互目标放大一档）
- 任务三·全局走查：AdminConsole.tsx hash 路由/SECTIONS.some 守卫/移动端标签条滚动条隐藏/localStorage try-catch/document.title 同步逐项核查无回退；panels.tsx 其余 Tab（Themes/Novels/Categories/Seo/Settings）走查输入校验、loading 态、防重复提交、list key、对话框 Esc/aria——均已在位，未发现实际 bug，未做改动（不臆造问题）
- 验证：bunx tsc --noEmit 0 错误；eslint src/components/admin/ 0 错误（仓库级 bun run lint 当前有 1 个解析错误位于 mini-services/scraper-service/src/strategies/curl-impersonate.ts，系并行引擎 agent 重构 strategies 目录的在途产物，非本任务范围）；agent-browser 全流程：#/admin 直开 → 采集中心渲染引擎 7 策略（6 可用 + curl-impersonate 未启用）+ 4 条 seed 规则 + 规则对话框打开/Esc 关闭/新建对话框正常 + 任务列表空态；PSEO 标签页全不选引擎 → DOM eval 确认提示行出现且三按钮 disabled=true，勾回后恢复（勾选态与测试前一致，配置未被持久化改动）；375px 视口采集中心与 PSEO 两页 document/main 溢出均 0；返回站点/区块记忆（admin-section）正常；全程 console/page errors 为空；dev.log 无新增报错；新 建/改文件一律 chmod 644

Stage Summary:
- 新文件 7 个：src/components/admin/scrape/{types.ts 59 行, shared.ts 21 行, RuleDialog.tsx 272 行, RulesCard.tsx 199 行, NewTaskCard.tsx 146 行, TasksCard.tsx 315 行, EngineCard.tsx 47 行}（全部 ≤450 行）；修改 2 个：ScrapeCenter.tsx（975→46 薄组合层，路径与默认导出不变）、panels.tsx（PseoTab 守卫 + 2 微修）。所有请求/状态/交互/文案除上列 3+3 处记录的修复外与拆分前逐行一致
- 走查结论：AdminConsole 七区块路由与移动端标签条无回退；panels 其余 5 Tab 未发现实际 bug（零改动）；拆分文件 375px 无横向溢出
- 遗留建议：①src/components/AdminDrawer.tsx 为未跟踪孤儿文件（沙箱重置复原的历史残留，零 import 引用，与 Task 13-a 的删除决定冲突）建议主控删除；②仓库级 lint 的唯一错误在并行 agent 的 mini-services 在途文件，待其收尾后自愈；③引擎 curl-impersonate 策略当前检测为未启用（二进制探测失败），属引擎侧环境问题，与前端无关
---
Task ID: 20-a
Agent: engine-refactor（超时，成果由主控逐行核验后补记）
Task: 采集引擎模块化重构 + 按主机策略亲和

Work Log:
- strategies.ts（1309 行巨石）拆为 src/strategies/ 10 文件：types.ts(61, 共享类型)/profiles.ts(217, UA与Sec-CH-UA同源派生+8套header画像)/challenge.ts(49, 三层挑战页检测)/http.ts(182, readBody流式限量+assess+fetchWithRedirectGuard逐跳SSRF守卫)/fetch-strategies.ts(88, makeFetchStrategy工厂+fetch-browser/ua-rotate/mobile/spider)/curl-impersonate.ts(138)/got-scraping.ts(182)/browser.ts(221, Node Playwright探测+Python桥接)/affinity.ts(34, 新增按主机策略亲和)/index.ts(267, 策略注册表+pickOrder+fetchPage编排+预算退避)
- extract.ts（651 行）拆为 src/extract/ 4 文件：selectors.ts(118, 选择器工具层)/content.ts(79, 正文容器清洗)/extract.ts(472, 三个提取器)/index.ts(6, 门面)
- index.ts（309→99 行）瘦身：业务 handler 迁至服务根 handlers.ts（230 行），入口只留启动+路由分发+CORS+错误兜底
- 新增按主机策略亲和：Map<host,strategy> 容量 256 LRU 语义（重新插入刷新淘汰序），成功策略下次提至链首，显式指定策略时不生效，命中失败照旧全链回退；/api/strategies 响应追加 affinity 说明字段（向后兼容）
- RENDER_PY 路径随文件层级修正 ../../scripts/render.py；修复一处过期声明（fetch-strategies 内 remaining 在限速等待后计算，与原版一致）

主控核验（逐行）：
- 规范化语义 diff：extract 新旧 15 行差异全部为 function→export function 可见性标记，零逻辑变化；strategies 新旧 91 行差异全部可解释（可见性导出+亲和新增+路径深度修正）
- http.ts SSRF 守卫逐跳校验/opaque-redirect 降级/MAX_BYTES/Retry-After 解析与原版逐行一致；readBody 本就流式（18-b 已改），已修正新文件中不实的「旧实现全量读」注释
- 自愈记录：agent 写文件中途半成品语法错误曾致 --hot 崩溃（curl-impersonate.ts:2），agent 已自行修复；进程被沙箱会话回收，主控以 start-stop-daemon 双 fork（ppid=1）方式重启并确认跨调用存活——新规程已记入 20-main
- 验证：引擎 tsc 0 错误；/api/health、/api/strategies（7 策略+affinity）、/api/test 真实抓取 example.com 与 books.toscrape 书页提取全部成功；二次抓取 first-attempt=fetch-browser 证实亲和生效；主站代理 strategies 正常

Stage Summary:
- 引擎由 4 文件 3136 行重构为 16 文件单文件≤472 行，对外 API 契约（端点/响应字段/错误结构/CORS）零变化；反反爬新增按主机策略亲和（唯一行为新增）
- 遗留：①curl-impersonate 二进制在当前沙箱缺失（探测为不可用，属环境问题非代码）；②handlers.ts 位于服务根而非 src/（import 正常、tsc 通过，保持现状减少无谓重启）

---
Task ID: 20-b
Agent: worker-refactor（超时，成果由主控逐行核验后补记）
Task: 采集 worker/API 模块化重构 + 陈旧 workaround 清理 + 可观测性

Work Log:
- scrape-worker.ts（743 行）拆为 src/lib/scrape/ 6 文件：types.ts(64, 引擎载荷/任务记录/进度字段)/engine-client.ts(106, callEngine+三类页面封装)/run-log.ts(66, Run日志与flush)/store.ts(203, 规则加载/分类/书籍upsert(P2002回读)/章节入库(idx竞态顺延)/字数重算)/worker.ts(428, processBook/runSingle/runList/finalize/triggerScrapeTask)/api-utils.ts(28, URL与正整数校验工具)
- 删除旧 scrape-worker.ts，scrape-tasks 路由 import 改指 '@/lib/scrape/worker'；pageVariants 转模块私有
- 移除陈旧 workaround：Run.flush 的 $executeRaw 与 scrape-tasks 两路由的 $queryRaw 兜底全部替换为类型化 Prisma（-117 行）；dev.log 无 Unknown field 报错
- 可观测性：callEngine 透出响应顶层 strategy/attempts，任务日志新增「书页命中策略 fetch-browser（尝试 N 次）」（每本书一条）
- 三个采集 API 路由去重（重复的 URL/ID 校验收敛进 api-utils），PUT/DELETE 边界实测：不存在 id → 404、非法 id → 400
- 主控核验：upsertBook 的 canceled 语义（空标题=canceled=false 走 failed）、storeChapter 返回实际 idx 推进下一章序号，均与原实现等价；进度双口径/状态机/取消协作逐段比对无变化

Stage Summary:
- worker 层由 2 文件 843 行重构为 7 文件单文件≤428 行；类型化进度写入经真实任务实证（single 任务 6/6 章 done 2→5→6、total=6、chaptersDone/chaptersTotal 语义正确、状态 success）
- 遗留：无（回退方案：若未来 schema 变更且不重启 dev，flush 可能 Unknown field——届时按 run-log.ts 注释恢复 raw SQL 并重启）

---
Task ID: 20-main
Agent: 主控（Z.ai Code）
Task: 第六批收尾——集成核验 + UI 验证 + 清理 + 推送

Work Log:
- 并行派发 20-a/20-b/20-c 三 agent；20-c 正常完成，20-a/20-b 超时但成果落地，主控逐行核验（规范化语义 diff + 行为实测）后补记
- 引擎抢救：agent 半成品崩溃+沙箱会话回收致 3030 下线，定位 /start.sh 启动机制后改用 start-stop-daemon --background 双 fork 重启（ppid=1 跨 Bash 调用存活）——记为新规程；验证 health/strategies/亲和/真实抓取
- E2E 实测：single 采集任务（rule 6, books.toscrape）success 6/6 章、命中策略日志、类型化进度写入实证；测试任务/书籍全清理恢复种子态（41→42 书已删回 41）
- UI 浏览器验证（agent-browser）：采集中心引擎卡 7 策略渲染（6 可用+curl-impersonate 未启用如实显示）、规则 5 条、任务卡/规则对话框 Esc 正常；PSEO 全不选引擎→三按钮禁用+提示、勾回恢复；全程 console/page errors 为空
- 清理：删除 src/app/api/route.ts（初版脚手架 Hello world 残留）、AdminDrawer.tsx（沙箱复原孤儿，与 Task 13-a 决定一致）；public/robots.txt 核实为初版既有文件复原，保留入库；权限位全量归一 644
- 终验：root tsc / engine tsc / ESLint 全 0 错误；dev.log 无新增运行时报错（仅 agent 边界测试触发的预期 404 噪音）

Stage Summary:
- 重构采集系统完成：引擎 4→16 模块、worker 2→7 模块、ScrapeCenter 975 行单文件→8 组件，全部行为兼容经语义 diff + 真实任务 + 浏览器三重验证
- 反反爬增强：按主机策略亲和（成功策略链首优先）+ 任务日志命中策略可观测性
- 清理：陈旧 raw SQL workaround -117 行、脚手架残留删除、采集 API 去重
- 运维规程更新：沙箱下常驻服务用 start-stop-daemon --background --make-pidfile 方式启动（nohup/setsid 均会被会话回收）
