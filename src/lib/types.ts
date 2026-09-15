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
}

export interface SettingsDto {
  siteName: string
  activeTheme: string
  notice: string
  seo: SeoConfig
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
}

export interface ChapterRule {
  titleSelector?: string
  contentSelector?: string
  nextSelector?: string
}

export interface ScrapeRuleDto {
  id: number
  name: string
  siteUrl: string
  enabled: boolean
  charset: string
  listRule: ListRule
  bookRule: BookRule
  chapterRule: ChapterRule
  notes: string
}
