import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sanitizeKeyword } from '@/lib/suggest'

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

// 手工添加关键词（输入校验：字符白名单 + 长度/数量限制）
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { keywords?: unknown } | null
  const rawKeywords = Array.isArray(body?.keywords) ? (body!.keywords as unknown[]) : null
  if (!rawKeywords || rawKeywords.length === 0) {
    return NextResponse.json({ error: 'keywords 不能为空' }, { status: 400 })
  }
  if (rawKeywords.length > 500) {
    return NextResponse.json({ error: 'keywords 数量超过上限（≤500）' }, { status: 400 })
  }
  // 清洗 + 批内去重
  const cleaned = [...new Set(rawKeywords.map((k) => sanitizeKeyword(k)).filter(Boolean))]
  if (cleaned.length === 0) {
    return NextResponse.json(
      { error: '清洗后无有效关键词', detail: '关键词须为 1-60 个可见字符，不允许控制字符与 <>{}[]$%|\\/"\'`^*#&~;= 等' },
      { status: 400 },
    )
  }

  const existing = await db.pseoKeyword.findMany({ where: { keyword: { in: cleaned } }, select: { keyword: true } })
  const existingSet = new Set(existing.map((r) => r.keyword))
  let added = 0
  for (const kw of cleaned) {
    if (existingSet.has(kw)) continue
    await db.pseoKeyword.create({ data: { keyword: kw, source: 'manual' } })
    added++
  }
  return NextResponse.json({ added })
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: '无效 id' }, { status: 400 })
  await db.pseoKeyword.delete({ where: { id } }).catch(() => {})
  return NextResponse.json({ ok: true })
}
