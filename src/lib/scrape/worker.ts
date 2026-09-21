/**
 * 采集任务 Worker（服务端专用，勿在客户端 import）—— 两阶段并发架构
 *
 * 数据流（list 范围模式）：
 *   Phase 0 列表页翻页收集条目（模板优先，猜测回退）
 *   Phase 1 书目骨架：有界并发抓书页+目录 → upsert 书籍 + 章节骨架入库（content=''、wordCount=0、sourceUrl=url）
 *   Phase 2 正文填充：跨书平铺所有空骨架，有界并发抓正文 → update 填充
 *
 * 语义与可靠性：
 * - 进度：list 模式 done/total=书、chaptersDone/chaptersTotal=章节；single 模式 done/total=章节
 * - 协作式取消贯穿三阶段（throttledCheck 节流查 DB，canceled/记录删除即停）
 * - 可续跑：Phase 2 只填充 wordCount=0 且有 sourceUrl 的骨架；任务中断后重发即续传
 * - 内存治理：正文抓到即清洗即落库不积压；骨架分批拉取（每批 200）；flush 节流防写放大；
 *   日志滚动上限 MAX_LOG_LINES，Phase 2 不逐章记日志
 * - 快速终止：列表连续 3 页全败、或书页连续 5 本全败且 0 成功 → 提前中止（防对封锁站点空转）
 * - 僵尸任务回收、上限放宽（环境变量可配置）、任何异常不外抛
 *
 * 合规红线：仅抓取公开页面；robots 提示与域名限速由 scraper-service 引擎层负责。
 */
import { db } from '@/lib/db'
import { cleanChapterContent } from '@/lib/content-clean'
import { CHAPTER_TITLE_MAX } from '@/lib/limits'
import { fetchBookPage, fetchCatalogChapters, fetchChapterPaged, fetchListPage } from './engine-client'
import { Run, MAX_LOG_LINES } from './run-log'
import { buildPageVariants, hasPaginationTemplate } from './pagination'
import { runPool, throttledCheck } from './pool'
import { ensureCategory, loadRule, recalcNovelWordCount, storeChapter, storeChapterSkeletons, upsertBook } from './store'
import type { BookData, ChapterRef, LoadedRule, ListItem, TaskFlushFields, TaskRecord } from './types'

// ==================== 可配置参数（环境变量 > 默认值） ====================

function intEnv(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def
}

/** 单本书章节数上限（用户指令「取消采集数量的限制」：默认放宽至 10000，仍保留 env 应急阀避免失控任务堆内存） */
const MAX_CHAPTERS_PER_BOOK = intEnv('SCRAPE_MAX_CHAPTERS_PER_BOOK', 10_000)
/** 单任务书籍数上限（同上，默认 5000） */
const MAX_BOOKS_PER_TASK = intEnv('SCRAPE_MAX_BOOKS_PER_TASK', 5_000)
/** 正文单章最大字符数（防异常超长页撑爆内存与存储） */
const MAX_CONTENT_CHARS = 50_000
/** Phase 1 书页并发 */
const BOOK_CONCURRENCY = intEnv('SCRAPE_BOOK_CONCURRENCY', 4)
/** Phase 2 章节正文并发（站点响应普遍 10-20s/章，加大并发摊平总时长；过高易触发站点限速） */
const CHAPTER_CONCURRENCY = intEnv('SCRAPE_CHAPTER_CONCURRENCY', 12)
/** Phase 2 骨架分批大小 */
const SKELETON_BATCH = 200
/** 进度 flush 最小间隔（防 SQLite 写放大） */
const FLUSH_INTERVAL_MS = 800
/** 列表页连续失败快速终止阈值 */
const MAX_CONSECUTIVE_PAGE_FAILS = 3
/** 书页连续失败快速终止阈值（且 0 本成功） */
const MAX_CONSECUTIVE_BOOK_FAILS = 5

/**
 * 模块级防并发：同一任务 id 同时只允许一个 worker 实例。
 * 挂在 globalThis 上：dev HMR 重载本模块时新旧实例共享同一 Set，
 * 否则重载后新实例的 running 为空，同一任务可能被二次触发执行。
 */
const gWorker = globalThis as unknown as {
  __scrapeRunning?: Set<number>
  __scrapeBootAt?: number
  __scrapeRecovered?: boolean
}
const running: Set<number> = (gWorker.__scrapeRunning ??= new Set<number>())

