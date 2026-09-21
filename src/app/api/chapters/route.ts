import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

// 管理端：新增章节
export async function POST(req: NextRequest) {
  let body: { novelId?: number; title?: string; content?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  if (!body.novelId || !Number.isInteger(body.novelId)) return NextResponse.json({ error: 'novelId 必填' }, { status: 400 })
  if (!body.title?.trim()) return NextResponse.json({ error: '章节标题不能为空' }, { status: 400 })

  const novel = await db.novel.findUnique({ where: { id: body.novelId } })
  if (!novel) return NextResponse.json({ error: '小说不存在' }, { status: 404 })

  const novelId = body.novelId
  const chTitle = body.title.trim().slice(0, 120)
  const max = await db.chapter.aggregate({ where: { novelId }, _max: { idx: true } })
  let idx = (max._max.idx ?? 0) + 1
  // 非字符串 content（数字/对象等）按空正文处理（与 PUT 语义一致），否则 content.replace 抛 TypeError → 500
  const content = typeof body.content === 'string' ? body.content : ''
  const createChapter = (idxVal: number) =>
    db.chapter.create({
      data: {
        novelId,
        idx: idxVal,
        title: chTitle,
        content,
        wordCount: content.replace(/\s/g, '').length,
      },
    })

  // 并发竞态兜底：两个请求同时算出同一最大 idx 时，后写者撞 [novelId, idx] 唯一约束（P2002）；
  // 捕获后读回当前该书最大 idx 重试一次（idx+1），再失败则抛出（500）
  let chapter
  try {
    chapter = await createChapter(idx)
  } catch (e) {
    if ((e as { code?: string })?.code !== 'P2002') throw e
    const retry = await db.chapter.aggregate({ where: { novelId }, _max: { idx: true } })
    idx = (retry._max.idx ?? 0) + 1
    chapter = await createChapter(idx)
  }
  // 同步小说字数与更新时间
  const agg = await db.chapter.aggregate({ where: { novelId }, _sum: { wordCount: true } })
  await db.novel.update({
    where: { id: novelId },
    data: { wordCount: agg._sum.wordCount ?? 0, updatedAt: new Date() },
  })
  return NextResponse.json({ id: chapter.id, idx: chapter.idx }, { status: 201 })
}
