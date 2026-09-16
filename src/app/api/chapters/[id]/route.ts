import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const cid = Number(id)
  if (!Number.isInteger(cid)) return NextResponse.json({ error: '无效 ID' }, { status: 400 })

  const chapter = await db.chapter.findUnique({
    where: { id: cid },
    include: { novel: { select: { id: true, title: true, author: true } } },
  })
  if (!chapter) return NextResponse.json({ error: '章节不存在' }, { status: 404 })

  const [prev, next] = await Promise.all([
    db.chapter.findFirst({ where: { novelId: chapter.novelId, idx: { lt: chapter.idx } }, orderBy: { idx: 'desc' }, select: { id: true } }),
    db.chapter.findFirst({ where: { novelId: chapter.novelId, idx: { gt: chapter.idx } }, orderBy: { idx: 'asc' }, select: { id: true } }),
  ])

  return NextResponse.json({
    id: chapter.id,
    novelId: chapter.novelId,
    novelTitle: chapter.novel.title,
    idx: chapter.idx,
    title: chapter.title,
    content: chapter.content,
    wordCount: chapter.wordCount,
    prevId: prev?.id ?? null,
    nextId: next?.id ?? null,
  })
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const cid = Number(id)
  if (!Number.isInteger(cid) || cid <= 0) return NextResponse.json({ error: '无效 ID' }, { status: 400 })
  let body: { title?: string; content?: string }
  try {
    body = (await req.json()) as { title?: string; content?: string }
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const data: { title?: string; content?: string; wordCount?: number } = {}
  if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 120)
  if (typeof body.content === 'string') {
    data.content = body.content
    data.wordCount = body.content.replace(/\s/g, '').length
  }
  try {
    const ch = await db.chapter.update({ where: { id: cid }, data })
    const agg = await db.chapter.aggregate({ where: { novelId: ch.novelId }, _sum: { wordCount: true } })
    await db.novel.update({ where: { id: ch.novelId }, data: { wordCount: agg._sum.wordCount ?? 0, updatedAt: new Date() } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: '章节不存在或更新失败' }, { status: 404 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const cid = Number(id)
  if (!Number.isInteger(cid) || cid <= 0) return NextResponse.json({ error: '无效 ID' }, { status: 400 })
  try {
    const ch = await db.chapter.delete({ where: { id: cid } })
    const agg = await db.chapter.aggregate({ where: { novelId: ch.novelId }, _sum: { wordCount: true } })
    await db.novel.update({ where: { id: ch.novelId }, data: { wordCount: agg._sum.wordCount ?? 0 } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: '章节不存在' }, { status: 404 })
  }
}
