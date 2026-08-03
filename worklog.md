# Work Log

---
Task ID: cron-qa-20260803-0953
Agent: Main Orchestrator
Timestamp: 2026-08-03T09:53:00+08:00

Task: QA审查 + Bug修复 + 样式增强 + 无障碍改善

Work Log:
- 读取worklog确认状态(累计305项修复, commit a2a9ac3)
- npx next build: **3个构建失败错误**(SQLite mode:insensitive, onClick类型, .ts重复文件)
- bun run lint: 0 errors, 3 warnings(预存React Compiler)
- agent-browser QA: 环境限制无法使用(沙箱隔离)
- 双agent并行代码审查(API层+前端层), 发现3 HIGH + 7 MED + 8 LOW问题
- 修复所有3个构建阻断 + 9个QA问题(3 HIGH + 4 MED + 2 LOW)
- 新增10个CSS工具类 + 无障碍改善(Sheet替代自定义drawer)
- rankPercent动态化修复

## Build-Fixing Bugs (3) — 构建阻断

### 1. [CRITICAL] `mode: 'insensitive'` 在SQLite中不支持 (3文件)
- **问题**: search-suggestions、public/novels、admin/novels 三个route使用`mode: 'insensitive'`, 这是PostgreSQL专有选项, SQLite会抛出PrismaClientValidationError
- **影响**: 所有搜索相关API返回500错误
- **修复**: 移除`mode: 'insensitive'`, SQLite的LIKE/contains对ASCII本身就是不区分大小写的
- **文件**: src/app/api/public/search-suggestions/route.ts, src/app/api/public/novels/route.ts, src/app/api/novels/route.ts

### 2. [CRITICAL] DashboardView fetchDashboard onClick类型不匹配
- **问题**: `fetchDashboard`签名是`(signal?: AbortSignal) => Promise<void>`, 直接传给onClick期望`MouseEventHandler`
- **影响**: TypeScript编译失败
- **修复**: `onClick={fetchDashboard}` → `onClick={() => fetchDashboard()}`
- **文件**: src/components/novel/DashboardView.tsx

### 3. [CRITICAL] 重复文件 NovelListView.ts (含JSX的.ts文件)
- **问题**: NovelListView.ts和NovelListView.tsx同时存在, .ts文件含JSX但扩展名错误, TypeScript编译报"Cannot find name 'div'"
- **修复**: 删除遗留的NovelListView.ts
- **文件**: src/components/novel/NovelListView.ts (删除)

## QA Fixes (9)

### 4. [HIGH] DashboardView Recharts使用hsl(var())包装oklch变量
- **问题**: 5处chart颜色使用`hsl(var(--muted-foreground))`和`hsl(var(--background))`, 但CSS变量用oklch格式, hsl()包装产生无效颜色
- **修复**: 移除hsl()包装, 直接使用`var(--xxx)`
- **文件**: src/components/novel/DashboardView.tsx (5处)

### 5. [HIGH] sidebar.tsx outline variant使用hsl(var())
- **问题**: SidebarMenuButton outline variant的box-shadow中`hsl(var(--sidebar-border))`无效
- **修复**: 改为`var(--sidebar-border)`和`var(--sidebar-accent)`
- **文件**: src/components/ui/sidebar.tsx

### 6. [HIGH] NovelListView筛选变更时双重请求 (stale closure)
- **问题**: statusFilter/categoryFilter变化时, 一个effect调用setPage(1), 另一个effect立即调用fetchNovels()但捕获旧page值, 导致用错误页码请求一次, 然后page更新后又请求一次
- **修复**: 合并为单个effect, 筛选变化时直接调用`fetchNovels(1)`, 页码变化时用AbortController
- **额外**: 添加AbortController支持, 修复重试按钮类型, 消除unmounted component state update
- **文件**: src/components/novel/NovelListView.tsx

### 7. [HIGH] framer-motion ease缺失`as const` (3文件)
- **问题**: not-found.tsx、error.tsx、login/page.tsx中ease prop未加`as const`, TypeScript类型推断不精确, framer-motion运行时警告
- **修复**: 所有ease值添加`as const`
- **文件**: src/app/not-found.tsx, src/app/error.tsx, src/app/login/page.tsx

### 8. [MED] favorite路由$executeRawUnsafe SQL注入风险
- **问题**: 公开端点(无认证)使用字符串拼接构建SQL, 手动`replace(/'/g, "''")`转义不够安全
- **修复**: 改用Prisma参数化模板`$executeRaw\`...\${id}...\``
- **文件**: src/app/api/public/novels/[id]/favorite/route.ts

### 9. [MED] chapters批量排序$executeRawUnsafe SQL注入风险
- **问题**: PATCH handler将用户提供的item.id直接拼入SQL CASE语句
- **修复**: 改用Prisma事务内循环`tx.chapter.update()`, 安全且bounded(≤5000)
- **文件**: src/app/api/novels/[id]/chapters/route.ts

### 10. [MED] download路由使用Response而非NextResponse
- **问题**: 返回`new Response()`后`as unknown as NextResponse`强转, withAuth的header设置可能不兼容
- **修复**: 直接使用`new NextResponse()`
- **额外**: 修复每次下载都创建重复NovelFile记录, 改为findFirst+update/create
- **文件**: src/app/api/download/[novelId]/route.ts

