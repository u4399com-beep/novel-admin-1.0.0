import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseHttpUrl, parsePositiveInt } from '@/lib/scrape/api-utils'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

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

// PUT /api/scrape-tasks/[id] —— 编辑待执行任务（用户指令「采集任务要可编辑」）
// 仅 pending 可编辑：running 编辑会与 worker 读到的旧参数脱节（409 引导先取消）；
// 终态任务参数已执行完毕，编辑无意义（409 引导新建任务）。
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id: raw } = await ctx.params
  const id = parsePositiveInt(raw)
  if (!id) return badRequest('无效任务 ID')

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return badRequest('请求体必须是 JSON 对象')
  }

  const task = await db.scrapeTask
    .findUnique({ where: { id }, select: { status: true } })
    .catch(() => null)
  if (!task) return notFound()
  if (task.status === 'running') {
    return NextResponse.json({ error: '任务执行中不可编辑，请先取消' }, { status: 409 })
  }
  if (task.status !== 'pending') {
    return NextResponse.json({ error: `任务已结束（${task.status}），请新建任务` }, { status: 409 })
  }

  // 与 POST 同口径的局部更新：只更新出现的字段，全部字段均可选
  const data: { mode?: string; targetUrl?: string; ruleId?: number | null; pages?: number } = {}

  if (body.mode !== undefined) {
    const mode = String(body.mode)
    if (mode !== 'single' && mode !== 'list') return badRequest('mode 必须是 single 或 list')
    data.mode = mode
  }

  if (body.targetUrl !== undefined) {
    const target = parseHttpUrl(body.targetUrl, 'targetUrl', 500)
    if (!target.ok) return badRequest(target.message)
    data.targetUrl = target.value
  }

  if (body.ruleId !== undefined) {
    if (body.ruleId === null || body.ruleId === '') {
      data.ruleId = null
    } else {
      const rid = parsePositiveInt(body.ruleId)
      if (rid === null) return badRequest('无效 ruleId')
      const exists = await db.scrapeRule.findUnique({ where: { id: rid }, select: { id: true } })
      if (!exists) return badRequest('采集规则不存在')
      data.ruleId = rid
    }
  }

  if (body.pages !== undefined && body.pages !== null && body.pages !== '') {
    const p = parsePositiveInt(body.pages)
    if (p === null || p > 999) return badRequest('pages 需为 1-999 的整数')
    data.pages = p
  }

  if (Object.keys(data).length === 0) return badRequest('没有可更新的字段')

  const updated = await db.scrapeTask
    .update({ where: { id }, data, select: { id: true, mode: true, targetUrl: true, ruleId: true, pages: true, status: true } })
    .catch(() => null)
  if (!updated) return notFound()
  return NextResponse.json({ ok: true, task: updated })
}

// PATCH /api/scrape-tasks/[id]  { action: 'cancel' }
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id: raw } = await ctx.params
  const id = parsePositiveInt(raw)
  if (!id) return badRequest('无效任务 ID')

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null
  if (!body || body.action !== 'cancel') {
    return badRequest("action 必须为 'cancel'")
  }

  const task = await db.scrapeTask
    .findUnique({ where: { id }, select: { status: true } })
    .catch(() => null)
  if (!task) return notFound()
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
