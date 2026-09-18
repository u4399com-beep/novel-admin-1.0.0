import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parsePositiveInt } from '@/lib/scrape/api-utils'

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
