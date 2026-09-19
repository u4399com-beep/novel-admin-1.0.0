import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseChapterNo, reorderChapterRefs } from '@/lib/scrape/ordering'

export const dynamic = 'force-dynamic'

/**
 * 全站目录重排（存量修复）：
 * - GET：只读审计——逐书解析章节标题序号，检测阅读顺序是否乱序（分卷感知），
 *   返回将触发重排的书清单（不写库）；
 * - POST：按审计结果重排——以章节序号为主键重新编 idx（未编号章节锚定在前一编号章节之后，
 *   分卷信息随章节移动），两阶段事务改号避免 @@unique([novelId, idx]) 冲突。
 *
 * 背景：分卷/乱序重排能力上线前的存量采集按抓取顺序编 idx，源站「最新章节块 + 正文块」
 * 或整本倒序的站点会留下阅读顺序错乱的书；本端点提供一键修复入口，
 * 管理后台「目录重排」按钮调用。重排只改 idx 不动内容，重排后触碰 updatedAt。
 */

interface Candidate {
  id: number
  title: string
  chapters: number
  numbered: number
  /** 位置错乱占比（0-1） */
  disorder: number
}

/** 单本书的重排检测：返回新顺序（null=无需重排）与审计指标 */
function detectOrder(
  chapters: { id: number; idx: number; title: string; volume: string }[],
): { order: number[] | null; numbered: number; disorder: number } {
  const refs = chapters.map((c) => ({ title: c.title, url: String(c.id), volume: c.volume || undefined }))
  const numbered = refs.filter((r) => parseChapterNo(r.title) != null).length
  // 与 reorderChapterRefs 同一套阈值/算法：直接复用其判定（url 复用为章节 id 载体）
  const rr = reorderChapterRefs(refs)
  const order = rr.reordered ? rr.refs.map((r) => Number(r.url)) : null
  // 位置错乱占比：仅统计有编号章节的错位情况（展示用）
  const nums = chapters.map((c) => parseChapterNo(c.title))
  const vals = nums.filter((n): n is number => n != null)
  let disorder = 0
  if (vals.length >= 8) {
    const sorted = [...vals].sort((a, b) => a - b)
    let mismatch = 0
    for (let i = 0; i < vals.length; i++) if (vals[i] !== sorted[i]) mismatch++
    disorder = mismatch / vals.length
  }
  return { order, numbered, disorder }
}

async function audit(): Promise<{ books: number; candidates: Candidate[] }> {
  const novels = await db.novel.findMany({ select: { id: true, title: true } })
  const candidates: Candidate[] = []
  for (const n of novels) {
    const chapters = await db.chapter.findMany({
      where: { novelId: n.id },
      orderBy: { idx: 'asc' },
      select: { id: true, idx: true, title: true, volume: true },
    })
    if (chapters.length < 8) continue
    const { order, numbered, disorder } = detectOrder(chapters)
    if (order) {
      candidates.push({ id: n.id, title: n.title, chapters: chapters.length, numbered, disorder })
    }
  }
  return { books: novels.length, candidates }
}

/** 两阶段事务改号：先整体移入负数区（互不冲突），再按新顺序写回正数 idx */
async function applyReorder(novelId: number, order: number[]): Promise<number> {
  await db.$transaction(async (tx) => {
    for (let i = 0; i < order.length; i++) {
      await tx.chapter.update({ where: { id: order[i] }, data: { idx: -(i + 1) - 1_000_000 } })
    }
    for (let i = 0; i < order.length; i++) {
      await tx.chapter.update({ where: { id: order[i] }, data: { idx: i + 1 } })
    }
  })
  await db.novel.update({ where: { id: novelId }, data: { updatedAt: new Date() } }).catch(() => undefined)
  return order.length
}

/** Prisma 错误消息首行（不含内部路径） */
function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200)
}

export async function GET() {
  try {
    const result = await audit()
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: '目录重排审计失败', detail: firstLine(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    let novelId: number | null = null
    try {
      const body = (await req.json()) as { novelId?: unknown }
      if (typeof body?.novelId === 'number' && Number.isInteger(body.novelId) && body.novelId > 0) {
        novelId = body.novelId
      }
    } catch {
      /* 空 body = 全站 */
    }
    const { candidates } = await audit()
    const targets = novelId ? candidates.filter((c) => c.id === novelId) : candidates
    const results: { id: number; title: string; moved: number }[] = []
    for (const c of targets) {
      const chapters = await db.chapter.findMany({
        where: { novelId: c.id },
        orderBy: { idx: 'asc' },
        select: { id: true, idx: true, title: true, volume: true },
      })
      const { order } = detectOrder(chapters)
      if (!order) continue
      const moved = await applyReorder(c.id, order)
      results.push({ id: c.id, title: c.title, moved })
    }
    return NextResponse.json({ scanned: candidates.length, reordered: results.length, results })
  } catch (e) {
    return NextResponse.json({ error: '目录重排失败', detail: firstLine(e) }, { status: 500 })
  }
}
