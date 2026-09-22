import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { NOVEL_AUTHOR_MAX, NOVEL_DESCRIPTION_MAX, NOVEL_TITLE_MAX } from '@/lib/limits'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const categoryId = sp.get('categoryId')
  const q = sp.get('q')?.trim().slice(0, 100)
  const status = sp.get('status')
  const sort = sp.get('sort') ?? 'latest'
  const page = Math.max(1, Math.floor(Number(sp.get('page')) || 1))
  // 上限 500：列表页「去分页」一次拉全（历史 60 上限与分页 UI 绑定，已移除）
  const pageSize = Math.min(500, Math.max(4, Math.floor(Number(sp.get('pageSize')) || 20)))

  // 非法 categoryId（abc/1.5/-3）明确 400，而不是静默降级为全库查询（旧行为会把分类页渲染成全站书单）
  const categoryIdNum = categoryId === null || categoryId === '' ? 0 : Number(categoryId)
  if (Number.isNaN(categoryIdNum) || !Number.isInteger(categoryIdNum) || categoryIdNum < 0) {
    return NextResponse.json({ error: '无效 categoryId' }, { status: 400 })
  }

  const where: {
    categoryId?: number
    status?: string
    OR?: { title?: { contains: string }; author?: { contains: string }; description?: { contains: string } }[]
  } = {}
  if (categoryIdNum > 0) where.categoryId = categoryIdNum
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
  let body: {
    title?: string
    author?: string
    description?: string
    cover?: string
    categoryId?: number
    status?: string
    isFeatured?: boolean
    isHot?: boolean
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  if (!body.title?.trim()) return NextResponse.json({ error: '书名不能为空' }, { status: 400 })
  if (!body.categoryId || !Number.isInteger(body.categoryId)) return NextResponse.json({ error: '请选择分类' }, { status: 400 })
  const cat = await db.category.findUnique({ where: { id: body.categoryId } })
  if (!cat) return NextResponse.json({ error: '分类不存在' }, { status: 400 })

  const covers = ['g1','g2','g3','g4','g5','g6','g7','g8','g9','g10','g11','g12']
  try {
    const novel = await db.novel.create({
      data: {
        title: body.title.trim().slice(0, NOVEL_TITLE_MAX),
        author: (body.author?.trim() || '佚名').slice(0, NOVEL_AUTHOR_MAX),
        description: (body.description ?? '').slice(0, NOVEL_DESCRIPTION_MAX),
        cover: covers.includes(body.cover ?? '') ? body.cover! : covers[Math.floor(Math.random() * covers.length)],
        categoryId: body.categoryId,
        status: body.status === 'finished' ? 'finished' : 'serial',
        isFeatured: !!body.isFeatured,
        isHot: !!body.isHot,
      },
    })
    return NextResponse.json({ id: novel.id }, { status: 201 })
  } catch (e) {
    // DB 层 @@unique([title, author])（防并发采集重复入库）被撞 → 409 而非 500
    if ((e as { code?: string })?.code === 'P2002') {
      return NextResponse.json({ error: '同名同作者的书已存在' }, { status: 409 })
    }
    throw e
  }
}
