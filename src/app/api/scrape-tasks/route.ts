import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseHttpUrl, parsePositiveInt } from '@/lib/scrape/api-utils'
import { triggerScrapeTask } from '@/lib/scrape/worker'

export const dynamic = 'force-dynamic'

const MODES = new Set(['single', 'list'])
const STATUSES = new Set(['pending', 'running', 'success', 'partial', 'failed', 'canceled'])

/** 任务列表字段（不含 log，列表接口保持轻量；chaptersDone/chaptersTotal 为类型化直查） */
const LIST_SELECT = {
  id: true,
  ruleId: true,
  mode: true,
  targetUrl: true,
  pages: true,
  startPage: true,
  concurrency: true,
  status: true,
  total: true,
  done: true,
  created: true,
  updated: true,
  chapters: true,
  message: true,
  createdAt: true,
  updatedAt: true,
  chaptersDone: true,
  chaptersTotal: true,
} as const

/** 页数上限仅防畸形输入（如 1e9），业务上不限制采集范围 */
const MAX_PAGES = 2000
/** 任务内并发度范围（1-16）：list=书籍并行路数，single=章节并行路数 */
const MAX_CONCURRENCY = 16

// GET /api/scrape-tasks?page=1&pageSize=20&status=running
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const page = Math.min(1000, Math.max(1, Math.floor(Number(sp.get('page')) || 1)))
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(sp.get('pageSize')) || 20)))
  const status = sp.get('status') ?? ''
  const where = STATUSES.has(status) ? { status } : {}

  const [total, list] = await Promise.all([
    db.scrapeTask.count({ where }),
    db.scrapeTask.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: LIST_SELECT,
    }),
  ])

  return NextResponse.json({ list, total, page, pageSize })
}

/**
 * POST /api/scrape-tasks  { mode, targetUrl, ruleId?, pages?, startPage?, concurrency? }
 * 多任务天然并行：每次 POST 触发独立 worker，多个任务/多本书/多章节同时采集
 * （任务内并发度由 concurrency 控制，任务间无互斥）。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '请求体必须是 JSON 对象' }, { status: 400 })
  }

  const mode = String(body.mode ?? '')
  if (!MODES.has(mode)) {
    return NextResponse.json({ error: 'mode 必须是 single 或 list' }, { status: 400 })
  }

  const target = parseHttpUrl(body.targetUrl, 'targetUrl', 500)
  if (!target.ok) return NextResponse.json({ error: target.message }, { status: 400 })

  let ruleId: number | null = null
  if (body.ruleId !== undefined && body.ruleId !== null && body.ruleId !== '') {
    const rid = parsePositiveInt(body.ruleId)
    if (rid === null) {
      return NextResponse.json({ error: '无效 ruleId' }, { status: 400 })
    }
    const exists = await db.scrapeRule.findUnique({ where: { id: rid }, select: { id: true } })
    if (!exists) return NextResponse.json({ error: '采集规则不存在' }, { status: 400 })
    ruleId = rid
  }

  let pages = 1
  if (body.pages !== undefined && body.pages !== null && body.pages !== '') {
    const p = parsePositiveInt(body.pages)
    if (p === null || p > MAX_PAGES) {
      return NextResponse.json({ error: `pages 需为 1-${MAX_PAGES} 的整数` }, { status: 400 })
    }
    pages = p
  }

  // 范围采集起始页码：默认第 1 页，可从任意页开始采集
  let startPage = 1
  if (body.startPage !== undefined && body.startPage !== null && body.startPage !== '') {
    const sp = parsePositiveInt(body.startPage)
    if (sp === null) {
      return NextResponse.json({ error: 'startPage 需为正整数' }, { status: 400 })
    }
    startPage = sp
  }

  // 任务内并发度（1-16）：list=同时处理的书本数，single=同时抓取的章节数
  let concurrency = 3
  if (body.concurrency !== undefined && body.concurrency !== null && body.concurrency !== '') {
    const c = parsePositiveInt(body.concurrency)
    if (c === null || c > MAX_CONCURRENCY) {
      return NextResponse.json({ error: `concurrency 需为 1-${MAX_CONCURRENCY} 的整数` }, { status: 400 })
    }
    concurrency = c
  }

  const task = await db.scrapeTask.create({
    data: { mode, targetUrl: target.value, ruleId, pages, startPage, concurrency },
    select: LIST_SELECT,
  })

  // fire-and-forget：worker 在后台执行，立即返回（不阻塞创建下一个任务）
  triggerScrapeTask(task.id)

  return NextResponse.json({ ok: true, task }, { status: 201 })
}
