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
  run(url: string, timeoutMs: number, warnings: string[]): Promise<AttemptResult>
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
