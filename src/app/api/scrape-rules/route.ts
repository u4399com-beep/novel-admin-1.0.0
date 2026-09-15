import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET 采集规则列表
export async function GET() {
  const rows = await db.scrapeRule.findMany({ orderBy: { id: 'asc' } })
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      siteUrl: r.siteUrl,
      enabled: r.enabled,
      charset: r.charset,
      listRule: JSON.parse(r.listRule || '{}'),
      bookRule: JSON.parse(r.bookRule || '{}'),
      chapterRule: JSON.parse(r.chapterRule || '{}'),
      notes: r.notes,
    }))
  )
}

// 新建/更新采集规则
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    id?: number
    name?: string
    siteUrl?: string
    enabled?: boolean
    charset?: string
    listRule?: Record<string, string>
    bookRule?: Record<string, string>
    chapterRule?: Record<string, string>
    notes?: string
  }
  if (!body.name?.trim() || !body.siteUrl?.trim()) {
    return NextResponse.json({ error: 'name 与 siteUrl 必填' }, { status: 400 })
  }
  const data = {
    name: body.name.trim().slice(0, 80),
    siteUrl: body.siteUrl.trim().slice(0, 200),
    enabled: body.enabled ?? true,
    charset: (body.charset || 'utf-8').toLowerCase(),
    listRule: JSON.stringify(body.listRule ?? {}),
    bookRule: JSON.stringify(body.bookRule ?? {}),
    chapterRule: JSON.stringify(body.chapterRule ?? {}),
    notes: (body.notes ?? '').slice(0, 1000),
  }
  if (body.id) {
    const updated = await db.scrapeRule.update({ where: { id: body.id }, data })
    return NextResponse.json({ id: updated.id })
  }
  const created = await db.scrapeRule.create({ data })
  return NextResponse.json({ id: created.id }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get('id'))
  if (!Number.isFinite(id)) return NextResponse.json({ error: '无效 id' }, { status: 400 })
  await db.scrapeRule.delete({ where: { id } }).catch(() => {})
  return NextResponse.json({ ok: true })
}

// —— 内置规则种子：基于站点分析产出的 CMS 家族通用选择器（可编辑） ——
const SEED_RULES = [
  {
    name: '笔趣阁系通用模板',
    siteUrl: 'https://www.23qb.net/',
    charset: 'utf-8',
    listRule: { itemSelector: '#hotcontent li, #newscontent li', titleSelector: '.s2 a', authorSelector: '.s5' },
    bookRule: { titleSelector: '#info h1', authorSelector: '#info p:first-of-type a', descriptionSelector: '#intro', chapterLinkSelector: '#list dl dd a' },
    chapterRule: { titleSelector: '.bookname h1', contentSelector: '#content', nextSelector: '#link_next' },
    notes: '杰奇/笔趣阁系结构：列表 li 分列，正文 #content。',
  },
  {
    name: '顶点系通用模板',
    siteUrl: 'https://www.ddyueshu.cc/',
    charset: 'gbk',
    listRule: { itemSelector: '#main .novellist li', titleSelector: 'a', authorSelector: '' },
    bookRule: { titleSelector: '#title h1', authorSelector: '#title span', descriptionSelector: '#intro', chapterLinkSelector: '.chapterlist a' },
    chapterRule: { titleSelector: 'h1', contentSelector: '#content', nextSelector: '#link_next' },
    notes: 'GBK 编码站代表，需 charset=gbk。',
  },
  {
    name: 'ShipSay CMS 模板',
    siteUrl: 'http://demo.shipsay.com/',
    charset: 'utf-8',
    listRule: { itemSelector: '.book-list .book', titleSelector: '.title a', authorSelector: '.author' },
    bookRule: { titleSelector: 'h1.book-title', authorSelector: '.book-author', descriptionSelector: '.book-intro', chapterLinkSelector: '.chapter-list a' },
    chapterRule: { titleSelector: 'h1.chapter-title', contentSelector: '.chapter-content', nextSelector: 'a.next-chapter' },
    notes: 'ShipSay 演示模板，类名结构化清晰。',
  },
  {
    name: '爱尚系现代模板',
    siteUrl: 'https://www.aijjxs.com/',
    charset: 'utf-8',
    listRule: { itemSelector: '.book-item, .rank-item', titleSelector: '.book-title a', authorSelector: '.book-author' },
    bookRule: { titleSelector: 'h1.novel-title', authorSelector: '.author-name', descriptionSelector: '.novel-desc', chapterLinkSelector: '.chapter-grid a' },
    chapterRule: { titleSelector: 'h1.chapter-heading', contentSelector: '.chapter-body', nextSelector: 'a[rel="next"]' },
    notes: '现代卡片式布局站点。',
  },
]

// POST /api/scrape-rules?seed=1 或 body.seed === true
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { seed?: boolean }
  if (!body.seed) return NextResponse.json({ error: '仅支持 seed 操作' }, { status: 400 })
  let added = 0
  for (const r of SEED_RULES) {
    const exists = await db.scrapeRule.findUnique({ where: { name: r.name } })
    if (exists) continue
    await db.scrapeRule.create({ data: { ...r, listRule: JSON.stringify(r.listRule), bookRule: JSON.stringify(r.bookRule), chapterRule: JSON.stringify(r.chapterRule) } })
    added++
  }
  return NextResponse.json({ added })
}
