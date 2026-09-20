/**
 * 采集任务 Worker（服务端专用，勿在客户端 import）—— 两阶段并发架构
 *
 * 阶段1（书籍+目录骨架）：并发池抓书页/目录页 → 分类归并 → 书籍 upsert →
 *   章节骨架行（content=''）批量入库。书名+目录名先全部支撑起来，前台立即可见书目。
 * 阶段2（章节内容回填）：跨书平铺所有空骨架行，并发池抓正文回填（content 守卫防覆盖）。
 *   单任务失败骨架保留，重跑任务自动续采（阶段1按标题重建 URL 映射）。
 *
 * - single 模式：单本书也走两阶段（meta → fill），章节回填并发执行
 * - list 模式：列表页翻页收集条目（支持 listRule.pagination 模板与通用猜测回退）→
 *   阶段1 并发池（META_CONCURRENCY）→ 阶段2 并发池（CONTENT_CONCURRENCY）
 * - 进度语义：single 模式 done/total=章节（主口径）；list 模式 done/total=书（主口径），
 *   章节进度独立记 chaptersDone/chaptersTotal，任何时刻 done ≤ total
 * - 协作式取消：每个关键步骤前读一次 DB status；僵尸任务回收（进程重启后标记残留任务 failed）
 * - 正文入库前 cleanChapterContent 统一清洗；回填用 UPDATE ... WHERE content='' 守卫，
 *   并发双任务同书不会互相覆盖已抓正文
 * - 合规红线：仅抓取公开页面；robots 与域名限速由 scraper-service 引擎层负责；
 *   单本章节上限 2000、单任务书籍上限 300、正文 5 万字截断
 */
import { db } from '@/lib/db'
import { cleanChapterContent } from '@/lib/content-clean'
import { fetchBookPage, fetchCatalogChapters, fetchChapterPaged, fetchListPage } from './engine-client'
import { Run, MAX_LOG_LINES } from './run-log'
import { ensureCategory } from './category'
import { isUniqueConflict, loadRule, recalcNovelWordCount, upsertBook } from './store'
import { buildPageVariants } from './pagination'
import type { LoadedRule, ListItem, MetaOutcome, PendingChapter, TaskFlushFields, TaskRecord } from './types'

const MAX_CHAPTERS_PER_BOOK = 2000
const MAX_BOOKS_PER_TASK = 300
const MAX_CONTENT_CHARS = 50_000
/** 阶段1 并发度：每任务同时抓取的书页/目录页数（11 任务并行时引擎侧合计约 33 路） */
const META_CONCURRENCY = 3
/** 阶段2 并发度：每任务同时回填的章节数（按站点隔离，单站压力可控） */
const CONTENT_CONCURRENCY = 4

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
 * 僵尸任务恢复（最小机制）：worker 常驻在 Next.js 进程内存里（fire-and-forget promise），
 * 进程重启后内存任务丢失，DB 中 status=pending/running 的记录会永久卡死。
 * 进程首次加载本模块时，把「创建于本进程启动之前」且仍处于 pending/running 的任务标记为
 * failed——它们只可能属于已消失的旧进程（本进程新建任务 createdAt ≥ bootAt，不会误伤；
 * 本进程在跑任务再经共享 running Set 二次排除，覆盖 HMR 重载场景）。
 * 条件更新（status 仍为 pending/running）保证与 worker 终态写入竞态安全。
 */
async function recoverStaleTasks(): Promise<void> {
  if (gWorker.__scrapeRecovered) return
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

/** 简单并发池：按游标逐个领取，worker 数 = min(concurrency, items.length)；fn 异常不炸池 */
async function runPool<T>(concurrency: number, items: readonly T[], fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const n = Math.max(1, Math.min(concurrency, items.length))
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      try {
        await fn(items[i], i)
      } catch (e) {
        console.error(`[scrape-worker] pool item ${i} 兜底异常:`, e instanceof Error ? e.message : e)
      }
    }
  }
  await Promise.all(Array.from({ length: n }, worker))
}

// ==================== 阶段1：书籍元信息 + 章节骨架 ====================

