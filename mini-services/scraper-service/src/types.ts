/**
 * 与主站 /home/z/my-project/src/lib/types.ts 保持一致的采集规则 DTO（子集）。
 * 规则结构必须与主站一致，主站通过 /api/scrape?proxy=test|chapter 转发这些结构。
 */

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

/** 完整规则 DTO（与主站一致，供参考/透传） */
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

// ==================== 服务端请求/响应类型 ====================

export interface TestRequestBody {
  url: string
  rule?: {
    listRule?: ListRule
    bookRule?: BookRule
    chapterRule?: ChapterRule
  }
  strategy?: string
  charset?: string
  timeoutMs?: number
}

export interface ChapterRequestBody {
  url: string
  rule?: ChapterRule
  charset?: string
  strategy?: string
  timeoutMs?: number
}

export interface StrategyInfo {
  name: string
  available: boolean
  description: string
}

export interface AttemptSummary {
  strategy: string
  ok: boolean
  status: number
  ms: number
  note?: string
  /** 策略内部子尝试使用的头部画像（UA 轮换/移动端/spider 降级时区分具体画像） */
  profile?: string
  /** 命中挑战页判定（响应 <3KB 且含 verify/challenge/captcha/javascript 关键词） */
  blocked?: boolean
  /** 响应字节数（调试挑战页/空响应时有用） */
  bytes?: number
}

/** 策略内部一次子尝试（如 UA 轮换中的单个画像、got-scraping 的 h2→h1 降级） */
export interface SubAttempt {
  profile: string
  ok: boolean
  status: number
  ms: number
  blocked: boolean
  bytes: number
  note?: string
}

export interface RobotsSummary {
  checked: boolean
  disallowed: boolean
  crawlDelayMs: number | null
}
