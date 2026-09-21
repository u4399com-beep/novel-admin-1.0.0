/**
 * 策略层共享类型：单次尝试结果 / 原始响应 / 策略定义 / 抓取入口出入参。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移）
 */
import type { AttemptSummary, RobotsSummary, SubAttempt } from '../types'

export type { SubAttempt }

export interface AttemptResult {
  ok: boolean
  status: number
  bytes: Uint8Array
  contentType: string
  warnings: string[]
  note?: string
  /** 策略内部的子尝试明细（UA 轮换画像 / h2→h1 降级等），fetchPage 会摊平进 attempts */
  subAttempts?: SubAttempt[]
  /** 目标站通过 Retry-After 头给出的退避指引（毫秒，已封顶 30s），供策略链退避时优先采用 */
  retryAfterMs?: number | null
}

export interface FetchPageOptions {
  requestedStrategy?: string | null
  forcedCharset?: string | null
  timeoutMs?: number
  /** 可选 Referer 链：调用方显式提供的来路（如书页 URL），策略层注入请求头；缺省时维持原行为（站内首页/无 Referer 变体） */
  referer?: string | null
  /**
   * 站点级出口代理（规则配置，如 http://host:port、socks5h://host:port）。
   * 配置后策略链按各策略能力走代理出口（fetch 系/curl-impersonate/got-scraping/browser）；
   * 代理失败按普通失败继续后续策略。未配置时维持直连行为不变。
   */
  proxy?: string | null
}

/** 策略 run 的可选上下文（新增字段必须可选+默认值，保证既有策略实现兼容） */
export interface StrategyRunCtx {
  /** 显式 Referer：非空时覆盖「目标站首页」自动 Referer（仅对 referer:true 的画像生效；无 Referer 变体仍保持无 Referer 以保留链内多样性） */
  referer?: string | null
  /** 站点级出口代理（规则配置）：仅对支持代理的策略生效，见 FetchPageOptions.proxy */
  proxy?: string | null
}

export interface FetchPageResult {
  ok: boolean
  html: string
  encoding: string
  strategy: string
  status: number
  warnings: string[]
  attempts: AttemptSummary[]
  robots: RobotsSummary
  elapsedMs: number
  error?: string
  detail?: string
}

export interface StrategyDef {
  name: string
  description: string
  probe(): Promise<boolean>
  run(url: string, timeoutMs: number, warnings: string[], ctx?: StrategyRunCtx): Promise<AttemptResult>
  /** true = 策略内部已自带多画像/多协议重试梯子，外层不再按 MAX_ATTEMPTS 重试 */
  selfRetrying?: boolean
}

export interface RawResponse {
  ok: boolean
  status: number
  bytes: Uint8Array
  contentType: string
  finalUrl?: string
  note?: string
  warning?: string
  /** 目标站 Retry-After 头解析结果（毫秒），仅 429/503 时存在 */
  retryAfterMs?: number | null
}
