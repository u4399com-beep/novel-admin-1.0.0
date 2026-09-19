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
  /** 搜索引擎下拉词（采集时绑定，逗号分隔；书页「相关搜索」内链数据源） */
  suggestKeywords: string
}

export interface ChapterListItem {
  id: number
  idx: number
  title: string
  wordCount: number
  /** 分卷名（源站目录自带卷头时非空；无卷结构为空串） */
  volume: string
}

export interface ChapterDetail {
  id: number
  novelId: number
  novelTitle: string
  idx: number
  title: string
  content: string
  wordCount: number
  /** 本章所属分卷名（无卷结构为空串） */
  volume: string
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
  collectBind: boolean // 采集时自动为书籍取下拉词并绑定书籍生成 PSEO 书籍页（默认开启）
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
  /** 分卷标题选择器：目录容器内卷头元素（如 #list dl dt）；未配置时用内置启发式（dt/卷名模式） */
  volumeSelector?: string
  /** 目录页链接选择器：书页仅含最新几章时指向完整目录页（如 a.catalog-more），worker 会二次抓取提取全部章节 */
  catalogLinkSelector?: string
  /** 排除选择器：提取前从 DOM 移除命中节点（如全站站标 h1.logo），多备用逗号分隔；'none' 用于 chapterLinkSelector 时表示跳过章节列表 */
  excludeSelector?: string
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
  listRule: ListRule
  bookRule: BookRule
  chapterRule: ChapterRule
  notes: string
}
