import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { canonicalCategory, FALLBACK_CATEGORY } from '@/lib/scrape/category'

export const dynamic = 'force-dynamic'

/**
 * 智能分类同类合并 API
 *
 * GET  /api/categories/merge
 *   返回建议合并对列表（规则引擎计算：归一化+同义词+规范词包含，确定性、零网络/零 LLM）。
 *   每项：{ sourceId, source, target, targetId, reason, bookCount }
 *   targetId=null 表示目标分类尚不存在（前端提供「新建并合并」选项）。
 *
 * POST /api/categories/merge   body: { fromId: number, toId?: number, toName?: string }
 *   执行合并：源分类下所有书籍迁移到目标分类 → 删除空的源分类（事务式，失败整体回滚）。
 *   目标优先用 toId（必须已存在）；传 toName 且不存在时自动创建（对应建议中的未建目标）。
 */

/** 建议合并对（GET 响应体元素） */
export interface MergeSuggestion {
  sourceId: number
  source: string
  target: string
  /** 目标分类 id（目标尚不存在时为 null，POST 用 toName 建后合并） */
  targetId: number | null
  reason: string
  bookCount: number
}

export async function GET() {
  const categories = await db.category.findMany({
    orderBy: { sort: 'asc' },
    include: { _count: { select: { novels: true } } },
  })
  const byName = new Map(categories.map((c) => [c.name, c]))
  const suggestions: MergeSuggestion[] = []
  for (const c of categories) {
    // 保留分类（「未分类」）永不作为合并源（系统兜底去处）
    if (c.name === FALLBACK_CATEGORY) continue
    // 归一化+同义词+关键词包含（必要时 LLM 兜底）：返回规范分类名
    const canon = await canonicalCategory(c.name)
    // 归并失败（归「未分类」，需人工判断）或目标与自身同名（已归类到位）→ 不进建议
    if (canon === c.name || canon === FALLBACK_CATEGORY) continue
    const target = byName.get(canon) ?? null
    suggestions.push({
      sourceId: c.id,
      source: c.name,
      target: canon,
      targetId: target?.id ?? null,
      reason: `归一化归并：「${c.name}」可并入规范分类「${canon}」`,
      bookCount: c._count.novels,
    })
  }
  return NextResponse.json(suggestions)
}

export async function POST(req: NextRequest) {
  let body: { fromId?: number; toId?: number; toName?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const fromId = body.fromId
  const toId = typeof body.toId === 'number' ? body.toId : undefined
  // toName 仅供目标分类尚不存在的建议对使用（如 N次元 → 同人 的「同人」）
  const toName = typeof body.toName === 'string' ? body.toName.trim().slice(0, 50) : undefined
  if (!Number.isInteger(fromId) || fromId! <= 0) {
    return NextResponse.json({ error: '无效的源分类 ID' }, { status: 400 })
  }
  if (toId === undefined && !toName) {
    return NextResponse.json({ error: '缺少目标分类（toId 或 toName）' }, { status: 400 })
  }

  const from = await db.category.findUnique({ where: { id: fromId } })
  if (!from) return NextResponse.json({ error: '源分类不存在' }, { status: 404 })

  // 目标定位/创建放在事务外：创建目标分类是幂等友好的独立动作（即使后续迁移失败回滚，
  // 留下的也是规范分类空壳，ensureCategory 之后会复用，无害）
  let target: { id: number; name: string } | null = null
  if (toId !== undefined) {
    if (toId === fromId) return NextResponse.json({ error: '源分类与目标分类相同' }, { status: 400 })
    target = await db.category.findUnique({ where: { id: toId } })
    if (!target) return NextResponse.json({ error: '目标分类不存在' }, { status: 404 })
  } else if (toName) {
    if (toName === from.name) return NextResponse.json({ error: '源分类与目标分类相同' }, { status: 400 })
    target = await db.category.findUnique({ where: { name: toName } })
    if (!target) {
      try {
        target = await db.category.create({ data: { name: toName, sort: from.sort } })
      } catch {
        // 并发创建撞唯一约束 → 回读
        target = await db.category.findUnique({ where: { name: toName } })
        if (!target) return NextResponse.json({ error: '目标分类创建失败' }, { status: 400 })
      }
    }
  }
  if (!target) return NextResponse.json({ error: '目标分类不存在' }, { status: 404 })
  const to = target // const 快照：事务闭包内类型收窄稳定，不受外层 let 重赋值影响

  try {
    // 事务式合并：迁书 → 删空源分类。任一步失败整体回滚，不会出现「书已迁移但源分类还在」的中间态
    const moved = await db.$transaction(async (tx) => {
      const r = await tx.novel.updateMany({
        where: { categoryId: fromId },
        data: { categoryId: to.id },
      })
      await tx.category.delete({ where: { id: fromId } })
      return r.count
    })
    return NextResponse.json({ ok: true, moved, from: from.name, to: to.name })
  } catch (e) {
    // 外键约束冲突（合并窗口期又有书归入源分类）→ 409 提示重试；其余原样透出
    const code = (e as { code?: string })?.code
    if (code === 'P2003') {
      return NextResponse.json({ error: '合并冲突（源分类在合并期间又有书籍归入），请重试' }, { status: 409 })
    }
    return NextResponse.json(
      { error: `合并失败：${e instanceof Error ? e.message.slice(0, 120) : '未知错误'}` },
      { status: 500 }
    )
  }
}