### 11. [LOW] dashboard/activity使用$queryRawUnsafe
- **问题**: 两个函数使用`$queryRawUnsafe`但SQL完全静态(无用户输入), 信号错误
- **修复**: 改为参数化模板`$queryRaw\`...\``
- **文件**: src/app/api/dashboard/activity/route.ts

### 12. [LOW] SQLite不支持FOR UPDATE
- **问题**: 章节创建时使用`FOR UPDATE`行锁, SQLite不支持(无行级锁), 事务隐式写锁已提供保护
- **修复**: 移除`FOR UPDATE`子句
- **文件**: src/app/api/novels/[id]/chapters/route.ts

## New CSS Utilities (10)

1. `.scroll-fade-edges` — 横向滚动容器渐变边缘遮罩(.no-fade-left/right变体)
2. `.pill-btn` / `.pill-btn-active` — 药丸按钮(圆角+hover+active状态)
3. `.hover-lift` — 悬停微上浮+阴影增强
4. `.text-shimmer` — 文字闪光动画(渐变扫过效果)
5. `.float-label` — 浮动标签输入框
6. `.progress-stripe` — 条纹进度条动画
7. `.skeleton-text` — 多行文字骨架屏
8. `.ripple` — 点击涟漪效果
9. `.tabular-nums` — 等宽数字对齐
10. `.border-b-animate` — 悬停底部边框展开动画
11. `.stagger-children` — 子元素逐个入场动画(最多10个延迟)

## Accessibility & UX

### 移动端菜单: 自定义Drawer → Radix Sheet
- **问题**: 自定义AnimatePresence drawer无focus trap, Tab键可导航到遮罩后元素, 无Escape关闭, 无ARIA属性
- **修复**: 替换为`Sheet`组件(基于Radix Dialog), 自动提供focus trap, Escape关闭, role="dialog", aria-modal
- **文件**: src/app/page.tsx

### 排行榜rankPercent动态化
- **问题**: `rankPercent = 1 - (rank-1)/30`固定30项, 实际小说数少时进度条比例不对
- **修复**: 传入`totalItems`参数, 使用实际数量计算
- **文件**: src/app/rankings/page.tsx

## 验证结果
- next build: 0 TypeScript errors ✅
- ESLint: 0 errors, 3 warnings(预存) ✅
- Git commit: 4d7a1c2 (17 files, +320 -859)
- Git push: a2a9ac3..4d7a1c2 main → main ✅

## 统计
- 修改文件: 17
- 代码变更: +320 -859 (净减539行, 主要是删除重复.ts文件和不安全SQL)
- 本轮构建阻断修复: 3项
- 本轮QA修复: 9项
- 本轮新CSS工具类: 10个
- 本轮无障碍改善: 2项
- 累计修复: 305 + 12 = 317项 (3构建+9QA)

Stage Summary:
- 修复3个构建阻断错误(mode:insensitive/类型/重复文件)
- 修复9个QA问题(2个oklch颜色兼容, 1个竞态条件, 2个SQL注入, 1个类型强转, 2个代码质量, 1个SQLite兼容)
- 新增10个CSS工具类(渐变边缘/药丸按钮/悬停上浮/文字闪光/浮动标签等)
- 移动端菜单升级为Sheet组件(完整a11y支持)
- 排行榜进度条动态化

---
## 项目当前状态
- **代码库状态**: 稳定, 0构建错误, 0 lint errors
- **最新commit**: 4d7a1c2 (已push)
- **累计修复**: 317项

## 未解决问题或风险
1. agent-browser无法在此环境使用(沙箱隔离), 建议在生产环境测试
2. 内存rate limit在多实例部署下不共享(LOW, 单admin系统可接受)
3. SSRF防护仅检查hostname字符串, 未做DNS解析(LOW)
4. Health端点暴露内部服务拓扑无认证(LOW, 内部使用)
5. Dashboard activity API使用SQLite-specific date()函数(MIGRATION RISK if switch to PG)
6. Resizable panels在移动端不可用(需条件布局)
7. 导出API加载全部章节到内存(>2000章可能OOM, LOW, admin-only)
8. 公共页面使用raw fetch而非apiFetch(一致性, LOW)
9. Admin页面无服务端auth保护(client-only session check, MED)
10. navigator.platform已废弃(login页面, LOW)

## 建议下一阶段优先事项
1. 服务器部署 git pull && bash deploy.sh
2. 管理: 批量导入小说功能(上传JSON/TXT创建小说)
3. 新功能: 章节阅读进度持久化到服务端(localStorage→DB)
4. 新功能: 阅读统计仪表板(阅读时长、完成率、偏好分析)
5. 管理: 小说封面批量上传/管理
6. 性能: 列表虚拟滚动、Novel表title/author索引
7. 可访问性: Admin页面服务端auth保护
8. 管理: 管理表格键盘导航、DnD KeyboardSensor
9. 首页: 分类筛选横向滚动渐变边缘指示器(已添加CSS工具类, 待应用)
10. 新功能: 最近浏览跨设备同步(localStorage→DB)
