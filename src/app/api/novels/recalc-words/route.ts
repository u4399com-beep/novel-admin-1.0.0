import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * 全站字数审计与重算：
 * - GET：只读审计——比对每本书的 Novel.wordCount 与章节聚合合计，返回不符清单与全站总量；
 * - POST：全站重算——仅对不符的书执行 update（避免无谓写放大），返回修正数量。
 *
 * 背景（实测缺陷）：此前书籍字数仅在整本书采集结束时全量重算，采集过程中断/
 * 取消/历史批量路径可能留下 wordCount 与章节实际合计不符的书（如采集中途
 * wordCount 长时间为 0 或旧值）；本端点提供一键校准入口，管理后台「字数审计」按钮调用。
 */

interface Mismatch {
  id: number
  title: string
  stored: number
  actual: number
}

/** 审计：返回全部书籍的 stored/actual 比对结果（一次 groupBy 聚合，无 N+1） */
async function auditWordCounts(): Promise<{
  books: number
  mismatches: Mismatch[]
  totalStored: number
  totalActual: number
}> {
  const novels = await db.novel.findMany({ select: { id: true, title: true, wordCount: true } })
  const agg = await db.chapter.groupBy({ by: ['novelId'], _sum: { wordCount: true } })
  const sumMap = new Map(agg.map((g) => [g.novelId, g._sum.wordCount ?? 0]))
  const mismatches: Mismatch[] = []
  let totalStored = 0
  let totalActual = 0
  for (const n of novels) {
    const actual = sumMap.get(n.id) ?? 0
    totalStored += n.wordCount
    totalActual += actual
    if (actual !== n.wordCount) {
      mismatches.push({ id: n.id, title: n.title, stored: n.wordCount, actual })
    }
  }
  return { books: novels.length, mismatches, totalStored, totalActual }
}

/** Prisma 错误消息首行（不含内部路径） */
function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200)
}

export async function GET() {
  try {
    const result = await auditWordCounts()
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: '字数审计失败', detail: firstLine(e) }, { status: 500 })
  }
}

export async function POST() {
  try {
    const { books, mismatches } = await auditWordCounts()
    let fixed = 0
    for (const m of mismatches) {
      const ok = await db.novel
        .update({ where: { id: m.id }, data: { wordCount: m.actual } })
        .then(() => true)
        .catch(() => false)
      if (ok) fixed++
    }
    return NextResponse.json({ books, mismatched: mismatches.length, fixed })
  } catch (e) {
    return NextResponse.json({ error: '字数重算失败', detail: firstLine(e) }, { status: 500 })
  }
}