/**
 * 抓取书页（含完整目录页二次提取）→ 归并分类 → 书籍 upsert → 章节骨架入库 → 待回填清单。
 * 与旧版逐章流程的语义差异：本函数不做任何章节正文抓取，只建骨架（content=''）。
 */
async function processBookMeta(
  run: Run,
  item: { title?: string; url: string },
  referer: string | null,
  rule: LoadedRule,
  progress: { done: number; total: number },
  opts?: { trackTotal?: boolean },
): Promise<MetaOutcome> {
  const fail = (message: string, canceled = false): MetaOutcome => ({
    ok: false,
    canceled,
    novelId: 0,
    title: '',
    chapterRefs: 0,
    pending: [],
    message,
  })
  const bookUrl = item.url
  run.log(`抓取书页 ${bookUrl.slice(0, 120)}…`)
  // Referer 链：list 模式传「发现本书的列表页」作来路；single 模式缺省由引擎回落站内首页
  const page = await fetchBookPage(run, bookUrl, rule, referer ?? undefined)
  if (!page.ok) {
    run.log(`书页提取失败: ${page.error}`)
    return fail(page.error)
  }
  const book = page.book
  // 引擎响应未经 schema 校验（callEngine 直接 as 断言），关键字段做形态兜底，
  // 防畸形载荷（引擎版本错位等）在任务中途抛 TypeError 把整任务拖成 failed
  if (typeof book.title !== 'string') book.title = ''
  if (!Array.isArray(book.chapters)) book.chapters = []
  if (typeof book.description !== 'string') book.description = ''
  if (typeof book.author !== 'string') book.author = ''
  if (typeof book.category !== 'string') book.category = ''
  if (typeof book.status !== 'string') book.status = ''
  if (typeof book.chapterCount !== 'number') book.chapterCount = book.chapters.length
  run.log(
    `书页提取成功：《${book.title.slice(0, 40)}》${book.author ? ` / ${book.author.slice(0, 20)}` : ''}，章节链接 ${book.chapterCount} 条`,
  )

  // ---- 完整目录页二次提取（bookRule.catalogLinkSelector，如 23qb 新模板书页仅含最新几章）----
  let allRefs = book.chapters
  const catalogSel = rule.bookRule.catalogLinkSelector
  if (typeof catalogSel === 'string' && catalogSel && book.catalogUrl) {
    if (await isCanceled(run.taskId)) return fail('任务已取消', true)
    run.log(`发现完整目录页 ${book.catalogUrl.slice(0, 100)}，尝试整目提取…`)
    const catalogRefs = await fetchCatalogChapters(run, book.catalogUrl, rule, bookUrl)
    if (Array.isArray(catalogRefs) && catalogRefs.length > allRefs.length) {
      run.log(`目录页提取到 ${catalogRefs.length} 条章节链接（书页仅 ${allRefs.length} 条），采用目录页结果`)
      allRefs = catalogRefs
    } else {
      run.log(`目录页提取 ${catalogRefs.length} 条不多于书页 ${allRefs.length} 条，维持书页结果`)
    }
  }

  if (await isCanceled(run.taskId)) return fail('任务已取消', true)

  // ---- 章节引用清洗：有效 URL 过滤 → URL 去重 → 标题规整 → 上限截断 ----
  const seenUrls = new Set<string>()
  const refs = allRefs
    .filter((c): c is { title: string; url: string } => !!c && typeof c.url === 'string' && !!c.url)
    .filter((c) => {
      if (seenUrls.has(c.url)) return false
      seenUrls.add(c.url)
      return true
    })
    .map((c, i) => ({ title: (c.title || '').trim().slice(0, 200) || `第${i + 1}章`, url: c.url }))
  let capped = false
  if (refs.length > MAX_CHAPTERS_PER_BOOK) {
    refs.length = MAX_CHAPTERS_PER_BOOK
    capped = true
  }

  // ---- 智能分类（规范集 + 同义词 + LLM 兜底，绝无「未分类」） ----
  let categoryId: number
  try {
    categoryId = await ensureCategory(book.category, { title: book.title, description: book.description })
  } catch (e) {
    const msg = e instanceof Error ? e.message : '分类处理失败'
    run.log(msg)
    return fail(msg)
  }

  // ---- 书籍 upsert（title+author 查重；DB 层 @@unique([title,author]) 兜底并发）----
  const up = await upsertBook(run, book, categoryId, rule.proxy)
  if (!up.ok) {
    // 记录级失败（up.canceled=true：入库/更新失败、并发冲突后找不到记录）沿用取消通道停整个任务；
    // 书籍级失败（up.canceled=false，如空标题）只算本书失败
    if (up.canceled) return fail(up.message, true)
    return fail(up.message)
  }

  // ---- 章节骨架入库 + 待回填清单 ----
  const skeleton = await buildSkeletonAndPending(run, up.novelId, up.title, bookUrl, refs)
  if (capped) run.log(`已达单本上限（${MAX_CHAPTERS_PER_BOOK} 章），超出部分未采集`)
  if (skeleton.created > 0) run.log(`骨架入库：新增 ${skeleton.created} 章，待回填 ${skeleton.pending.length} 章`)

  // ---- 进度登记 ----
  if (opts?.trackTotal) {
    // single 模式：进度主口径=本章节数（flush false=任务记录已删，立即停）
    if (!(await run.flush({ total: skeleton.pending.length }))) return fail('任务记录已删除', true)
  } else {
    progress.total += skeleton.pending.length
  }

  return {
    ok: true,
    canceled: false,
    novelId: up.novelId,
    title: up.title,
    chapterRefs: refs.length,
    pending: skeleton.pending,
    message: refs.length === 0 ? '书籍已入库（未提取到章节链接）' : '',
  }
}

