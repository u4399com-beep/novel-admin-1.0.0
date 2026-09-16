import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const nid = Number(id)
  if (!Number.isFinite(nid)) return NextResponse.json({ error: '无效 ID' }, { status: 400 })

  const novel = await db.novel.findUnique({
    where: { id: nid },
    include: {
      category: { select: { name: true } },
      _count: { select: { chapters: true } },
      chapters: { orderBy: { idx: 'asc' }, select: { id: true, idx: true, title: true, wordCount: true } },
    },
  })
  if (!novel) return NextResponse.json({ error: '小说不存在' }, { status: 404 })

  // 浏览计数（fire-and-forget）
  db.novel.update({ where: { id: nid }, data: { clicks: { increment: 1 } } }).catch(() => {})

  const first = novel.chapters[0]
  const last = novel.chapters[novel.chapters.length - 1]

  return NextResponse.json({
    id: novel.id,
    title: novel.title,
    author: novel.author,
    description: novel.description,
    cover: novel.cover,
    categoryId: novel.categoryId,
    categoryName: novel.category?.name ?? '未分类',
    status: novel.status === 'finished' ? 'finished' : 'serial',
    isFeatured: novel.isFeatured,
    isHot: novel.isHot,
    wordCount: novel.wordCount,
    clicks: novel.clicks,
    chapterCount: novel._count.chapters,
    lastChapterTitle: last?.title ?? null,
    updatedAt: novel.updatedAt.toISOString(),
    totalChapters: novel.chapters.length,
    firstChapterId: first?.id ?? null,
    lastChapterId: last?.id ?? null,
    chapters: novel.chapters.slice(0, 12),
  })
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const body = (await req.json()) as {
    title?: string; author?: string; description?: string; cover?: string
    categoryId?: number; status?: string; isFeatured?: boolean; isHot?: boolean
  }
  const data: Record<string, unknown> = {}
  if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 100)
  if (typeof body.author === 'string' && body.author.trim()) data.author = body.author.trim().slice(0, 50)
  if (typeof body.description === 'string') data.description = body.description.slice(0, 2000)
  if (typeof body.cover === 'string' && /^g\d+$/.test(body.cover)) data.cover = body.cover
  if (typeof body.categoryId === 'number') data.categoryId = body.categoryId
  if (body.status === 'serial' || body.status === 'finished') data.status = body.status
  if (typeof body.isFeatured === 'boolean') data.isFeatured = body.isFeatured
  if (typeof body.isHot === 'boolean') data.isHot = body.isHot

  try {
    await db.novel.update({ where: { id: Number(id) }, data })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: '更新失败（分类不存在？）' }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const nid = Number(id)
  if (!Number.isFinite(nid) || nid <= 0) return NextResponse.json({ error: '无效 ID' }, { status: 400 })
  try {
    await db.novel.delete({ where: { id: nid } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: '小说不存在或删除失败' }, { status: 404 })
  }
}
