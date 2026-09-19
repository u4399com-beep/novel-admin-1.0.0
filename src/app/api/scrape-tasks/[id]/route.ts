import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseHttpUrl, parsePositiveInt } from '@/lib/scrape/api-utils'
import { triggerScrapeTask } from '@/lib/scrape/worker'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const MODES = new Set(['single', 'list'])
const TERMINAL_STATUSES = new Set(['success', 'partial', 'failed', 'canceled'])

/** 页数/并发度边界（与 POST /api/scrape-tasks 同口径） */
const MAX_PAGES = 2000
const MAX_CONCURRENCY = 16

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

function notFound(message = '任务不存在') {
  return NextResponse.json({ error: message }, { status: 404 })
}

// GET /api/scrape-tasks/[id] —— 详情（含完整日志；chaptersDone/chaptersTotal 类型化直查）
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id: raw } = await ctx.params
  const id = parsePositiveInt(raw)
  if (!id) return badRequest('无效任务 ID')

  const task = await db.scrapeTask.findUnique({
    where: { id },
    include: { rule: { select: { id: true, name: true, charset: true } } },
  })
  if (!task) return notFound()

  return NextResponse.json({ task })
}

/**
 * PATCH /api/scrape-tasks/[id]
 * - { action: 'cancel' }  取消执行中/待执行任务
 * - { action: 'edit', mode?, targetUrl?, ruleId?, pages?, startPage?, concurrency? }
 *   编辑任务配置（任务可再编辑）：执行中(running)不可编辑；其余状态均可改，
 *   编辑 pending 任务若 worker 已加载旧配置则本次执行仍用旧值（编辑后可重跑生效）
 * - { action: 'rerun' }   终态任务重新排队执行（进度计数清零）
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: raw } = await ctx.params
  const id = parsePositiveInt(raw)
  if (!id) return badRequest('无效任务 ID')

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.action !== 'string') {
    return badRequest("action 必须为 'cancel' | 'edit' | 'rerun'")
  }

  const task = await db.scrapeTask.findUnique({ where: { id } }).catch(() => null)
  if (!task) return notFound()

  // ---- 取消 ----
  if (body.action === 'cancel') {
    if (task.status !== 'pending' && task.status !== 'running') {
      return badRequest(`当前状态 ${task.status} 不可取消`)
    }
    // 置 canceled 后，worker 在下一个协作检查点自行停止；
    // 条件更新防止与 worker 的终态写入竞态：若任务恰在此间隙终结/被删，count=0，不会覆盖终态
    const res = await db.scrapeTask
      .updateMany({
        where: { id, status: { in: ['pending', 'running'] } },
        data: { status: 'canceled', message: '已手动取消' },
      })
      .catch(() => null)
    if (!res || res.count === 0) {
      const fresh = await db.scrapeTask
        .findUnique({ where: { id }, select: { status: true } })
        .catch(() => null)
      if (!fresh) return notFound()
      return badRequest(`当前状态 ${fresh.status} 不可取消`)
    }
    return NextResponse.json({ ok: true })
  }

  // ---- 编辑 ----
  if (body.action === 'edit') {
    if (task.status === 'running') {
      return NextResponse.json({ error: '任务执行中，请先取消再编辑' }, { status: 409 })
    }
    const data: {
      mode?: string
      targetUrl?: string
      ruleId?: number | null
      pages?: number
      startPage?: number
      concurrency?: number
    } = {}

    if (body.mode !== undefined) {
      const mode = String(body.mode)
      if (!MODES.has(mode)) return badRequest('mode 必须是 single 或 list')
      data.mode = mode
    }
    if (body.targetUrl !== undefined) {
      const target = parseHttpUrl(body.targetUrl, 'targetUrl', 500)
      if (!target.ok) return badRequest(target.message)
      data.targetUrl = target.value
    }
    if (body.ruleId !== undefined) {
      if (body.ruleId === null || body.ruleId === '' || body.ruleId === 'none') {
        data.ruleId = null
      } else {
        const rid = parsePositiveInt(body.ruleId)
        if (rid === null) return badRequest('无效 ruleId')
        const exists = await db.scrapeRule.findUnique({ where: { id: rid }, select: { id: true } })
        if (!exists) return badRequest('采集规则不存在')
        data.ruleId = rid
      }
    }
    if (body.pages !== undefined) {
      const p = parsePositiveInt(body.pages)
      if (p === null || p > MAX_PAGES) return badRequest(`pages 需为 1-${MAX_PAGES} 的整数`)
      data.pages = p
    }
    if (body.startPage !== undefined) {
      const sp = parsePositiveInt(body.startPage)
      if (sp === null) return badRequest('startPage 需为正整数')
      data.startPage = sp
    }
    if (body.concurrency !== undefined) {
      const c = parsePositiveInt(body.concurrency)
      if (c === null || c > MAX_CONCURRENCY) return badRequest(`concurrency 需为 1-${MAX_CONCURRENCY} 的整数`)
      data.concurrency = c
    }
    if (Object.keys(data).length === 0) return badRequest('未提供任何可编辑字段')

    const updated = await db.scrapeTask
      .update({ where: { id }, data })
      .catch(() => null)
    if (!updated) return notFound()
    return NextResponse.json({ ok: true, task: updated })
  }

  // ---- 重跑 ----
  if (body.action === 'rerun') {
    if (!TERMINAL_STATUSES.has(task.status)) {
      return badRequest(`当前状态 ${task.status} 不可重跑（仅终态任务可重新执行）`)
    }
    const res = await db.scrapeTask
      .updateMany({
        where: { id, status: { in: [...TERMINAL_STATUSES] } },
        data: {
          status: 'pending',
          message: '',
          total: 0,
          done: 0,
          chaptersDone: 0,
          chaptersTotal: 0,
          created: 0,
          updated: 0,
          chapters: 0,
          log: '',
        },
      })
      .catch(() => null)
    if (!res || res.count === 0) return badRequest('任务状态已变化，请刷新后重试')
    triggerScrapeTask(id)
    return NextResponse.json({ ok: true })
  }

  return badRequest("action 必须为 'cancel' | 'edit' | 'rerun'")
}

// DELETE /api/scrape-tasks/[id]
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id: raw } = await ctx.params
  const id = parsePositiveInt(raw)
  if (!id) return badRequest('无效任务 ID')

  const task = await db.scrapeTask
    .findUnique({ where: { id }, select: { status: true } })
    .catch(() => null)
  if (!task) return notFound()
  if (task.status === 'running') {
    return NextResponse.json({ error: '任务执行中，请先取消再删除' }, { status: 409 })
  }

  // pending 允许删：即便 worker 恰在启动，删除后其 pending→running 条件更新必然 count=0，安全退出
  const deleted = await db.scrapeTask.delete({ where: { id } }).catch(() => null)
  if (!deleted) return notFound()
  return NextResponse.json({ ok: true })
}