/**
 * 章节骨架入库 + 待回填清单构建。
 * 匹配规则（按章节标题 FIFO）：
 *   - 已有行 content≠'' → 该标题章节已抓过，跳过
 *   - 已有行 content='' → 复用骨架行，加入待回填（重跑续采路径）
 *   - 无行 → 批量创建骨架行（createMany，撞 (novelId,idx) 时逐行容错顺延）
 * 返回新增骨架数与待回填清单（URL 映射按标题 FIFO 对齐）。
 */
async function buildSkeletonAndPending(
  run: Run,
  novelId: number,
  bookTitle: string,
  bookUrl: string,
  refs: { title: string; url: string }[],
): Promise<{ created: number; pending: PendingChapter[] }> {
  const existing = await db.chapter
    .findMany({ where: { novelId }, select: { id: true, title: true, content: true }, orderBy: { idx: 'asc' } })
    .catch(() => [] as { id: number; title: string; content: string }[])
  const rowsByTitle = new Map<string, { id: number; empty: boolean }[]>()
  for (const r of existing) {
    const list = rowsByTitle.get(r.title) ?? []
    list.push({ id: r.id, empty: r.content === '' })
    rowsByTitle.set(r.title, list)
  }

  /** chapterId → 待抓 URL；'' 占位 = 已填充行（跳过） */
  const matched = new Map<number, string>()
  const needCreate: { title: string; url: string }[] = []
  for (const ref of refs) {
    const list = rowsByTitle.get(ref.title) ?? []
    const emptyIdx = list.findIndex((r) => r.empty && !matched.has(r.id))
    const filledIdx = list.findIndex((r) => !r.empty && !matched.has(r.id))
    if (emptyIdx >= 0) matched.set(list[emptyIdx].id, ref.url)
    else if (filledIdx >= 0) matched.set(list[filledIdx].id, '') // 已抓过：占位跳过
    else needCreate.push(ref)
  }

  // 批量建骨架（createMany 事务性：整体冲突时逐行容错顺延重建）
  let created = 0
  if (needCreate.length > 0) {
    const maxIdx = async (): Promise<number> => {
      const agg = await db.chapter
        .aggregate({ where: { novelId }, _max: { idx: true } })
        .catch(() => ({ _max: { idx: null as number | null } }))
      return (agg._max.idx ?? 0) + 1
    }
    let idx = await maxIdx()
    try {
      await db.chapter.createMany({ data: needCreate.map((c) => ({ novelId, idx: idx++, title: c.title, content: '', wordCount: 0 })) })
      created = needCreate.length
    } catch {
      // 并发另一任务同书建骨架撞 (novelId, idx) → 逐行容错
      idx = await maxIdx()
      let missed = 0
      for (const c of needCreate) {
        let ok = false
        for (let bump = 0; bump <= 5 && !ok; bump++) {
          try {
            await db.chapter.create({ data: { novelId, idx, title: c.title, content: '', wordCount: 0 } })
            ok = true
            created++
          } catch (e) {
            if (isUniqueConflict(e)) {
              idx++
              continue
            }
            break // 非冲突错误（FK 违规等）放弃本书剩余骨架
          }
        }
        if (!ok) missed++
      }
      if (missed > 0) run.log(`《${bookTitle.slice(0, 24)}》${missed} 章骨架入库失败`)
    }
  }

  // 空骨架行 → 待回填清单（按标题 FIFO 对齐 URL；含重跑任务的历史空骨架）
  const emptyRows = await db.chapter
    .findMany({ where: { novelId, content: '' }, select: { id: true, title: true }, orderBy: { idx: 'asc' } })
    .catch(() => [] as { id: number; title: string }[])
  const consumed = new Set(matched.keys())
  const queueByTitle = new Map<string, number[]>()
  for (const r of emptyRows) {
    if (consumed.has(r.id)) continue
    const q = queueByTitle.get(r.title) ?? []
    q.push(r.id)
    queueByTitle.set(r.title, q)
  }
  const pending: PendingChapter[] = []
  for (const [chapterId, url] of matched) {
    if (url) pending.push({ chapterId, novelId, url, bookUrl, bookTitle })
  }
  for (const c of needCreate) {
    const id = queueByTitle.get(c.title)?.shift()
    if (!id) continue // 对应骨架行创建失败（见 missed 日志）
    pending.push({ chapterId: id, novelId, url: c.url, bookUrl, bookTitle })
  }
  return { created, pending }
}

