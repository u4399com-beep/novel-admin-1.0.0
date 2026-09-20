import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const nid = Number(id)
  if (!Number.isInteger(nid)) return NextResponse.json({ error: '无效 ID' }, { status: 400 })

  // 只取首 12 章与末 1 章（旧实现 findMany 全量章节只为取首/尾，千章书每次浏览多拉上千行）
  const novel = await db.novel.findUnique({
    where: { id: nid },
    include: {
      category: { select: { name: true } },
      _count: { select: { chapters: true } },
      chapters: { orderBy: { idx: 'asc' }, take: 12, select: { id: true, idx: true, title: true, wordCount: true } },
    },
  })
  if (!novel) return NextResponse.json({ error: '小说不存在' }, { status: 404 })

  const [lastChapter] = await Promise.all([
    db.chapter.findFirst({
      where: { novelId: nid },
      orderBy: { idx: 'desc' },
      select: { id: true, title: true },
    }),
    // 浏览计数（fire-and-forget）
    db.novel.update({ where: { id: nid }, data: { clicks: { increment: 1 } } }).catch(() => undefined),
  ])

  const first = novel.chapters[0]

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
    lastChapterTitle: lastChapter?.title ?? null,
    updatedAt: novel.updatedAt.toISOString(),
    totalChapters: novel._count.chapters,
    firstChapterId: first?.id ?? null,
    lastChapterId: lastChapter?.id ?? null,
    chapters: novel.chapters,
  })
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const nid = Number(id)
  if (!Number.isInteger(nid) || nid <= 0) return NextResponse.json({ error: '无效 ID' }, { status: 400 })
  let body: {
    title?: string; author?: string; description?: string; cover?: string
    categoryId?: number; status?: string; isFeatured?: boolean; isHot?: boolean
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const data: Record<string, unknown> = {}
  // 截断上限与采集入库路径（lib/scrape/store.ts upsertBook）对齐：title 200 / author 100 / description 2000
  if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 200)
  if (typeof body.author === 'string' && body.author.trim()) data.author = body.author.trim().slice(0, 100)
  if (typeof body.description === 'string') data.description = body.description.slice(0, 2000)
  if (typeof body.cover === 'string' && /^g\d+$/.test(body.cover)) data.cover = body.cover
  if (typeof body.categoryId === 'number' && Number.isInteger(body.categoryId) && body.categoryId > 0) data.categoryId = body.categoryId
  if (body.status === 'serial' || body.status === 'finished') data.status = body.status
  if (typeof body.isFeatured === 'boolean') data.isFeatured = body.isFeatured
  if (typeof body.isHot === 'boolean') data.isHot = body.isHot

  try {
    await db.novel.update({ where: { id: nid }, data })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // P2025 = 目标书不存在 → 404（与 GET/DELETE 语义对齐）；其余（如分类外键不存在）→ 400
    if ((e as { code?: string })?.code === 'P2025') {
      return NextResponse.json({ error: '小说不存在' }, { status: 404 })
    }
    return NextResponse.json({ error: '更新失败（分类不存在？）' }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const nid = Number(id)
  if (!Number.isInteger(nid) || nid <= 0) return NextResponse.json({ error: '无效 ID' }, { status: 400 })
  try {
    await db.novel.delete({ where: { id: nid } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: '小说不存在或删除失败' }, { status: 404 })
  }
}
