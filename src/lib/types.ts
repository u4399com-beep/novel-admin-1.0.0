// ==================== 共享 DTO 类型 ====================

export interface CategoryDto {
  id: number
  name: string
  sort: number
  novelCount: number
}

export interface NovelListItem {
  id: number
  title: string
  author: string
  description: string
  cover: string
  categoryId: number
  categoryName: string
  status: 'serial' | 'finished'
  isFeatured: boolean
  isHot: boolean
  wordCount: number
  clicks: number
  chapterCount: number
  lastChapterTitle: string | null
  updatedAt: string
}

export interface NovelDetail extends NovelListItem {
  chapters: ChapterListItem[] // 前 N 章（详情页最新章节预览）
  totalChapters: number
  firstChapterId: number | null
  lastChapterId: number | null
  /** PSEO 相关标签（书名词/作者词/已生成含书名长尾词），书籍页简介下方 chips */
  tags: string[]
}

export interface ChapterListItem {
  id: number
  idx: number
  title: string
  wordCount: number
}

export interface ChapterDetail {
  id: number
  novelId: number
  novelTitle: string
  idx: number
  title: string
  content: string
  wordCount: number
  prevId: number | null
  nextId: number | null
}

export interface HomeRankings {
  clicks: NovelListItem[]
  updates: NovelListItem[]
  finished: NovelListItem[]
}

export interface HomeData {
  featured: NovelListItem[]
  hot: NovelListItem[]
  latest: NovelListItem[]
  rankings: HomeRankings
  categories: CategoryDto[]
  stats: {
    novelCount: number
    chapterCount: number
    totalWordCount: number
    todayUpdates: number
  }
}

// ==================== SEO 配置 ====================

export interface SeoConfig {
  homeTitle: string
  homeDescription: string
  homeKeywords: string
  categoryTitle: string // 可用变量 {siteName} {categoryName} {page}
  categoryDescription: string
  bookTitle: string // {siteName} {novelTitle} {author} {categoryName} {status}
  bookDescription: string
  bookKeywords: string
  tocTitle: string // {novelTitle} {siteName}
  tocDescription: string
  chapterTitle: string // {novelTitle} {chapterTitle} {siteName} {idx}
  chapterDescription: string
  chapterKeywords: string
  searchTitle: string // {query}
  searchDescription: string
  pseoTitle: string // {keyword} {siteName}
  pseoDescription: string
  pseoKeywords: string
  autoFromContent: boolean // 是否从内容自动提取补充关键词
  pseo?: PseoRunnerConfig // PSEO 批量获取运行配置（multi-search-engine），存储于 seoConfig JSON
}

// ==================== PSEO 运行配置 ====================

export interface PseoRunnerConfig {
  sources: string[] // 启用的搜索引擎（SUPPORTED_ENGINES 白名单子集）
  seeds: string[] // 种子关键词（批量获取的输入，每行一个，≤20）
  perSeedLimit: number // 每个种子最多保留的下拉词数（3-20）
  maxKeywords: number // 单次批量运行入库上限（10-500）
  expand: boolean // 二级挖掘：以一级下拉词为新种子再获取一轮
  autoGenerate: boolean // 获取完成后自动为 pending 关键词生成聚合页
}

/** 页脚自定义链接（后台「页面底部」编辑产生） */
export interface FooterLink {
  label: string
  href: string
}

/**
 * 页面底部（页脚）配置。text/extra 留空 = 沿用主题默认文案；
 * links 为自定义链接列表（友链/备案号等），追加在主题页脚导航后。
 */
export interface FooterConfig {
  /** 主文案行（版权行）；空 = 主题默认 */
  text?: string
  /** 副文案行（免责声明等）；空 = 主题默认 */
  extra?: string
  /** 自定义链接（追加在主题页脚导航后，最多 10 条） */
  links?: FooterLink[]
}

export interface SettingsDto {
  siteName: string
  activeTheme: string
  notice: string
  seo: SeoConfig
  footer: FooterConfig
  home: HomeConfig
}

/**
 * 首页自定义图文区块（后台「设置 → 首页区块」编辑产生）。
 * 区块 = 标题 + 数据来源（最新/最热/精选/指定分类）+ 数量；前台按配置顺序渲染图文卡。
 */
export interface HomeBlockConfig {
  /** 稳定 id（编辑器生成，nanoid 语义即可，仅用于 React key） */
  id: string
  /** 区块标题（1-30 字） */
  title: string
  /** 数据来源：latest=最近更新 | hot=点击最多 | featured=精选 | `cat:<分类id>`=指定分类 */
  source: string
  /** 展示数量（4-24） */
  count: number
}

export interface HomeConfig {
  blocks: HomeBlockConfig[]
}

// ==================== PSEO ====================

export interface PseoPageData {
  keyword: string
  novels: NovelListItem[]
  generatedTitle: string
  generatedDescription: string
  generatedKeywords: string
}

// ==================== 采集 ====================

export interface ListRule {
  itemSelector?: string
  titleSelector?: string
  linkSelector?: string
  authorSelector?: string
  categorySelector?: string
  /**
   * 列表页分页 URL 模板（可选）：`{k}`=页码数字、`{url}`=首页 URL encode。
   * 配置后范围采集第 2..N 页只按模板生成（不再猜测 ?page=k / /page/k 变体），
   * 适配杰奇系 /list/1_{k}.html 等猜测永远落空的翻页形态；留空则维持自动猜测。
   */
  paginationTemplate?: string
}

export interface BookRule {
  titleSelector?: string
  authorSelector?: string
  descriptionSelector?: string
  coverSelector?: string
  statusSelector?: string
  categorySelector?: string
  chapterLinkSelector?: string
  chapterTitleSelector?: string
  /** 目录页链接选择器：书页仅含最新几章时指向完整目录页（如 a.catalog-more），worker 会二次抓取提取全部章节 */
  catalogLinkSelector?: string
  /** 排除选择器：提取前从 DOM 移除命中节点（如全站站标 h1.logo），多备用逗号分隔；'none' 用于 chapterLinkSelector 时表示跳过章节列表 */
  excludeSelector?: string
  /**
   * JSON 目录接口配置（JSON 字符串）：书页无完整 HTML 目录、完整目录由同源 AJAX 端点提供的
   * 现代 CMS（实测 ixdzs8.com POST /novel/clist/）。字段说明见引擎 extract/json-toc.ts。
   */
  chapterListApi?: string
}

export interface ChapterRule {
  titleSelector?: string
  contentSelector?: string
  nextSelector?: string
  /** 排除选择器：提取前从 DOM 移除命中节点（如全站站标 h1.logo、搜索框），多备用逗号分隔 */
  excludeSelector?: string
}

export interface ScrapeRuleDto {
  id: number
  name: string
  siteUrl: string
  enabled: boolean
  charset: string
  /** 站点级出口代理（空 = 直连） */
  proxy: string
  /** 跳过目标站 TLS 证书校验（自签/裸 IP 站点） */
  insecureTLS?: boolean
  listRule: ListRule
  bookRule: BookRule
  chapterRule: ChapterRule
  notes: string
}