// ==================== 阶段2：章节内容并发回填 ====================

/**
 * 跨书平铺回填：并发池抓正文 → UPDATE ... WHERE content='' 守卫写入。
 * - 每完成一章推进 progress.done 并节流 flush（800ms）；flush false（任务记录已删）即取消
 * - 每本书的最后一章完成后重算该书香分字数；中断收尾时对未完成书兜底重算
 */
async function fillChapterContents(
  run: Run,
  rule: LoadedRule,
  pending: PendingChapter[],
  opts: {
    progress: { done: number; total: number }
    flushFields: () => TaskFlushFields
    stopped: () => boolean
    onStop: () => void
  },
): Promise<{ stored: number; failed: number; skipped: number; canceled: boolean }> {
  const outcome = { stored: 0, failed: 0, skipped: 0, canceled: false }
  if (pending.length === 0) return outcome

  // 每本书剩余待回填数 → 归零时重算书香分
  const remaining = new Map<number, number>()
  for (const p of pending) remaining.set(p.novelId, (remaining.get(p.novelId) ?? 0) + 1)

  let cursor = 0
  let lastFlush = 0
  const maybeFlush = async (force = false): Promise<boolean> => {
    const now = Date.now()
    if (!force && now - lastFlush < 800) return true
    lastFlush = now
    return await run.flush(opts.flushFields())
  }

  const worker = async (): Promise<void> => {
    while (!outcome.canceled && !opts.stopped()) {
      const i = cursor++
      if (i >= pending.length) return
      const p = pending[i]
      if (await isCanceled(run.taskId)) {
        outcome.canceled = true
        opts.onStop()
        return
      }
      // Referer 链：章节页带书页来路；fetchChapterPaged 同章分页（…_2.html / …/2.html）自动拼接
      const ch = await fetchChapterPaged(p.url, rule, p.bookUrl)
      const data = ch.ok ? ch.data : null
      // 入库前统一清洗（去 \r\n/行首缩进/空行/噪声行），存储契约：无空行、无行首缩进
      const cleaned = cleanChapterContent(data?.content ?? '')
      const content = cleaned.text.slice(0, MAX_CONTENT_CHARS)
      if (data && content.trim()) {
        const wordCount = content.replace(/\s/g, '').length
        // content='' 守卫：并发双任务同章时后到者不覆盖先到者已抓正文
        const upd = await db.chapter
          .updateMany({ where: { id: p.chapterId, content: '' }, data: { content, wordCount } })
          .catch(() => null)
        if (upd && upd.count > 0) {
          outcome.stored++
          run.counters.chapters++
        } else {
          outcome.skipped++
        }
        if (ch.warnings.length) run.logWarnings(ch.warnings)
      } else {
        outcome.failed++
        // 骨架行保留（content=''），重跑任务可续采
        run.log(`章节抓取失败「${p.bookTitle.slice(0, 20)}·${(data?.title ?? p.url).slice(0, 30)}」: ${ch.ok ? '正文为空' : ch.error}`)
      }
      const rem = (remaining.get(p.novelId) ?? 1) - 1
      remaining.set(p.novelId, rem)
      if (rem <= 0) await recalcNovelWordCount(p.novelId)
      opts.progress.done++
      if (!(await maybeFlush())) {
        outcome.canceled = true
        opts.onStop()
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONTENT_CONCURRENCY, pending.length)) }, worker))
  if (outcome.canceled) return outcome
  // 收尾兜底：取消/失败遗留的未完成书也要重算字数
  for (const [novelId, rem] of remaining) {
    if (rem > 0) await recalcNovelWordCount(novelId)
  }
  await maybeFlush(true)
  return outcome
}

