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
  const trimmed = name.trim().slice(0, 30)
  const exists = await db.category.findUnique({ where: { name: trimmed } })
  if (exists) return NextResponse.json({ error: '分类已存在' }, { status: 409 })
  const maxSort = await db.category.aggregate({ _max: { sort: true } })
  try {
    const cat = await db.category.create({ data: { name: trimmed, sort: (maxSort._max.sort ?? 0) + 1 } })
    return NextResponse.json({ id: cat.id, name: cat.name, sort: cat.sort, novelCount: 0 }, { status: 201 })
  } catch (e) {
    // exists 预检与 create 之间的并发窗口可能撞 name 唯一约束：回读后按 409 返回（与预检语义一致），而非 500
    if ((e as { code?: string })?.code !== 'P2002') throw e
    const winner = await db.category.findUnique({ where: { name: trimmed } })
    if (!winner) return NextResponse.json({ error: '分类创建失败' }, { status: 500 })
    return NextResponse.json({ error: '分类已存在' }, { status: 409 })
  }
}
