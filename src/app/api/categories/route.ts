import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const categories = await db.category.findMany({
    orderBy: { sort: 'asc' },
    include: { _count: { select: { novels: true } } },
  })
  return NextResponse.json(
    categories.map((c) => ({ id: c.id, name: c.name, sort: c.sort, novelCount: c._count.novels }))
  )
}

export async function POST(req: NextRequest) {
  let name: string | undefined
  try {
    ;({ name } = (await req.json()) as { name?: string })
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  if (!name?.trim()) return NextResponse.json({ error: '分类名不能为空' }, { status: 400 })
  // 预检查与创建统一用截断后的名字：此前预检查用未截断全名、创建用截断名，
  // 超过 30 字的名字重复 POST 时预检查必不命中 → create 撞 name 唯一约束 → 500
  const trimmed = name.trim().slice(0, 30)
  const exists = await db.category.findUnique({ where: { name: trimmed } })
  if (exists) return NextResponse.json({ error: '分类已存在' }, { status: 409 })
  const maxSort = await db.category.aggregate({ _max: { sort: true } })
  try {
    const cat = await db.category.create({ data: { name: trimmed, sort: (maxSort._max.sort ?? 0) + 1 } })
    return NextResponse.json({ id: cat.id, name: cat.name, sort: cat.sort, novelCount: 0 }, { status: 201 })
  } catch (e) {
    // 并发同名 POST 的输家撞 P2002：回读既有行按幂等创建返回（200 + 既有行），不再 500
    if ((e as { code?: string })?.code !== 'P2002') throw e
    const winner = await db.category
      .findUnique({ where: { name: trimmed }, include: { _count: { select: { novels: true } } } })
      .catch(() => null)
    if (!winner) return NextResponse.json({ error: '分类创建失败（并发冲突且未找到既有分类）' }, { status: 409 })
    return NextResponse.json({ id: winner.id, name: winner.name, sort: winner.sort, novelCount: winner._count.novels })
  }
}