/** 本进程启动时刻（首次加载本模块时；跨 HMR 重载稳定） */
const bootAt: number = (gWorker.__scrapeBootAt ??= Date.now())

/**
 * 僵尸任务回收（最小机制）：worker 常驻在 Next.js 进程内存里（fire-and-forget promise），
 * 进程重启后内存任务丢失，DB 中 status=pending/running 的记录会永久卡死。
 * 进程首次加载本模块时，把「创建于本进程启动之前」且仍处于 pending/running 的任务标记为
 * failed——它们只可能属于已消失的旧进程（本进程新建任务 createdAt ≥ bootAt，不会误伤；
 * 本进程在跑任务再经共享 running Set 二次排除，覆盖 HMR 重载场景）。
 * 条件更新（status 仍为 pending/running）保证与 worker 终态写入竞态安全。
 */
async function recoverStaleTasks(): Promise<void> {
  if (gWorker.__scrapeRecovered) return
  // 仅 runner 进程（SCRAPE_WORKER_RUNNER=1）执行回收：Next 进程重启时若也执行，
  // 会把 runner 正在跑的任务误判为「已消失进程的僵尸」而标 failed
  if (process.env.SCRAPE_WORKER_RUNNER !== '1') {
    gWorker.__scrapeRecovered = true
    return
  }
  try {
    const stale = await db.scrapeTask.findMany({
      where: { status: { in: ['pending', 'running'] }, createdAt: { lt: new Date(bootAt) } },
      select: { id: true, log: true },
    })
    let recovered = 0
    for (const t of stale) {
      if (running.has(t.id)) continue // 本进程仍有旧模块闭包在执行（HMR 重载未结束）
      const line = `[${new Date().toTimeString().slice(0, 8)}] 服务重启，任务中断（自动回收）`
      const log = `${t.log ? `${t.log}\n` : ''}${line}`
      const res = await db.scrapeTask
        .updateMany({
          where: { id: t.id, status: { in: ['pending', 'running'] } },
          data: {
            status: 'failed',
            message: '服务重启，任务中断',
            // 与 Run 同规约：只保留最近 100 行
            log: log.split('\n').slice(-MAX_LOG_LINES).join('\n'),
          },
        })
        .catch(() => null)
      if (res && res.count > 0) recovered++
    }
    gWorker.__scrapeRecovered = true
    if (recovered > 0) console.log(`[scrape-worker] 僵尸任务回收: ${recovered} 条`)
  } catch {
    // 回收失败不阻塞模块加载；标志不置位，下次模块加载（HMR/重启）自动重试
  }
}
void recoverStaleTasks()

/** 协作式取消检查：记录不存在视为取消；DB 瞬时错误不误判为取消（fail-open） */
async function isCanceled(taskId: number): Promise<boolean> {
  const t = await db.scrapeTask
    .findUnique({ where: { id: taskId }, select: { status: true } })
    .catch(() => undefined)
  if (t === undefined) return false // 查询失败 ≠ 被取消，避免瞬时 DB 错误误停任务
  return !t || t.status === 'canceled'
}

// ==================== 共用工具 ====================

/** 引擎响应未经 schema 校验（callEngine 直接 as 断言），关键字段做形态兜底 */
function shapeBook(book: BookData): BookData {
  if (typeof book.title !== 'string') book.title = ''
  if (!Array.isArray(book.chapters)) book.chapters = []
  if (typeof book.description !== 'string') book.description = ''
  if (typeof book.author !== 'string') book.author = ''
  if (typeof book.category !== 'string') book.category = ''
  if (typeof book.status !== 'string') book.status = ''
  if (typeof book.chapterCount !== 'number') book.chapterCount = book.chapters.length
  return book
}

/** 目录页噪声按钮/导航文案（与引擎 NOISE_TOC_TITLES 同步，双保险：引擎已滤，此处兜底） */
const NOISE_TOC_TITLES = new Set([
  '立即阅读', '开始阅读', '点击阅读', '进入阅读', '继续阅读', '全文阅读', '免费阅读',
  '无弹窗阅读', '最新章节', '最新章节列表', '查看目录', '章节目录', '全部目录', '目录',
  '书签', '加入书签', '上一章', '下一章', '上一页', '下一页', '推荐票', '投推荐票',
])

