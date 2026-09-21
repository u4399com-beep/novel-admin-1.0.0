import { statSync } from 'node:fs'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseHttpUrl, parsePositiveInt } from '@/lib/scrape/api-utils'

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
    // 用户指令「取消采集数量的限制」：上限 20 → 999（1-999 页，仍拒零/负/超阈值防滥用）
    if (p === null || p > 999) {
      return NextResponse.json({ error: 'pages 需为 1-999 的整数' }, { status: 400 })
    }
    pages = p
  }

  const task = await db.scrapeTask.create({
    data: { mode, targetUrl: target.value, ruleId, pages },
    select: LIST_SELECT,
  })

  /**
   * 采集执行归属：worker 负载（并发抓取/批量骨架/正文缓冲）只由独立 runner 进程承担
   * （scripts/worker-runner.ts，2s 轮询 pending 任务 + 心跳文件）。
   * 本轮禁用 Next 进程 inline 兜底执行：runner 死亡时 inline 把全部采集负载压进 Next，
   * 实测进程 RSS 飙至 1.4GB（用户核心诉求「不要堆内存堆到服务器崩溃」）；改为始终返回
   * runner 状态，任务由 runner 的 2s 轮询领取（runner 由看护脚本/定时任务自动拉起）。
   */
  let runnerAlive = false
  try {
    runnerAlive = Date.now() - statSync('/tmp/scrape-runner-heartbeat').mtimeMs < 10_000
  } catch {
    runnerAlive = false
  }

  return NextResponse.json(
    {
      ok: true,
      task,
      runner: runnerAlive ? 'runner' : 'watchdog-pending',
      ...(runnerAlive ? {} : { note: 'runner 暂不在线，任务已入库待执行（看护进程会在 1 分钟内拉起 runner 自动领取）' }),
    },
    { status: 201 },
  )
}
