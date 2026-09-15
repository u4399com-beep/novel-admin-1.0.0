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
  const { name } = (await req.json()) as { name?: string }
  if (!name?.trim()) return NextResponse.json({ error: '分类名不能为空' }, { status: 400 })
  const exists = await db.category.findUnique({ where: { name: name.trim() } })
  if (exists) return NextResponse.json({ error: '分类已存在' }, { status: 409 })
  const maxSort = await db.category.aggregate({ _max: { sort: true } })
  const cat = await db.category.create({ data: { name: name.trim().slice(0, 30), sort: (maxSort._max.sort ?? 0) + 1 } })
  return NextResponse.json({ id: cat.id, name: cat.name, sort: cat.sort, novelCount: 0 }, { status: 201 })
}
