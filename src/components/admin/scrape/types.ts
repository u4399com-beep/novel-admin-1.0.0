/**
 * 采集中心共享类型（自 ScrapeCenter.tsx 拆分）。
 * 后端 API 契约见 /api/scrape-tasks、/api/scrape-rules 与 mini-services/scraper-service。
 */

import type { BookRule, ChapterRule, ListRule } from '@/lib/types'

/** 任务列表行（GET /api/scrape-tasks 响应条目） */
export interface TaskRow {
  id: number
  ruleId: number | null
  mode: string
  targetUrl: string
  pages: number
  status: string
  total: number
  done: number
  chaptersDone: number
  chaptersTotal: number
  created: number
  updated: number
  chapters: number
  message: string
  createdAt: string
  updatedAt: string
  /**
   * 起始页/并发数（可选）：当前 API 响应不含这两个字段（ScrapeTask 无对应列），
   * 编辑表单预填时以 undefined 兜底为默认值 1/3（见 TaskFormFields.taskFormFromRow）。
   */
  startPage?: number
  concurrency?: number
}

/** 任务详情（GET /api/scrape-tasks/[id] 响应，含日志） */
export interface TaskDetail extends TaskRow {
  log: string
  rule?: { id: number; name: string; charset: string } | null
}

/** 引擎抓取策略（GET /api/scrape?proxy=strategies 响应条目） */
export interface StrategyInfo {
  name: string
  description: string
  available: boolean
}

/** 规则编辑/新建对话框表单状态 */
export interface RuleFormState {
  id: number | null
  name: string
  siteUrl: string
  enabled: boolean
  charset: string
  proxy: string
  /** 跳过目标站 TLS 证书校验（自签/裸 IP 站点） */
  insecureTLS: boolean
  notes: string
  listRule: ListRule
  bookRule: BookRule
  chapterRule: ChapterRule
}

/** 选择器字段定义（规则编辑器分组渲染用） */
export interface FieldDef {
  key: string
  label: string
  ph: string
}
