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
  /** 分卷标题选择器：目录容器内卷头元素（如 #list dl dt）；未配置时用内置启发式（dt/卷名模式） */
  volumeSelector?: string
  /** 目录页链接选择器：书页仅含最新几章时，指向完整目录页（如 a.catalog-more）；命中后 worker 会二次抓取目录页提取全部章节 */
  catalogLinkSelector?: string
  /** 排除选择器：提取前先从 DOM 移除命中节点（如全站站标 h1.logo、搜索框），多备用逗号分隔 */
  excludeSelector?: string
}

export interface ChapterRule {
  titleSelector?: string
  contentSelector?: string
  nextSelector?: string
  /** 排除选择器：提取前先从 DOM 移除命中节点（如全站站标 h1.logo、搜索框），多备用逗号分隔 */
  excludeSelector?: string
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
  /** 可选 Referer 链（Task 23-a）：合法 http(s) URL，策略层注入请求头；不传时行为与原先一致 */
  referer?: string
}

export interface ChapterRequestBody {
  url: string
  rule?: ChapterRule
  charset?: string
  strategy?: string
  timeoutMs?: number
  /** 可选 Referer 链（Task 23-a）：合法 http(s) URL，策略层注入请求头；不传时行为与原先一致 */
  referer?: string
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
  /** 命中挑战页判定（反爬平台强特征 / <3KB 挑战关键词（latin1+UTF-8+GB18030 三解码匹配）/ 0 秒 meta-refresh 跳板之一） */
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
