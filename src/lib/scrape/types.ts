/**
 * 采集 worker 共享类型（引擎载荷 / 任务记录 / 进度写回字段）。
 * 仅供服务端使用（src/lib/scrape/*），勿在客户端 import。
 */

export type RuleMap = Record<string, string>

export interface LoadedRule {
  /** 规则 id（书籍入库时记入 Novel.sourceRuleId，封面回填据此解析站点代理出口） */
  id?: number
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
  /** 分卷名（引擎从源站目录卷头提取；无卷结构为 undefined/空） */
  volume?: string
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
  /** list 模式：连续抓取的列表页数（从 startPage 起，无上限） */
  pages: number
  /** list 模式：起始页码（≥1） */
  startPage: number
  /** 任务内并发度（1-16）：list=同时处理的书本数，single=同时抓取的章节数 */
  concurrency: number
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