// ==================== 两种模式 ====================

/** 单本采集：同一本书也走两阶段（meta 建骨架 → 并发回填） */
async function runSingle(run: Run, task: TaskRecord, rule: LoadedRule): Promise<void> {
  const progress = { done: 0, total: 0 }
  const meta = await processBookMeta(run, { title: '', url: task.targetUrl }, null, rule, progress, { trackTotal: true })
  if (meta.canceled) {
    run.log('任务已取消')
    await finalize(run, 'canceled', '任务已取消')
    return
  }
  await run.flush({ created: run.counters.created, updated: run.counters.updated, chapters: run.counters.chapters })
  if (!meta.ok) {
    await finalize(run, 'failed', meta.message || '书页提取失败')
    return
  }
  if (meta.chapterRefs === 0) {
    await finalize(run, 'success', meta.message)
    return
  }
  const fill = await fillChapterContents(run, rule, meta.pending, {
    progress,
    flushFields: () => ({
      done: progress.done,
      created: run.counters.created,
      updated: run.counters.updated,
      chapters: run.counters.chapters,
    }),
    stopped: () => false,
    onStop: () => {},
  })
  if (fill.canceled) {
    run.log('任务已取消')
    await finalize(run, 'canceled', '任务已取消')
    return
  }
  if (fill.stored === 0 && fill.failed === 0) {
    await finalize(run, 'success', '无新增章节（章节均已存在）')
    return
  }
  if (fill.failed === 0) {
    await finalize(run, 'success', `采集完成：${fill.stored} 章`)
    return
  }
  if (fill.stored > 0) {
    await finalize(run, 'partial', `${fill.stored} 章成功 / ${fill.failed} 章失败`)
    return
  }
  await finalize(run, 'failed', '章节采集全部失败')
}

