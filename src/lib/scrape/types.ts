/**
 * 采集 worker 共享类型（引擎载荷 / 任务记录 / 进度写回字段）。
 * 仅供服务端使用（src/lib/scrape/*），勿在客户端 import。
 */

export type RuleMap = Record<string, string>

export interface LoadedRule {
  name?: string
  charset?: string
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
