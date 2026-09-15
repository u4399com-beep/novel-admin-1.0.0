import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const { name, sort } = (await req.json()) as { name?: string; sort?: number }
  const data: { name?: string; sort?: number } = {}
  if (typeof name === 'string' && name.trim()) data.name = name.trim().slice(0, 30)
  if (typeof sort === 'number') data.sort = sort
  try {
    const cat = await db.category.update({ where: { id: Number(id) }, data })
    return NextResponse.json({ id: cat.id, name: cat.name, sort: cat.sort })
  } catch {
    return NextResponse.json({ error: '分类不存在或名称冲突' }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const cid = Number(id)
  const count = await db.novel.count({ where: { categoryId: cid } })
  if (count > 0) {
    return NextResponse.json({ error: `该分类下还有 ${count} 本小说，无法删除` }, { status: 400 })
  }
  await db.category.delete({ where: { id: cid } })
  return NextResponse.json({ ok: true })
}
