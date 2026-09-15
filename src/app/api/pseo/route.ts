import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// PSEO 关键词列表（管理端）
export async function GET() {
  const rows = await db.pseoKeyword.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 })
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      keyword: r.keyword,
      source: r.source,
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
    }))
  )
}

// 手工添加关键词
export async function POST(req: NextRequest) {
  const { keywords } = (await req.json()) as { keywords?: string[] }
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return NextResponse.json({ error: 'keywords 不能为空' }, { status: 400 })
  }
  const cleaned = keywords.map((k) => k.trim().slice(0, 60)).filter(Boolean).slice(0, 500)
  let added = 0
  for (const kw of cleaned) {
    const exists = await db.pseoKeyword.findUnique({ where: { keyword: kw } })
    if (exists) continue
    await db.pseoKeyword.create({ data: { keyword: kw, source: 'manual' } })
    added++
  }
  return NextResponse.json({ added })
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get('id'))
  if (!Number.isFinite(id)) return NextResponse.json({ error: '无效 id' }, { status: 400 })
  await db.pseoKeyword.delete({ where: { id } }).catch(() => {})
  return NextResponse.json({ ok: true })
}