/** 章节链接规范化：过滤无 URL、噪声按钮文案、trim、URL 去重（同 URL 不同标题视为同章） */
function normalizeRefs(refs: ChapterRef[]): { title: string; url: string }[] {
  const seen = new Set<string>()
  const out: { title: string; url: string }[] = []
  for (const r of refs) {
    if (!r || typeof r.url !== 'string' || !r.url.trim()) continue
    const title = (r.title || '').trim()
    if (NOISE_TOC_TITLES.has(title)) continue
    const url = r.url.trim()
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ title: title.slice(0, CHAPTER_TITLE_MAX), url })
  }
  return out
}

/** 从章节 URL 提取同源 origin 作 referer 兜底（续跑场景 referers Map 为空时用） */
function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

// ==================== Phase 1：书目骨架（并发） ====================

export interface Phase1Outcome {
  okBooks: number
  failBooks: number
  stoppedEarly: boolean
  firstError: string
  novelIds: number[]
  /** novelId → 填充计划：书页 referer + 待填充 (title,url) 行（新建骨架 + 空骨架续传） */
  fillMap: Map<number, { referer: string; rows: { title: string; url: string }[] }>
  /** 全部有效章节链接数（含已填充跳过）——single 模式进度分母 */
  totalRefs: number
  /** 其中已有正文而跳过的数量——single 模式进度初值 */
  skippedFilled: number
  /** 待填充总行数（fillMap 各书 rows 之和，list 模式 chaptersTotal 的来源） */
  fillTotal: number
}

async function phase1Skeletons(
  run: Run,
  rule: LoadedRule,
  items: ListItem[],
  opts: { listUrl?: string | null },
): Promise<Phase1Outcome> {
  const fillMap = new Map<number, { referer: string; rows: { title: string; url: string }[] }>()
  const novelIds: number[] = []
  let okBooks = 0
  let failBooks = 0
  let failStreak = 0
  let firstError = ''
  let totalRefs = 0
  let skippedFilled = 0
  let fillTotal = 0
  let sawCatalog = 0

  // 取消 + 快速终止（连续多本全败且 0 成功 → 判定站点不可达，中止防空转）
  const shouldStop = throttledCheck(async () => {
    if (await isCanceled(run.taskId)) return true
    return failStreak >= MAX_CONSECUTIVE_BOOK_FAILS && okBooks === 0
  })

  await runPool(items, BOOK_CONCURRENCY, async (item) => {
    const bookUrl = item.url as string
    const page = await fetchBookPage(run, bookUrl, rule, opts.listUrl ?? undefined)
    if (!page.ok) {
      if (!firstError) firstError = page.error
      failBooks++
      failStreak++
      run.log(`书页失败(${bookUrl.slice(0, 90)}): ${page.error.slice(0, 120)}`)
      return
    }
    const book = shapeBook(page.book)
    run.log(
      `书页命中《${book.title.slice(0, 40)}》${book.author ? ` / ${book.author.slice(0, 20)}` : ''}，章节链接 ${book.chapterCount} 条`,
    )

    // 完整目录页二次提取（书页仅含最新几章时）
    let allRefs = book.chapters
    const catalogSel = rule.bookRule.catalogLinkSelector
    if (typeof catalogSel === 'string' && catalogSel && book.catalogUrl) {
      const catalogRefs = await fetchCatalogChapters(run, book.catalogUrl, rule, bookUrl)
      if (Array.isArray(catalogRefs) && catalogRefs.length > allRefs.length) {
        sawCatalog++
        allRefs = catalogRefs
      }
    }
    const refs = normalizeRefs(allRefs)
    if (refs.length === 0) {
      // 无章节链接：仍入库书籍（原语义「书籍已入库（未提取到章节链接）」），不计失败
    }

    let categoryId: number
    try {
      // 源站分类名归并失败时用书名+简介 LLM 推断（防「未分类」堆积）
      categoryId = await ensureCategory(book.category, { title: book.title, description: book.description })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '分类处理失败'
      if (!firstError) firstError = msg
      failBooks++
      failStreak++
      run.log(`《${book.title.slice(0, 24)}》${msg}`)
      return
    }

    const up = await upsertBook(run, book, categoryId, rule.proxy)
    if (!up.ok) {
      if (!firstError) firstError = up.message
      failBooks++
      failStreak++
      run.log(`《${book.title.slice(0, 24)}》入库失败: ${up.message}`)
      return
    }

    const sk = await storeChapterSkeletons(run, up.novelId, refs, MAX_CHAPTERS_PER_BOOK)
    if (sk.capped) run.log(`《${up.title.slice(0, 24)}》已达单本上限（${MAX_CHAPTERS_PER_BOOK} 章），超出部分未采集`)
    novelIds.push(up.novelId)
    okBooks++
    failStreak = 0
    totalRefs += sk.total
    skippedFilled += sk.skippedFilled
    fillTotal += sk.fillRows.length
    if (sk.fillRows.length > 0) fillMap.set(up.novelId, { referer: bookUrl, rows: sk.fillRows })
    run.log(`《${up.title.slice(0, 24)}》骨架入库 ${sk.stored} 章（已有正文跳过 ${sk.skippedFilled}，待填充 ${sk.fillRows.length}）`)
  }, shouldStop)

  if (sawCatalog > 0) run.log(`目录页二次提取生效 ${sawCatalog} 本`)
  return { okBooks, failBooks, stoppedEarly: false, firstError, novelIds, fillMap, totalRefs, skippedFilled, fillTotal }
}