/** 范围采集：列表翻页收集条目 → 阶段1 并发骨架（书+目录先全部支撑起来）→ 阶段2 跨书并发回填 */
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

  /** 条目 → 发现它的列表页 URL（作书页抓取 Referer 来路） */
  const queue: { item: ListItem; referer: string }[] = first.map((item) => ({ item, referer: task.targetUrl }))
  for (let k = 2; k <= task.pages; k++) {
    if (await isCanceled(run.taskId)) break
    let got: ListItem[] | null = null
    let hitUrl = ''
    for (const v of buildPageVariants(rule.listRule, task.targetUrl, k)) {
      const pageItems = await fetchListPage(run, v, rule, task.targetUrl)
      if (pageItems.length > 0) {
        got = pageItems
        hitUrl = v
        run.log(`第 ${k} 页命中: ${v.slice(0, 100)}`)
        break
      }
    }
    if (!got || got.length === 0) {
      run.log(`第 ${k} 页无结果，跳过`)
      continue
    }
    run.log(`第 ${k} 页提取 ${got.length} 条`)
    queue.push(...got.map((item) => ({ item, referer: hitUrl })))
  }

  // 合并去重（按 URL，缺 URL 按标题）
  const seen = new Set<string>()
  const merged: { item: ListItem; referer: string }[] = []
  for (const q of queue) {
    const key = q.item.url ?? `t:${q.item.title}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(q)
  }
  if (merged.length > MAX_BOOKS_PER_TASK) {
    merged.length = MAX_BOOKS_PER_TASK
    run.log(`条目数超出单任务上限（${MAX_BOOKS_PER_TASK}），已截断`)
  }
  const total = merged.length
  await run.flush({ total, done: 0 })
  run.log(`去重后共 ${total} 本书待采集（阶段1：并发抓书页+目录骨架）`)

  // ---- 阶段1：并发书籍元信息 + 骨架 ----
  const progress = { done: 0, total: 0 }
  const pending: PendingChapter[] = []
  let doneBooks = 0
  let okBooks = 0
  let failBooks = 0
  let canceledRun = false
  const phase = { stopped: false }
  const stop = (why: string) => {
    if (!phase.stopped) {
      phase.stopped = true
      canceledRun = true
      run.log(why)
    }
  }
  await runPool(META_CONCURRENCY, merged, async (entry, i) => {
    if (phase.stopped) return
    if (await isCanceled(run.taskId)) return stop('任务已取消，停止书籍抓取')
    run.log(`━━ (${i + 1}/${total}) 《${(entry.item.title || '未命名').slice(0, 30)}》`)
    const meta = await processBookMeta(run, { title: entry.item.title, url: entry.item.url as string }, entry.referer, rule, progress)
    doneBooks++
    if (meta.canceled) return stop(`任务中止（${meta.message}）`)
    if (meta.ok) {
      okBooks++
      pending.push(...meta.pending)
    } else {
      failBooks++
    }
    const okFlush = await run.flush({
      done: doneBooks,
      chaptersDone: progress.done,
      chaptersTotal: progress.total,
      created: run.counters.created,
      updated: run.counters.updated,
      chapters: run.counters.chapters,
    })
    if (!okFlush) stop('任务记录已删除')
  })

  if (canceledRun) {
    await finalize(run, 'canceled', `已取消（完成 ${doneBooks}/${total} 本）`)
    return
  }
  run.log(`阶段1完成：${okBooks} 本成功 / ${failBooks} 本失败，待回填 ${pending.length} 章（阶段2：并发抓正文）`)

  // ---- 阶段2：跨书并发回填章节正文 ----
  const fill = await fillChapterContents(run, rule, pending, {
    progress,
    flushFields: () => ({
      done: doneBooks,
      chaptersDone: progress.done,
      chaptersTotal: progress.total,
      created: run.counters.created,
      updated: run.counters.updated,
      chapters: run.counters.chapters,
    }),
    stopped: () => phase.stopped,
    onStop: () => stop('任务已取消，停止章节回填'),
  })
  if (fill.canceled || canceledRun) {
    await finalize(run, 'canceled', `已取消（回填 ${fill.stored} 章）`)
    return
  }

  // 骨架剩余（抓取失败保留的空行）：可重跑任务续采
  const touched = [...new Set(pending.map((p) => p.novelId))]
  const left = touched.length
    ? await db.chapter.count({ where: { novelId: { in: touched }, content: '' } }).catch(() => 0)
    : 0
  if (left > 0) run.log(`${left} 章内容待回填（骨架已入库，重跑任务可续采）`)

  if (okBooks === 0) {
    await finalize(run, 'failed', '无书籍采集成功')
    return
  }
  if (failBooks > 0) {
    await finalize(run, 'partial', `${okBooks} 本成功 / ${failBooks} 本失败，入库 ${fill.stored} 章`)
    return
  }
  await finalize(run, 'success', `范围采集完成：共 ${total} 本，入库 ${fill.stored} 章`)
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
