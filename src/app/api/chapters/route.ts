import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// 管理端：新增章节
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { novelId?: number; title?: string; content?: string }
  if (!body.novelId || !Number.isFinite(body.novelId)) return NextResponse.json({ error: 'novelId 必填' }, { status: 400 })
  if (!body.title?.trim()) return NextResponse.json({ error: '章节标题不能为空' }, { status: 400 })

  const novel = await db.novel.findUnique({ where: { id: body.novelId } })
  if (!novel) return NextResponse.json({ error: '小说不存在' }, { status: 404 })

  const max = await db.chapter.aggregate({ where: { novelId: body.novelId }, _max: { idx: true } })
  const idx = (max._max.idx ?? 0) + 1
  const content = body.content ?? ''
  const chapter = await db.chapter.create({
    data: {
      novelId: body.novelId,
      idx,
      title: body.title.trim().slice(0, 120),
      content,
      wordCount: content.replace(/\s/g, '').length,
    },
  })
  // 同步小说字数与更新时间
  const agg = await db.chapter.aggregate({ where: { novelId: body.novelId }, _sum: { wordCount: true } })
  await db.novel.update({
    where: { id: body.novelId },
    data: { wordCount: agg._sum.wordCount ?? 0, updatedAt: new Date() },
  })
  return NextResponse.json({ id: chapter.id, idx: chapter.idx }, { status: 201 })
}
