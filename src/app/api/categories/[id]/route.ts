import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const cid = Number(id)
  if (!Number.isInteger(cid) || cid <= 0) return NextResponse.json({ error: '无效 ID' }, { status: 400 })
  let name: string | undefined
  let sort: number | undefined
  try {
    ;({ name, sort } = (await req.json()) as { name?: string; sort?: number })
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const data: { name?: string; sort?: number } = {}
  if (typeof name === 'string' && name.trim()) data.name = name.trim().slice(0, 30)
  if (typeof sort === 'number' && Number.isInteger(sort)) data.sort = sort
  try {
    const cat = await db.category.update({ where: { id: cid }, data })
    return NextResponse.json({ id: cat.id, name: cat.name, sort: cat.sort })
  } catch (e) {
    // 细分语义：不存在 → 404；名称唯一约束冲突 → 409；其余 → 400（原实现一律 400）
    const code = (e as { code?: string })?.code
    if (code === 'P2025') return NextResponse.json({ error: '分类不存在' }, { status: 404 })
    if (code === 'P2002') return NextResponse.json({ error: '分类名称已存在' }, { status: 409 })
    return NextResponse.json({ error: '更新失败' }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const cid = Number(id)
  if (!Number.isInteger(cid) || cid <= 0) return NextResponse.json({ error: '无效 ID' }, { status: 400 })
  const count = await db.novel.count({ where: { categoryId: cid } })
  if (count > 0) {
    return NextResponse.json({ error: `该分类下还有 ${count} 本小说，无法删除` }, { status: 400 })
  }
  try {
    await db.category.delete({ where: { id: cid } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: '分类不存在' }, { status: 404 })
  }
}
