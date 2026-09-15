import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

function parseId(url: string): number | null {
  try {
    const u = new URL(url, 'http://x')
    const v = u.searchParams.get('novelId')
    const n = v ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const categoryId = sp.get('categoryId')
  const q = sp.get('q')?.trim()
  const status = sp.get('status')
  const sort = sp.get('sort') ?? 'latest'
  const page = Math.max(1, Number(sp.get('page')) || 1)
  const pageSize = Math.min(60, Math.max(4, Number(sp.get('pageSize')) || 20))

  const where: {
    categoryId?: number
    status?: string
    OR?: { title?: { contains: string }; author?: { contains: string }; description?: { contains: string } }[]
  } = {}
  if (categoryId && Number(categoryId) > 0) where.categoryId = Number(categoryId)
  if (status === 'serial' || status === 'finished') where.status = status
  if (q) {
    where.OR = [{ title: { contains: q } }, { author: { contains: q } }, { description: { contains: q } }]
  }

  const orderBy =
    sort === 'clicks' ? { clicks: 'desc' as const } :
    sort === 'words' ? { wordCount: 'desc' as const } :
    sort === 'featured' ? [{ isFeatured: 'desc' as const }, { updatedAt: 'desc' as const }] :
    { updatedAt: 'desc' as const }

  const [total, rows] = await Promise.all([
    db.novel.count({ where }),
    db.novel.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, title: true, author: true, description: true, cover: true, categoryId: true,
        category: { select: { name: true } }, status: true, isFeatured: true, isHot: true,
        wordCount: true, clicks: true, updatedAt: true,
        _count: { select: { chapters: true } },
        chapters: { orderBy: { idx: 'desc' }, take: 1, select: { title: true } },
      },
    }),
  ])

  return NextResponse.json({
    list: rows.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      description: r.description,
      cover: r.cover,
      categoryId: r.categoryId,
      categoryName: r.category?.name ?? '未分类',
      status: r.status === 'finished' ? 'finished' : 'serial',
      isFeatured: r.isFeatured,
      isHot: r.isHot,
      wordCount: r.wordCount,
      clicks: r.clicks,
      chapterCount: r._count.chapters,
      lastChapterTitle: r.chapters[0]?.title ?? null,
      updatedAt: r.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

// —— 管理端：新增小说（可附带初始章节）——
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    title?: string
    author?: string
    description?: string
    cover?: string
    categoryId?: number
    status?: string
    isFeatured?: boolean
    isHot?: boolean
  }
  if (!body.title?.trim()) return NextResponse.json({ error: '书名不能为空' }, { status: 400 })
  if (!body.categoryId || !Number.isFinite(body.categoryId)) return NextResponse.json({ error: '请选择分类' }, { status: 400 })
  const cat = await db.category.findUnique({ where: { id: body.categoryId } })
  if (!cat) return NextResponse.json({ error: '分类不存在' }, { status: 400 })

  const covers = ['g1','g2','g3','g4','g5','g6','g7','g8','g9','g10','g11','g12']
  const novel = await db.novel.create({
    data: {
      title: body.title.trim().slice(0, 100),
      author: (body.author?.trim() || '佚名').slice(0, 50),
      description: (body.description ?? '').slice(0, 2000),
      cover: covers.includes(body.cover ?? '') ? body.cover! : covers[Math.floor(Math.random() * covers.length)],
      categoryId: body.categoryId,
      status: body.status === 'finished' ? 'finished' : 'serial',
      isFeatured: !!body.isFeatured,
      isHot: !!body.isHot,
    },
  })
  return NextResponse.json({ id: novel.id }, { status: 201 })
}

export { parseId }
