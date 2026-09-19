import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cleanChapterContent } from '@/lib/content-clean'
import { cleanTextField, cleanDescriptionField } from '@/lib/text-clean'
import { isUniqueConflict } from '@/lib/scrape/store'

export const dynamic = 'force-dynamic'

const BATCH_SIZE = 500

/**
 * 存量数据噪声清洗端点（章节正文 + 全字段）：
 * - POST：分批遍历全部章节（正文 + 标题）与全部书籍（书名/作者/简介），
 *   清洗后有变化才 update；正文变化重算字数并同步书籍字数合计；返回汇总。
 * - GET ?dryRun=1：预览模式，只统计将被清洗的记录数，不写库；GET 恒不写库。
 *
 * 清洗范围（与采集链路同规约）：
 * - 章节正文：cleanChapterContent（行级噪声 + 实体净化输出）
 * - 章节标题：cleanTextField（实体解码/残缺标签/空白折叠）
 * - 书籍字段：书名/作者 cleanTextField；简介 cleanDescriptionField
 *   （实体解码 + 字面 \n 还原 + 样板尾段剥除 + SEO 伪简介置空）
 *
 * 书名/作者清洗撞 @@unique([title,author]) 时逐级降级（去 title → 去 author → 仅简介），
 * 保证历史重复书不会被清洗合并破坏。
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

interface FieldScanResult {
  checked: number
  changed: number
  /** 撞唯一约束被降级跳过的变更字段数 */
  skipped: number
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

/**
 * 书名/作者变更撞 @@unique([title,author]) 时逐级降级重试：
 * 全量 → 去 title → 去 author；非唯一约束错误直接失败。
 * 返回 null 表示所有降级组合都撞约束（调用方计入 skipped）。
 */
async function updateNovelSafe(
  id: number,
  data: { title?: string; author?: string; description?: string },
): Promise<boolean | null> {
  const attempts: Record<string, string>[] = []
  if (data.title !== undefined || data.author !== undefined) {
    attempts.push(data)
    if (data.title !== undefined && (data.author !== undefined || data.description !== undefined)) {
      const { title: _t, ...rest } = data
      if (Object.keys(rest).length > 0) attempts.push(rest)
    }
    const base = attempts[attempts.length - 1]
    if (base.author !== undefined && Object.keys(base).length > 1) {
      const { author: _a, ...rest } = base
      if (Object.keys(rest).length > 0) attempts.push(rest)
    }
  } else if (data.description !== undefined) {
    attempts.push({ description: data.description })
  }
  if (attempts.length === 0) return false
  for (const d of attempts) {
    const ok = await db.novel
      .update({ where: { id }, data: d })
      .then(() => true as const)
      .catch((e: unknown) => (isUniqueConflict(e) ? null : false))
    if (ok !== null) return ok
  }
  return null
}

/** 遍历全部书籍做字段清洗比对（title/author/description）；write=true 时落库 */
async function scanNovelFields(write: boolean): Promise<FieldScanResult> {
  let cursor = 0
  let checked = 0
  let changed = 0
  let skipped = 0
  for (;;) {
    const batch = await db.novel.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, title: true, author: true, description: true },
    })
    if (batch.length === 0) break
    for (const n of batch) {
      cursor = n.id
      checked++
      const title = cleanTextField(n.title)
      const author = cleanTextField(n.author)
      const description = cleanDescriptionField(n.description)
      if (title === n.title && author === n.author && description === n.description) continue
      const data: { title?: string; author?: string; description?: string } = {}
      if (title !== n.title && title) data.title = title
      if (author !== n.author && author) data.author = author
      if (description !== n.description) data.description = description
      if (Object.keys(data).length === 0) continue
      if (!write) {
        changed++
        continue
      }
      const ok = await updateNovelSafe(n.id, data)
      if (ok === true) changed++
      else if (ok === null) skipped++
    }
  }
  return { checked, changed, skipped }
}

/** 遍历全部章节做标题清洗比对；write=true 时落库 */
async function scanChapterTitles(write: boolean): Promise<FieldScanResult> {
  let cursor = 0
  let checked = 0
  let changed = 0
  let skipped = 0
  for (;;) {
    const batch = await db.chapter.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, title: true },
    })
    if (batch.length === 0) break
    for (const ch of batch) {
      cursor = ch.id
      checked++
      const title = cleanTextField(ch.title)
      if (!title || title === ch.title) continue
      if (write) {
        const ok = await db.chapter
          .update({ where: { id: ch.id }, data: { title } })
          .then(() => true)
          .catch(() => false)
        if (!ok) continue
      }
      changed++
    }
  }
  return { checked, changed, skipped }
}

/** Prisma 错误消息首行（首行不含调用点源码路径，避免把服务器内部路径泄露给客户端） */
function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200)
}

export async function GET(req: NextRequest) {
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  try {
    // GET 恒为只读预览：write=false，绝不写库（串行执行，共享 SQLite 写锁避免瞬时 BUSY）
    const chapters = await scanChapters(false)
    const novelFields = await scanNovelFields(false)
    const chapterTitles = await scanChapterTitles(false)
    return NextResponse.json({
      checked: chapters.checked,
      toClean: chapters.changed,
      booksChecked: novelFields.checked,
      booksToFix: novelFields.changed,
      chapterTitlesChecked: chapterTitles.checked,
      chapterTitlesToFix: chapterTitles.changed,
      dryRun,
    })
  } catch (e) {
    return NextResponse.json({ error: '存量数据预览失败', detail: firstLine(e) }, { status: 500 })
  }
}

export async function POST() {
  if (g.__chapterCleanRunning) {
    return NextResponse.json({ error: '存量清洗正在进行中，请稍后再试' }, { status: 409 })
  }
  g.__chapterCleanRunning = true
  try {
    // 串行执行：三个扫描都写 SQLite，并发会引发写锁 BUSY 竞争丢更新
    const chapters = await scanChapters(true)
    const novelFields = await scanNovelFields(true)
    const chapterTitles = await scanChapterTitles(true)
    return NextResponse.json({
      checked: chapters.checked,
      cleaned: chapters.changed,
      novels: chapters.novels,
      booksChecked: novelFields.checked,
      booksFixed: novelFields.changed,
      booksSkipped: novelFields.skipped,
      chapterTitlesChecked: chapterTitles.checked,
      chapterTitlesFixed: chapterTitles.changed,
    })
  } catch (e) {
    return NextResponse.json({ error: '存量数据清洗失败', detail: firstLine(e) }, { status: 500 })
  } finally {
    g.__chapterCleanRunning = false
  }
}
