import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { triggerScrapeTask } from '@/lib/scrape-worker'

export const dynamic = 'force-dynamic'

const MODES = new Set(['single', 'list'])
const STATUSES = new Set(['pending', 'running', 'success', 'partial', 'failed', 'canceled'])

/** 校验目标 URL：必须是合法 http/https 地址 */
function parseTargetUrl(raw: unknown): { ok: true; url: string } | { ok: false; message: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: 'targetUrl 必填' }
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, message: `targetUrl 仅支持 http/https（收到 ${u.protocol}）` }
    }
    return { ok: true, url: u.toString().slice(0, 500) }
  } catch {
    return { ok: false, message: `targetUrl 无法解析: ${String(raw).slice(0, 100)}` }
  }
}

/** 任务列表字段（不含 log，列表接口保持轻量） */
const LIST_SELECT = {
  id: true,
  ruleId: true,
  mode: true,
  targetUrl: true,
  pages: true,
  status: true,
  total: true,
  done: true,
  created: true,
  updated: true,
  chapters: true,
  message: true,
  createdAt: true,
  updatedAt: true,
} as const

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

  // chaptersDone/chaptersTotal 用原生 SQL 透出：长期运行的进程可能持有 schema 变更前的
  // Prisma Client（不重启无法刷新），类型化 select 会报 Unknown field；原生查询不依赖 dmmf
  const progressRows =
    list.length > 0
      ? await db
          .$queryRaw<{ id: number; chaptersDone: number; chaptersTotal: number }[]>`
            SELECT "id", "chaptersDone", "chaptersTotal" FROM "ScrapeTask" WHERE "id" IN (${Prisma.join(list.map((t) => t.id))})
          `
          .catch(() => [] as { id: number; chaptersDone: number; chaptersTotal: number }[])
      : []
  const progressById = new Map(progressRows.map((r) => [Number(r.id), r]))

  return NextResponse.json({
    list: list.map((t) => ({
      ...t,
      chaptersDone: progressById.get(t.id)?.chaptersDone ?? 0,
      chaptersTotal: progressById.get(t.id)?.chaptersTotal ?? 0,
    })),
    total,
    page,
    pageSize,
  })
}

// POST /api/scrape-tasks  { mode: 'single'|'list', targetUrl, ruleId?, pages? }
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '请求体必须是 JSON 对象' }, { status: 400 })
  }

  const mode = String(body.mode ?? '')
  if (!MODES.has(mode)) {
    return NextResponse.json({ error: 'mode 必须是 single 或 list' }, { status: 400 })
  }

  const target = parseTargetUrl(body.targetUrl)
  if (!target.ok) return NextResponse.json({ error: target.message }, { status: 400 })

  let ruleId: number | null = null
  if (body.ruleId !== undefined && body.ruleId !== null && body.ruleId !== '') {
    const rid = Number(body.ruleId)
    if (!Number.isInteger(rid) || rid <= 0) {
      return NextResponse.json({ error: '无效 ruleId' }, { status: 400 })
    }
    const exists = await db.scrapeRule.findUnique({ where: { id: rid }, select: { id: true } })
    if (!exists) return NextResponse.json({ error: '采集规则不存在' }, { status: 400 })
    ruleId = rid
  }

  let pages = 1
  if (body.pages !== undefined && body.pages !== null && body.pages !== '') {
    pages = Number(body.pages)
    if (!Number.isInteger(pages) || pages < 1 || pages > 20) {
      return NextResponse.json({ error: 'pages 需为 1-20 的整数' }, { status: 400 })
    }
  }

  const task = await db.scrapeTask.create({
    data: { mode, targetUrl: target.url, ruleId, pages },
    select: LIST_SELECT,
  })

  // fire-and-forget：worker 在后台执行，立即返回
  triggerScrapeTask(task.id)

  return NextResponse.json({ ok: true, task }, { status: 201 })
}
