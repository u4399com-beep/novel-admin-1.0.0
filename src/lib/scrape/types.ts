/**
 * 采集 worker 共享类型（引擎载荷 / 任务记录 / 进度写回字段）。
 * 仅供服务端使用（src/lib/scrape/*），勿在客户端 import。
 */

export type RuleMap = Record<string, string>

export interface LoadedRule {
  name?: string
  charset?: string
  /** 站点级出口代理（空/未配置 = 直连）；引擎各策略按能力走代理出口 */
  proxy?: string
  listRule: RuleMap
  bookRule: RuleMap
  chapterRule: RuleMap
}

export interface ChapterRef {
  title: string
  url: string | null
}

export interface BookData {
  title: string
  author: string
  description: string
  cover: string | null
  status: string
  category: string
  chapterCount: number
  chapters: ChapterRef[]
  /** 规则 catalogLinkSelector 命中的完整目录页绝对地址（未配置/未命中时为 null） */
  catalogUrl?: string | null
}

export interface ListItem {
  title: string
  url: string | null
  author: string
  category: string
}

export interface ChapterData {
  title: string
  content: string
  /** 引擎返回的分段正文（content 以 \n 连接的分段数组）；fetchChapterPaged 分页合并时同步续接 */
  paragraphs?: string[]
  wordCount: number
  nextUrl: string | null
}

export interface TaskRecord {
  id: number
  mode: string
  targetUrl: string
  pages: number
  ruleId: number | null
}

export interface BookOutcome {
  ok: boolean // 书籍是否成功入库（含"已入库但无章节链接"）
  canceled: boolean // 任务被取消/记录被删除；书籍级入库失败也走此通道（沿用原语义）
  chapters: number // 本次入库章节数
  failedChapters: number
  message: string
}

// ==================== 两阶段采集（阶段1 书籍+目录骨架 / 阶段2 章节内容批量回填） ====================

/** 阶段2 待回填章节：content='' 的骨架行 + 其源站 URL（URL 映射驻留任务内存，重跑任务时由阶段1重建） */
export interface PendingChapter {
  chapterId: number
  novelId: number
  url: string
  /** 书页 URL（章节抓取 Referer 来路，站点常校验 书页→章节 导航） */
  bookUrl: string
  bookTitle: string
}

/** 阶段1 单本书处理结果：书籍 upsert + 章节骨架入库 + 待回填清单 */
export interface MetaOutcome {
  ok: boolean
  canceled: boolean
  novelId: number
  title: string
  /** 过滤/去重/截断后的章节引用数（含已存在章节） */
  chapterRefs: number
  pending: PendingChapter[]
  message: string
}

/** 阶段2 批量回填结果 */
export interface FillOutcome {
  stored: number
  failed: number
  /** 并发另一任务已填充同章（内容守卫命中），不计成败 */
  skipped: number
  canceled: boolean
}

/** Run.flush 可写回的任务字段（全部为 ScrapeTask 标量列，类型化 update 直接支持） */
export interface TaskFlushFields {
  done?: number
  total?: number
  chaptersDone?: number
  chaptersTotal?: number
  created?: number
  updated?: number
  chapters?: number
}
