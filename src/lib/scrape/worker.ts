/**
 * 采集任务 Worker（服务端专用，勿在客户端 import）
 *
 * - 模块级 running Set 防止同一任务并发重复执行
 * - single 模式：书页 URL → 提取书籍信息 + 章节链接 → upsert 书籍 → 逐章抓取入库
 * - list 模式：列表页 URL → 提取书籍条目（支持 ?page=k / /page/k 翻页变体）→ 逐本按 single 流程入库
 * - 进度语义：single 模式 done/total=章节（唯一一本书的章节进度）；list 模式 done/total=书
 *   （主口径，done=已完成书数），章节进度单独记录在 chaptersDone/chaptersTotal，
 *   保证任何时刻 done ≤ total
 * - 协作式取消：每个关键步骤前读一次 DB status，canceled 即停（PATCH cancel 置状态）
 * - 任何异常都不外抛到进程级；最终状态 success / partial / failed / canceled
 * - 正文入库前经 cleanChapterContent 统一清洗（去 \r\n/行首缩进/空行/广告导航噪声行），
 *   wordCount 基于清洗后文本；清洗日志每本书最多记 3 条防刷屏
 * - 可观测性：每本书的书页抓取成功后记录一次「书页命中策略 X（尝试 N 次）」
 *
 * 合规红线：仅抓取公开页面；robots 提示与域名限速由 scraper-service 引擎层负责；
 * 单本章节上限 100、单任务书籍上限 60、正文 5 万字截断，防止滥用。
 */
import { db } from '@/lib/db'
import { cleanChapterContent } from '@/lib/content-clean'
import { fetchBookPage, fetchCatalogChapters, fetchChapter, fetchListPage } from './engine-client'
import { Run } from './run-log'
import { ensureCategory, loadRule, recalcNovelWordCount, storeChapter, upsertBook } from './store'
import type { BookOutcome, LoadedRule, ListItem, TaskFlushFields, TaskRecord } from './types'

const MAX_CHAPTERS_PER_BOOK = 100
const MAX_BOOKS_PER_TASK = 60
const MAX_CONTENT_CHARS = 50_000

/** 模块级防并发：同一任务 id 同时只允许一个 worker 实例 */
const running = new Set<number>()

/** 协作式取消检查：记录不存在视为取消；DB 瞬时错误不误判为取消（fail-open） */
async function isCanceled(taskId: number): Promise<boolean> {
  const t = await db.scrapeTask
    .findUnique({ where: { id: taskId }, select: { status: true } })
    .catch(() => undefined)
  if (t === undefined) return false // 查询失败 ≠ 被取消，避免瞬时 DB 错误误停任务
  return !t || t.status === 'canceled'
}

/** 生成第 k 页候选 URL：?page=k（已有 query 则 &page=k）与 /page/k 两种变体 */
function pageVariants(url: string, k: number): string[] {
  const out: string[] = []
  try {
    const u = new URL(url)
    u.searchParams.set('page', String(k))
    out.push(u.toString())
    const p = new URL(url)
    p.pathname = `${p.pathname.replace(/\/+$/, '')}/page/${k}`
    p.search = ''
    if (p.toString() !== u.toString()) out.push(p.toString())
  } catch {
    out.push(url.includes('?') ? `${url}&page=${k}` : `${url}?page=${k}`)
    out.push(`${url.replace(/\/+$/, '')}/page/${k}`)
  }
  return [...new Set(out)]
}

// ==================== 单本书处理（single 与 list 共用） ====================

/**
 * 抓取一个书页并入库（含逐章抓取）。
 * - 新书 created+1 / 已有书 updated+1（按 title+author 查重，结果记入 run.counters）
 * - 章节 idx 从现有最大值+1 递增，按章节标题去重，单次上限 MAX_CHAPTERS_PER_BOOK
 * - 进度写入：
 *   - trackTotal=true（single 模式）：章节总数写入 task.total，done 随章节递增（done/total=章节，主口径）
 *   - trackTotal=false（list 模式）：done/total 由调用方按「书」维护，本函数不碰；
 *     章节进度累加进共享的 opts.chapterProgress（chaptersDone/chaptersTotal）并随写盘刷出
 */
