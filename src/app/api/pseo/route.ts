import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sanitizeKeyword } from '@/lib/suggest'
import { insertKeywords } from '@/lib/pseo'

export const dynamic = 'force-dynamic'

// PSEO 关键词列表（管理端）
export async function GET() {
  const rows = await db.pseoKeyword.findMany({ orderBy: { updatedAt: 'desc' }, take: 200 })
  // 绑定书标题批量查一次（in 查询 + Map 回填，避免逐行 N+1）
  const novelIds = [...new Set(rows.map((r) => r.novelId).filter((id): id is number => id != null))]
  const novels = novelIds.length
    ? await db.novel.findMany({ where: { id: { in: novelIds } }, select: { id: true, title: true } })
    : []
  const titleOf = new Map(novels.map((n) => [n.id, n.title]))
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      keyword: r.keyword,
      source: r.source,
      status: r.status,
      // 绑定书（采集自动取词时写入；书已删除则 title 回退 null，前端显示 #id）
      novelId: r.novelId,
      novelTitle: r.novelId != null ? (titleOf.get(r.novelId) ?? null) : null,
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

  // 复用 insertKeywords：批内去重 + 存在跳过 + P2002 竞态容错（原逐条 create 无容错，并发下撞唯一约束 → 500）
  const added = await insertKeywords(cleaned.map((kw) => ({ word: kw, engine: 'manual' })), 500)
  return NextResponse.json({ added })
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: '无效 id' }, { status: 400 })
  await db.pseoKeyword.delete({ where: { id } }).catch(() => {})
  return NextResponse.json({ ok: true })
}