// ==================== Phase 2：正文填充（跨书平铺并发） ====================

export interface Phase2Outcome {
  filled: number
  failed: number
  stoppedEarly: boolean
}

/**
 * 消费 Phase 1 的填充计划：逐书分批（200/批）拉取 DB 空骨架行（wordCount=0，含历史中断遗留的
 * 同名重复行），书内有界并发抓正文并 update 填充；处理完一本书即从 fillMap 释放其 rows（内存渐减）。
 * 章节抓取失败保留骨架（wordCount=0），重发任务自动续传。
 * onProgress(doneSoFar) 由调用方节流落库进度；返回 false 表示任务记录已删除，立即停止。
 */
async function phase2Fill(
  run: Run,
  rule: LoadedRule,
  fillMap: Map<number, { referer: string; rows: { title: string; url: string }[] }>,
  onProgress: (doneSoFar: number) => Promise<boolean>,
): Promise<Phase2Outcome> {
  let filled = 0
  let failed = 0
  let stoppedEarly = false
  let warnLogged = 0 // warnings 节流：正文阶段逐章都有提示，全记会刷掉有效日志
  const isStopped = throttledCheck(() => isCanceled(run.taskId))

  for (const [novelId, plan] of fillMap) {
    if (stoppedEarly) break
    if (await isStopped()) {
      stoppedEarly = true
      break
    }
    let bookFilled = 0
    let bookFailed = 0
    for (let off = 0; off < plan.rows.length; off += SKELETON_BATCH) {
      const slice = plan.rows.slice(off, off + SKELETON_BATCH)
      // 同名行可能有多条（历史遗留重复）：一起拉出来填同一内容，后续由目录体检工具去重
      const dbRows = await db.chapter
        .findMany({
          where: { novelId, title: { in: slice.map((r) => r.title) }, wordCount: 0 },
          select: { id: true, title: true },
        })
        .catch(() => [])
      if (dbRows.length === 0) continue
      const urlByTitle = new Map(slice.map((r) => [r.title, r.url]))
      await runPool(
        dbRows,
        CHAPTER_CONCURRENCY,
        async (row) => {
          const url = urlByTitle.get(row.title)
          if (!url) return
          const referer = plan.referer ?? safeOrigin(url)
          const res = await fetchChapterPaged(url, rule, referer)
          if (!res.ok) {
            failed++
            bookFailed++
            return
          }
          const cleaned = cleanChapterContent(res.data?.content ?? '')
          const content = cleaned.text.slice(0, MAX_CONTENT_CHARS)
          if (!content.trim()) {
            failed++ // 源站空壳章：保留骨架，重发任务自动重试
            bookFailed++
            return
          }
          if (res.warnings.length && warnLogged < 10) {
            warnLogged++
            run.logWarnings(res.warnings)
          }
          const wordCount = content.replace(/\s/g, '').length
          const title = ((row.title || res.data.title || '').trim() || `第${row.id}章`).slice(0, CHAPTER_TITLE_MAX)
          const upd = await db.chapter
            .update({ where: { id: row.id }, data: { title, content, wordCount } })
            .catch(() => null)
          if (upd) {
            filled++
            bookFilled++
            run.counters.chapters++
          } else {
            failed++
            bookFailed++
          }
        },
        isStopped,
      )
      if (!(await onProgress(filled))) {
        stoppedEarly = true
        break
      }
      if (await isStopped()) {
        stoppedEarly = true
        break
      }
    }
    run.log(`书籍 #${novelId} 正文填充完成：成功 ${bookFilled} / 失败 ${bookFailed}`)
    fillMap.delete(novelId) // 处理完即释放，长任务内存渐减
  }
  return { filled, failed, stoppedEarly }
}