async function processBook(
  run: Run,
  bookUrl: string,
  rule: LoadedRule,
  opts: { trackTotal: boolean; chapterProgress?: { done: number; total: number }; referer?: string | null },
): Promise<BookOutcome> {
  const canceledOutcome = (message: string, chapters = 0, failedChapters = 0): BookOutcome => ({
    ok: false,
    canceled: true,
    chapters,
    failedChapters,
    message,
  })

  run.log(`抓取书页 ${bookUrl.slice(0, 120)}…`)
  // Referer 链：list 模式传「发现本书的列表页」作来路；single 模式缺省由引擎回落站内首页
  const page = await fetchBookPage(run, bookUrl, rule, opts.referer ?? undefined)
  if (!page.ok) {
    run.log(`书页提取失败: ${page.error}`)
    return { ok: false, canceled: false, chapters: 0, failedChapters: 0, message: page.error }
  }
  const book = page.book
  run.log(
    `书页提取成功：《${book.title.slice(0, 40)}》${book.author ? ` / ${book.author.slice(0, 20)}` : ''}，章节链接 ${book.chapterCount} 条`,
  )

  // ---- 完整目录页二次提取（bookRule.catalogLinkSelector，如 23qb 新模板书页仅含最新几章）----
  let allRefs = book.chapters
  const catalogSel = rule.bookRule.catalogLinkSelector
  if (typeof catalogSel === 'string' && catalogSel) {
    if (await isCanceled(run.taskId)) return canceledOutcome('任务已取消')
    if (book.catalogUrl) {
      run.log(`发现完整目录页 ${book.catalogUrl.slice(0, 100)}，尝试整目提取…`)
      const catalogRefs = await fetchCatalogChapters(run, book.catalogUrl, rule, bookUrl)
      if (catalogRefs.length > allRefs.length) {
        run.log(`目录页提取到 ${catalogRefs.length} 条章节链接（书页仅 ${allRefs.length} 条），采用目录页结果`)
        allRefs = catalogRefs
      } else {
        run.log(`目录页提取 ${catalogRefs.length} 条不多于书页 ${allRefs.length} 条，维持书页结果`)
      }
    } else {
      run.log(`catalogLinkSelector "${catalogSel.slice(0, 60)}" 在书页无命中，仅用书页章节链接`)
    }
  }

  if (await isCanceled(run.taskId)) return canceledOutcome('任务已取消')

  // ---- 分类 ----
  let categoryId: number
  try {
    categoryId = await ensureCategory(book.category)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '分类处理失败'
    run.log(msg)
    return { ok: false, canceled: false, chapters: 0, failedChapters: 0, message: msg }
  }

  // ---- 书籍 upsert（title+author 查重；DB 层 @@unique([title,author]) 兜底并发）----
  const up = await upsertBook(run, book, categoryId)
  if (!up.ok) {
    // 记录级失败（up.canceled=true：入库/更新失败、并发冲突后找不到记录）沿用取消通道停整个任务；
    // 书籍级失败（up.canceled=false，如空标题）只算本书失败：single 按 failed 收尾，list 继续下一本
    if (up.canceled) return canceledOutcome(up.message)
    return { ok: false, canceled: false, chapters: 0, failedChapters: 0, message: up.message }
  }

  // ---- 章节列表准备 ----
  const refs = allRefs.filter((c): c is { title: string; url: string } => !!c.url)
  if (refs.length === 0) {
    run.log('未提取到任何有效章节链接')
    return { ok: true, canceled: false, chapters: 0, failedChapters: 0, message: '书籍已入库（未提取到章节链接）' }
  }
  let capped = false
  if (refs.length > MAX_CHAPTERS_PER_BOOK) {
    refs.length = MAX_CHAPTERS_PER_BOOK
    capped = true
  }
  if (opts.trackTotal) {
    // single 模式：进度主口径=本章节数，total 为分母
    await run.flush({ total: refs.length })
  } else if (opts.chapterProgress) {
    // list 模式：章节进度独立于 done/total（书）累计
    opts.chapterProgress.total += refs.length
  }

  /** 每处理完一个章节后要刷出的进度字段（不含任务级成果计数） */
  const progressFields = (): TaskFlushFields =>
    opts.trackTotal
      ? { done }
      : {
          chaptersDone: opts.chapterProgress?.done ?? 0,
          chaptersTotal: opts.chapterProgress?.total ?? 0,
        }

  const existingChapters = await db.chapter
    .findMany({ where: { novelId: up.novelId }, select: { title: true } })
    .catch(() => [] as { title: string }[])
  const existingTitles = new Set(existingChapters.map((c) => c.title))
  const maxAgg = await db.chapter
    .aggregate({ where: { novelId: up.novelId }, _max: { idx: true } })
    .catch(() => ({ _max: { idx: null as number | null } }))
  let idx = (maxAgg._max.idx ?? 0) + 1

  // ---- 逐章抓取入库 ----
  let done = 0
  let chaptersStored = 0
  let failedChapters = 0
  let cleanLogCount = 0 // 清洗日志节流：每本书最多记 3 条，防止日志爆炸
  const alive = async (): Promise<boolean> => !(await isCanceled(run.taskId))
  for (const ref of refs) {
    // 关键步骤前的协作式取消检查
    if (!(await alive())) {
      run.log('任务已取消，停止章节抓取')
      await run.flush({ ...progressFields(), chapters: run.counters.chapters })
      return canceledOutcome('任务已取消', chaptersStored, failedChapters)
    }

    const refTitle = (ref.title || '').slice(0, 200)
    if (refTitle && existingTitles.has(refTitle)) {
      done++
      if (opts.chapterProgress) opts.chapterProgress.done++
      run.log(`章节「${refTitle.slice(0, 30)}」已存在，跳过`)
      if (!(await run.flush(progressFields()))) return canceledOutcome('任务记录已删除')
      continue
    }

    run.log(`(${done + 1}/${refs.length}) 抓取章节「${(refTitle || ref.url).slice(0, 36)}」`)
    // Referer 链：章节页带书页来路（站点常见「书页→章节」导航校验）
    const ch = await fetchChapter(ref.url, rule, bookUrl)
    const data = ch.ok ? ch.data : null

    // 入库前统一清洗（去 \r\n/行首缩进/空行/噪声行），存储契约：无空行、无行首缩进
    const cleaned = cleanChapterContent(data?.content ?? '')
    const content = cleaned.text.slice(0, MAX_CONTENT_CHARS)

    if (!data || !content.trim()) {
      failedChapters++
      done++
      if (opts.chapterProgress) opts.chapterProgress.done++
      run.log(`章节抓取失败: ${ch.ok ? '正文为空' : ch.error}`)
      if (!(await run.flush({ ...progressFields(), chapters: run.counters.chapters })))
        return canceledOutcome('任务记录已删除')
      continue
    }
    if (ch.warnings.length) run.logWarnings(ch.warnings)

    const chTitle = (refTitle || data.title || `第${idx}章`).slice(0, 200)
    if (cleaned.removedLines > 0 && cleanLogCount < 3) {
      cleanLogCount++
      run.log(`章节「${chTitle.slice(0, 30)}」清洗 ${cleaned.removedLines} 行噪声`)
    }
    const wordCount = content.replace(/\s/g, '').length
    // storeChapter 内部处理 idx 唯一冲突顺延重试；成功返回实际落库 idx，下一章从其后开始
    const stored = await storeChapter(run, up.novelId, idx, { title: chTitle, content, wordCount })
    if (stored.ok) {
      idx = stored.idx + 1
      existingTitles.add(chTitle)
      chaptersStored++
      run.counters.chapters++
    } else {
      run.log(`章节入库失败: ${stored.message.slice(0, 120)}`)
      failedChapters++
    }
    done++
    if (opts.chapterProgress) opts.chapterProgress.done++
    if (!(await run.flush({ ...progressFields(), chapters: run.counters.chapters })))
      return canceledOutcome('任务记录已删除')
  }

  if (capped) run.log(`已达单本上限（${MAX_CHAPTERS_PER_BOOK} 章），超出部分未采集`)

  // ---- 重算书籍字数 ----
  await recalcNovelWordCount(up.novelId)

  run.log(`本书完成：入库 ${chaptersStored} 章，失败 ${failedChapters} 章`)
  return {
    ok: chaptersStored > 0 || failedChapters === 0, // 全部为"已存在跳过"也算成功
    canceled: false,
    chapters: chaptersStored,
    failedChapters,
    message:
      chaptersStored > 0
        ? `入库 ${chaptersStored} 章`
        : failedChapters === 0
          ? '无新增章节（章节均已存在）'
          : '章节采集全部失败',
  }
}

