import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { firstLine } from '@/lib/api-error'
import { cleanChapterContent } from '@/lib/content-clean'

export const dynamic = 'force-dynamic'

const BATCH_SIZE = 500

/**
 * 存量章节噪声清洗端点：
 * - POST：分批遍历全部章节，cleanChapterContent 后有变化才 update（content + wordCount 重算），
 *   并同步受影响书籍的字数合计；返回 { checked, cleaned, novels }
 * - GET ?dryRun=1：预览模式，只统计将被清洗的章节数，不写库；GET 恒不写库
 *
 * 防并发：POST 以 globalThis 标志互斥（进行中重复请求返回 409）；
 * id 游标分批（500/批）避免一次性载入全表。
 */

// 挂在 globalThis 上：dev HMR 重载模块实例时标志仍然共享，避免出现双跑
const g = globalThis as unknown as { __chapterCleanRunning?: boolean }

interface ScanResult {
  checked: number
  changed: number
  novels: number
}

/** 遍历全部章节做清洗比对；write=true 时落库（章节 content/wordCount + 书籍字数合计） */
async function scanChapters(write: boolean): Promise<ScanResult> {
  let cursor = 0
  let checked = 0
  let changed = 0
  const touchedNovels = new Set<number>()
  for (;;) {
    const batch = await db.chapter.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, novelId: true, content: true },
    })
    if (batch.length === 0) break
    for (const ch of batch) {
      cursor = ch.id
      checked++
      const res = cleanChapterContent(ch.content)
      if (res.text === ch.content) continue // 无变化不写库
      if (write) {
        // 更新失败（瞬时锁等）不计入 cleaned，避免虚报清洗数量；下轮 dryRun 可复查
        const ok = await db.chapter
          .update({
            where: { id: ch.id },
            data: { content: res.text, wordCount: res.text.replace(/\s/g, '').length },
          })
          .then(() => true)
          .catch(() => false)
        if (!ok) continue
      }
      changed++
      touchedNovels.add(ch.novelId)
    }
  }
  if (write && touchedNovels.size > 0) {
    // 章节 wordCount 变了，书籍级字数合计一并重算
    for (const novelId of touchedNovels) {
      const sum = await db.chapter
        .aggregate({ where: { novelId }, _sum: { wordCount: true } })
        .catch(() => null)
      if (sum) {
        await db.novel
          .update({ where: { id: novelId }, data: { wordCount: sum._sum.wordCount ?? 0 } })
          .catch(() => {})
      }
    }
  }
  return { checked, changed, novels: touchedNovels.size }
}

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  try {
    // GET 恒为只读预览：write=false，绝不写库
    const { checked, changed } = await scanChapters(false)
    return NextResponse.json({ checked, toClean: changed, dryRun })
  } catch (e) {
    return NextResponse.json(
      { error: '存量章节预览失败', detail: firstLine(e) },
      { status: 500 },
    )
  }
}

export async function POST() {
  if (g.__chapterCleanRunning) {
    return NextResponse.json({ error: '存量清洗正在进行中，请稍后再试' }, { status: 409 })
  }
  // 运行中/待执行任务防护：存量清洗是全表分批写（章节 content/wordCount + 书籍字数合计），
  // 与采集 worker 的章节骨架/回填写入并行会争抢 SQLite 写锁并互相拖慢，还可能把
  // 采集刚回填的正文再清洗一遍导致字数统计竞态 —— 存在 pending/running 任务时拒绝执行
  const activeTask = await db.scrapeTask
    .findFirst({ where: { status: { in: ['pending', 'running'] } }, select: { id: true } })
    .catch(() => null)
  if (activeTask) {
    return NextResponse.json(
      { error: `存在进行中的采集任务（#${activeTask.id}），请先取消任务再执行存量清洗` },
      { status: 409 },
    )
  }
  g.__chapterCleanRunning = true
  try {
    const { checked, changed, novels } = await scanChapters(true)
    return NextResponse.json({ checked, cleaned: changed, novels })
  } catch (e) {
    return NextResponse.json(
      { error: '存量章节清洗失败', detail: firstLine(e) },
      { status: 500 },
    )
  } finally {
    g.__chapterCleanRunning = false
  }
}