// ==================== 字数汇总 ====================

/** 任务收尾：对涉及的书籍统一重算字数（groupBy 汇总，避免逐书 aggregate） */
async function recalcWordCountsFor(novelIds: number[]): Promise<void> {
  if (novelIds.length === 0) return
  const sums = await db.chapter
    .groupBy({ by: ['novelId'], where: { novelId: { in: novelIds } }, _sum: { wordCount: true } })
    .catch(() => [])
  for (const s of sums) {
    await db.novel
      .update({ where: { id: s.novelId }, data: { wordCount: s._sum.wordCount ?? 0 } })
      .catch(() => null)
  }
}

// ==================== Phase 0：列表页条目收集 ====================

async function collectListItems(
  run: Run,
  task: TaskRecord,
  rule: LoadedRule,
): Promise<{ items: ListItem[]; currentListUrl: string; stoppedEarly: boolean }> {
  run.log('抓取列表页第 1 页…')
  const first = await fetchListPage(run, task.targetUrl, rule)
  if (first.length === 0) {
    run.log('列表页未提取到书籍条目')
    return { items: [], currentListUrl: task.targetUrl, stoppedEarly: false }
  }
  run.log(`第 1 页提取 ${first.length} 条`)

  const items = [...first]
  let currentListUrl = task.targetUrl
  let consecutiveFails = 0
  const templated = hasPaginationTemplate(rule.listRule)
  if (templated) run.log(`分页模板生效: ${String(rule.listRule.paginationTemplate).slice(0, 120)}`)

  for (let k = 2; k <= task.pages; k++) {
    if (await isCanceled(run.taskId)) break
    let got: ListItem[] | null = null
    for (const v of buildPageVariants(rule.listRule, task.targetUrl, k)) {
      const pageItems = await fetchListPage(run, v, rule)
      if (pageItems.length > 0) {
        got = pageItems
        currentListUrl = v
        break
      }
    }
    if (!got || got.length === 0) {
      consecutiveFails++
      run.log(`第 ${k} 页无结果（连续失败 ${consecutiveFails}）`)
      if (consecutiveFails >= MAX_CONSECUTIVE_PAGE_FAILS) {
        run.log(`连续 ${MAX_CONSECUTIVE_PAGE_FAILS} 页翻页失败，提前终止翻页`)
        break
      }
      continue
    }
    consecutiveFails = 0
    run.log(`第 ${k} 页命中: ${currentListUrl.slice(0, 100)}，提取 ${got.length} 条`)
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
  let capped = false
  if (merged.length > MAX_BOOKS_PER_TASK) {
    merged.length = MAX_BOOKS_PER_TASK
    capped = true
  }
  if (capped) run.log(`条目数超出单任务上限（${MAX_BOOKS_PER_TASK}），已截断`)
  return { items: merged, currentListUrl, stoppedEarly: false }
}

// ==================== 两种模式 ====================

async function runList(run: Run, task: TaskRecord, rule: LoadedRule): Promise<void> {
  // ---- Phase 0：列表页 ----
  const collected = await collectListItems(run, task, rule)
  if (await isCanceled(run.taskId)) {
    await finalize(run, 'canceled', '任务已取消')
    return
  }
  if (collected.items.length === 0) {
    await finalize(run, 'failed', '列表页未提取到书籍条目')
    return
  }
  const total = collected.items.length
  await run.flush({ total, done: 0 })
  run.log(`去重后共 ${total} 本书待采集`)

  // ---- Phase 1：书目骨架 ----
  run.log(`━━ 阶段 1/2 书目骨架（并发 ${BOOK_CONCURRENCY}）`)
  const p1 = await phase1Skeletons(run, rule, collected.items, { listUrl: collected.currentListUrl })
  if (await isCanceled(run.taskId)) {
    await recalcWordCountsFor(p1.novelIds)
    await finalize(run, 'canceled', `已取消（书目完成 ${p1.okBooks}/${total} 本）`)
    return
  }
  await run.flush({
    done: p1.okBooks,
    chaptersTotal: p1.fillTotal,
    chaptersDone: 0,
    created: run.counters.created,
    updated: run.counters.updated,
  })

  if (p1.okBooks === 0) {
    await finalize(run, 'failed', p1.firstError || '无书籍采集成功')
    return
  }

  // ---- Phase 2：正文填充 ----
  run.log(`━━ 阶段 2/2 正文填充（并发 ${CHAPTER_CONCURRENCY}，待填充 ${p1.fillTotal} 章）`)
  let lastFlush = 0
  const p2 = await phase2Fill(run, rule, p1.fillMap, async (doneSoFar) => {
    const now = Date.now()
    if (now - lastFlush < FLUSH_INTERVAL_MS) return true
    lastFlush = now
    return run.flush({
      chaptersDone: doneSoFar,
      chapters: run.counters.chapters,
      created: run.counters.created,
      updated: run.counters.updated,
    })
  })
  await recalcWordCountsFor(p1.novelIds)
  await run.flush({
    chaptersDone: p2.filled,
    chapters: run.counters.chapters,
    created: run.counters.created,
    updated: run.counters.updated,
  })

  if (p2.stoppedEarly) {
    await finalize(run, 'canceled', `已取消（正文填充 ${p2.filled}/${p1.fillTotal} 章）`)
    return
  }
  if (p2.filled === 0) {
    await finalize(run, 'failed', `书目 ${p1.okBooks} 本入库，但正文采集全部失败`)
    return
  }
  if (p2.failed > 0) {
    await finalize(run, 'partial', `${p1.okBooks} 本书 / 正文 ${p2.filled} 章成功，${p2.failed} 章失败`)
    return
  }
  await finalize(run, 'success', `范围采集完成：${p1.okBooks} 本书，正文 ${p2.filled} 章`)
}

async function runSingle(run: Run, task: TaskRecord, rule: LoadedRule): Promise<void> {
  // single 复用两阶段管线：一个条目 → 骨架 → 填充；done/total 主口径=章节
  const items: ListItem[] = [{ title: '', url: task.targetUrl, author: '', category: '' }]
  run.log(`━━ 阶段 1/2 书目骨架（并发 ${BOOK_CONCURRENCY}）`)
  const p1 = await phase1Skeletons(run, rule, items, {})
  if (p1.okBooks === 0) {
    await finalize(run, 'failed', p1.firstError || '书页提取失败')
    return
  }
  if (await isCanceled(run.taskId)) {
    await recalcWordCountsFor(p1.novelIds)
    await finalize(run, 'canceled', '任务已取消')
    return
  }
  const totalChapters = p1.totalRefs
  await run.flush({ total: totalChapters, done: p1.skippedFilled, chaptersTotal: totalChapters, chaptersDone: p1.skippedFilled })
  if (totalChapters === 0) {
    await finalize(run, 'success', '书籍已入库（未提取到章节链接）')
    return
  }

  run.log(`━━ 阶段 2/2 正文填充（并发 ${CHAPTER_CONCURRENCY}，待填充 ${p1.fillTotal} 章）`)
  let lastFlush = 0
  const p2 = await phase2Fill(run, rule, p1.fillMap, async (doneSoFar) => {
    const now = Date.now()
    if (now - lastFlush < FLUSH_INTERVAL_MS) return true
    lastFlush = now
    const done = p1.skippedFilled + doneSoFar
    return run.flush({ done, chaptersDone: done })
  })

  await recalcWordCountsFor(p1.novelIds)
  const done = p1.skippedFilled + p2.filled
  await run.flush({ done, chaptersDone: done, chapters: run.counters.chapters })

  if (p2.stoppedEarly) {
    await finalize(run, 'canceled', '任务已取消')
    return
  }
  if (p2.filled === 0) {
    await finalize(run, 'failed', '章节采集全部失败')
    return
  }
  if (p2.failed > 0) {
    await finalize(run, 'partial', `${p2.filled} 章成功 / ${p2.failed} 章失败`)
    return
  }
  await finalize(run, 'success', `采集完成：${p2.filled} 章`)
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
        ? `任务开始（范围采集·两阶段并发）目标: ${record.targetUrl}，页数上限: ${record.pages}`
        : `任务开始（单本采集·两阶段并发）目标: ${record.targetUrl}`,
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