// ==================== 两种模式 ====================

async function runSingle(run: Run, task: TaskRecord, rule: LoadedRule): Promise<void> {
  const outcome = await processBook(run, task.targetUrl, rule, { trackTotal: true })
  if (outcome.canceled) {
    run.log('任务已取消')
    await finalize(run, 'canceled', '任务已取消')
    return
  }
  await run.flush({ created: run.counters.created, updated: run.counters.updated, chapters: run.counters.chapters })
  if (!outcome.ok) {
    await finalize(run, 'failed', outcome.message || '书页提取失败')
    return
  }
  if (outcome.failedChapters === 0) {
    await finalize(run, 'success', outcome.chapters > 0 ? `采集完成：${outcome.chapters} 章` : outcome.message)
    return
  }
  if (outcome.chapters > 0) {
    await finalize(run, 'partial', `${outcome.chapters} 章成功 / ${outcome.failedChapters} 章失败`)
    return
  }
  await finalize(run, 'failed', '章节采集全部失败')
}

async function runList(run: Run, task: TaskRecord, rule: LoadedRule): Promise<void> {
  run.log('抓取列表页第 1 页…')
  const first = await fetchListPage(run, task.targetUrl, rule)
  if (await isCanceled(run.taskId)) {
    await finalize(run, 'canceled', '任务已取消')
    return
  }
  if (first.length === 0) {
    run.log('列表页未提取到书籍条目')
    await finalize(run, 'failed', '列表页未提取到书籍条目')
    return
  }
  run.log(`第 1 页提取 ${first.length} 条`)

  const items = [...first]
  // 当前生效的列表页 URL（含翻页命中页）：作为后续书页抓取的 Referer 来路
  let currentListUrl = task.targetUrl
  for (let k = 2; k <= task.pages; k++) {
    if (await isCanceled(run.taskId)) break
    let got: ListItem[] | null = null
    for (const v of pageVariants(task.targetUrl, k)) {
      const pageItems = await fetchListPage(run, v, rule)
      if (pageItems.length > 0) {
        got = pageItems
        currentListUrl = v
        run.log(`第 ${k} 页命中: ${v.slice(0, 100)}`)
        break
      }
    }
    if (!got || got.length === 0) {
      run.log(`第 ${k} 页无结果，跳过`)
      continue
    }
    run.log(`第 ${k} 页提取 ${got.length} 条`)
    items.push(...got)
  }

  // 合并去重（按 URL，缺 URL 按标题）
  const seen = new Set<string>()
  const merged: ListItem[] = []
  for (const it of items) {
    const key = it.url ?? `t:${it.title}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(it)
  }
  if (merged.length > MAX_BOOKS_PER_TASK) {
    merged.length = MAX_BOOKS_PER_TASK
    run.log(`条目数超出单任务上限（${MAX_BOOKS_PER_TASK}），已截断`)
  }
  const total = merged.length
  await run.flush({ total, done: 0 })
  run.log(`去重后共 ${total} 本书待采集`)

  let doneBooks = 0
  let okBooks = 0
  let failBooks = 0
  let canceledRun = false
  // 任务级章节进度（跨书累计）：list 模式 done/total 主口径是「书」，章节进度走 chaptersDone/chaptersTotal
  const chapterProgress = { done: 0, total: 0 }
  for (let i = 0; i < total; i++) {
    const item = merged[i]
    if (await isCanceled(run.taskId)) {
      canceledRun = true
      break
    }
    run.log(`━━ (${i + 1}/${total}) 《${(item.title || '未命名').slice(0, 30)}》`)
    const outcome = await processBook(run, item.url as string, rule, { trackTotal: false, chapterProgress, referer: currentListUrl })
    doneBooks++
    if (outcome.canceled) {
      canceledRun = true
      break
    }
    if (outcome.ok) okBooks++
    else failBooks++
    await run.flush({
      done: doneBooks,
      chaptersDone: chapterProgress.done,
      chaptersTotal: chapterProgress.total,
      created: run.counters.created,
      updated: run.counters.updated,
      chapters: run.counters.chapters,
    })
  }

  if (canceledRun) {
    run.log('任务已取消')
    await finalize(run, 'canceled', `已取消（完成 ${doneBooks}/${total} 本）`)
    return
  }
  if (okBooks === 0) {
    await finalize(run, 'failed', '无书籍采集成功')
    return
  }
  if (failBooks > 0) {
    await finalize(run, 'partial', `${okBooks} 本成功 / ${failBooks} 本失败`)
    return
  }
  await finalize(run, 'success', `范围采集完成：共 ${total} 本`)
}

// ==================== 收尾与入口 ====================

/** 终态写入：仅当仍处于 running 时写终态；已被取消/删除则只保留日志 */
async function finalize(run: Run, status: string, message: string): Promise<void> {
  const cur = await db.scrapeTask
    .findUnique({ where: { id: run.taskId }, select: { status: true } })
    .catch(() => null)
  if (!cur) return
  if (cur.status === 'running') {
    await db.scrapeTask
      .updateMany({
        where: { id: run.taskId, status: 'running' },
        data: { status, message: message.slice(0, 500), log: run.logText() },
      })
      .catch(() => {})
  } else {
    await db.scrapeTask
      .updateMany({ where: { id: run.taskId }, data: { log: run.logText() } })
      .catch(() => {})
  }
}

async function runTask(taskId: number): Promise<void> {
  const run = new Run(taskId)
  try {
    // pending → running 条件更新：pending 阶段已被取消/删除的任务不再启动
    const started = await db.scrapeTask
      .updateMany({ where: { id: taskId, status: 'pending' }, data: { status: 'running' } })
      .catch(() => ({ count: 0 }))
    if (started.count === 0) return
    const task = await db.scrapeTask.findUnique({ where: { id: taskId } }).catch(() => null)
    if (!task) return
    const record: TaskRecord = {
      id: task.id,
      mode: task.mode,
      targetUrl: task.targetUrl,
      pages: task.pages,
      ruleId: task.ruleId,
    }
    const rule = await loadRule(record.ruleId)
    run.log(
      record.mode === 'list'
        ? `任务开始（范围采集）目标: ${record.targetUrl}，页数上限: ${record.pages}`
        : `任务开始（单本采集）目标: ${record.targetUrl}`,
    )
    run.log(
      record.ruleId
        ? `使用规则「${rule.name ?? record.ruleId}」（charset=${rule.charset ?? 'auto'}）`
        : '未使用规则，依赖引擎内置启发式提取',
    )
    await run.flush()
    if (record.mode === 'list') await runList(run, record, rule)
    else await runSingle(run, record, rule)
  } catch (e) {
    run.log(`发生未预期错误: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`)
    await finalize(run, 'failed', '任务执行异常')
  }
}

/** fire-and-forget 入口：API 路由创建任务后调用，不 await */
export function triggerScrapeTask(taskId: number): void {
  if (running.has(taskId)) return
  running.add(taskId)
  void runTask(taskId)
    .catch((e: unknown) => {
      console.error(`[scrape-worker] task ${taskId} 兜底异常:`, e instanceof Error ? e.message : e)
    })
    .finally(() => {
      running.delete(taskId)
    })
}
