/**
 * 采集任务 Worker（服务端专用，勿在客户端 import）
 *
 * - 模块级 running Set 防止同一任务并发重复执行
 * - single 模式：书页 URL → 提取书籍信息 + 章节链接 → upsert 书籍 → 并行抓取章节入库
 * - list 模式：列表页 URL（可设起始页）→ 提取书籍条目（支持 ?page=k / /page/k 翻页变体）→ 并行按 single 流程入库
 * - 无数量硬限制（用户要求取消全部截断）：章节/书籍/列表页数均不设上限；
 *   对源站的节制由引擎层域名限速（默认 ≥1.2s/请求）与任务级并发度（1-16）保证
 * - 并发模型：任务之间天然并行（每次触发独立 worker）；任务内
 *   single=concurrency 路章节并行抓取；list=concurrency 路书籍并行，书内章节再并行
 * - 进度语义：single 模式 done/total=章节（唯一一本书的章节进度）；list 模式 done/total=书
 *   （主口径，done=已完成书数），章节进度单独记录在 chaptersDone/chaptersTotal，
 *   保证任何时刻 done ≤ total
 * - 协作式取消：每个派发点读一次 DB status，canceled 即停止派发，在途工作快速收尾
 * - 僵尸任务回收：进程重启后首次加载本模块时，把残留的 pending/running 任务标记为 failed
 * - 任何异常都不外抛到进程级；最终状态 success / partial / failed / canceled
 * - 正文入库前经 cleanChapterContent 统一清洗（去 \r\n/行首缩进/空行/广告导航噪声行），
 *   wordCount 基于清洗后文本；清洗日志每本书最多记 3 条防刷屏
 * - 书籍入库成功后 fire-and-forget 触发「搜索下拉词绑定 → PSEO 书籍页」（suggest-bind，可配置关闭）
 *
 * 合规红线：仅抓取公开页面；robots 提示与域名限速由 scraper-service 引擎层负责；
 * 正文超长截断仅为内存保护（20 万字符，远超正常章节体量）。
 */
import { db } from '@/lib/db'
import { cleanChapterContent } from '@/lib/content-clean'
import { cleanTextField, cleanDescriptionField } from '@/lib/text-clean'
import { circuitWaitMs, hostOf, withCircuitRetry } from './circuit'
import { fetchBookPage, fetchCatalogChapters, fetchChapterPaged, fetchListPage } from './engine-client'
import { reorderChapterRefs } from './ordering'
import { Run, MAX_LOG_LINES } from './run-log'
import { scheduleBindBookSuggestKeywords } from './suggest-bind'
import { ensureCategory, loadRule, recalcNovelWordCount, storeChapter, upsertBook } from './store'
import type { BookOutcome, ChapterRef, LoadedRule, ListItem, TaskFlushFields, TaskRecord } from './types'

/** 正文超长内存保护截断（200k 字符 ≈ 20 万字，正常章节远达不到；仅防御异常巨型页） */
const MAX_CONTENT_CHARS = 200_000

/** 并发度夹取：1-16（防畸形配置打爆引擎/DB） */
function clampConcurrency(n: unknown, fallback = 3): number {
  const v = Math.round(Number(n))
  return Number.isFinite(v) && v >= 1 ? Math.min(16, v) : fallback
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))

/**
 * 瞬时引擎失败识别：预算耗尽/硬闸超时/引擎超时类错误——多为高并发下的限速排队压力
 * 或网络抖动，稍候重试有较大成功概率；与站点明确拒绝（HTTP 4xx/挑战页/正文为空）相区分。
 */
function isTransientEngineError(error: string | undefined | null): boolean {
  if (!error) return false
  return /预算耗尽|budget-exhausted|超时|timeout|不可达/i.test(error)
}

/**
 * 模块级防并发：同一任务 id 同时只允许一个 worker 实例。
 * 挂在 globalThis 上：dev HMR 重载本模块时新旧实例共享同一 Set，
 * 否则重载后新实例的 running 为空，同一任务可能被二次触发执行。
 */
const gWorker = globalThis as unknown as {
  __scrapeRunning?: Set<number>
  __scrapeRecovered?: boolean
}
const running: Set<number> = (gWorker.__scrapeRunning ??= new Set<number>())

/**
 * 僵尸任务恢复（心跳判定）：worker 常驻在 Next.js 进程内存里（fire-and-forget promise），
 * 进程重启后内存任务丢失，DB 中 status=pending/running 的记录会永久卡死。
 *
 * 判定依据：运行中任务每完成一章/一书都会 flush 触碰 updatedAt（心跳）；真正的僵尸
 * （进程消失/模块实例丢失）updatedAt 停摆。仅回收「仍处 pending/running 且心跳停摆
 * 超过 ZOMBIE_STALE_MS」的任务——不按 createdAt/进程启动时刻判定，因为 dev 下
 * Turbopack 每个路由 bundle 各有一份本模块实例，任何晚加载实例的时钟基线都不同，
 * 按创建时刻会把「重跑老任务」等活任务误杀（实测踩坑）。
 * 心跳最长间隙 = 引擎单请求预算 60s + 落库时间，远小于 5 分钟阈值。
 *
 * 防重入标志同步置位（await 前置位）：dev 下同进程可能存在多份模块实例
 * （Turbopack 按路由分包），异步置位会留下双重回收的竞态窗口。
 */
const ZOMBIE_STALE_MS = 5 * 60_000

async function recoverStaleTasks(): Promise<void> {
  if (gWorker.__scrapeRecovered) return
  gWorker.__scrapeRecovered = true // 同步置位：跨实例/跨 HMR 防重入
  try {
    const stale = await db.scrapeTask.findMany({
      where: {
        status: { in: ['pending', 'running'] },
        updatedAt: { lt: new Date(Date.now() - ZOMBIE_STALE_MS) },
      },
      select: { id: true, log: true },
    })
    let recovered = 0
    for (const t of stale) {
      if (running.has(t.id)) continue // 本进程内存中仍有实例在执行（共享 Set 时双保险）
      const line = `[${new Date().toTimeString().slice(0, 8)}] 心跳停摆超 5 分钟，判定僵尸任务并回收`
      const log = `${t.log ? `${t.log}\n` : ''}${line}`
      const res = await db.scrapeTask
        .updateMany({
          where: { id: t.id, status: { in: ['pending', 'running'] } },
          data: {
            status: 'failed',
            message: '任务心跳超时，自动回收',
            // 与 Run 同规约：只保留最近 100 行
            log: log.split('\n').slice(-MAX_LOG_LINES).join('\n'),
          },
        })
        .catch(() => null)
      if (res && res.count > 0) recovered++
    }
    if (recovered > 0) console.log(`[scrape-worker] 僵尸任务回收: ${recovered} 条`)
  } catch {
    // 回收失败不影响模块加载；标志已置位，等待下次进程重启重试（代价可接受：僵尸多驻留一轮）
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

/**
 * 并行池：cursor 抢占式派发，concurrency 路 worker 持续取件直至耗尽。
 * fn 内部通过 stop signal 提前收敛（停止派发，在途任务跑完当前单元后自然退出）。
 */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
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
 * 抓取一个书页并入库（含并行章节抓取）。
 * - 新书 created+1 / 已有书 updated+1（按 title+author 查重，结果记入 run.counters）
 * - 章节 idx 按目录顺序预分配槽位（base+目录位次，保序），并行抓取、按槽位入库
 * - 入库成功后异步触发下拉词绑定 → PSEO 书籍页（不阻塞章节抓取）
 * - 进度写入：
 *   - trackTotal=true（single 模式）：章节总数写入 task.total，done 随章节递增（done/total=章节，主口径）
 *   - trackTotal=false（list 模式）：done/total 由调用方按「书」维护，本函数不碰；
 *     章节进度累加进共享的 opts.chapterProgress（chaptersDone/chaptersTotal）并随写盘刷出
 */
async function processBook(
  run: Run,
  bookUrl: string,
  rule: LoadedRule,
  opts: { trackTotal: boolean; chapterProgress?: { done: number; total: number }; referer?: string | null; concurrency: number },
): Promise<BookOutcome> {
  const canceledOutcome = (message: string, chapters = 0, failedChapters = 0): BookOutcome => ({
    ok: false,
    canceled: true,
    chapters,
    failedChapters,
    message,
  })

  run.log(`抓取书页 ${bookUrl.slice(0, 120)}…`)
  // Referer 链：list 模式传「发现本书的列表页」作来路；single 模式缺省由引擎回落站内首页。
  // 熔断感知：书页撞上熔断（站点临时限流封禁）时等待冷却后自动重试，而非立即把本书记失败
  const page = await withCircuitRetry(hostOf(bookUrl), () => fetchBookPage(run, bookUrl, rule, opts.referer ?? undefined), {
    detect: (r) => (r.ok ? null : circuitWaitMs(r.error, r.circuitRetryAfterMs)),
    isAlive: async () => !(await isCanceled(run.taskId)),
    onWait: (ms, cycle, max) =>
      run.log(`目标主机熔断冷却中，暂停 ${Math.round(ms / 1000)}s 后自动重试书页（第 ${cycle}/${max} 轮，等待期间不向源站发请求）`),
  })
  if (!page.ok) {
    run.log(`书页提取失败: ${page.error}`)
    return { ok: false, canceled: false, chapters: 0, failedChapters: 0, message: page.error }
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
  // 全字段兜底清洗（引擎侧已清洗，此处防版本错位/旧引擎，幂等成本低）：
  // 实体解码（&#091；类全角分号变体）、字面 \n 还原、残缺标签剥除、简介样板句/SEO 伪简介处理
  book.title = cleanTextField(book.title)
  book.author = cleanTextField(book.author)
  book.description = cleanDescriptionField(book.description)
  book.category = cleanTextField(book.category)
  book.status = cleanTextField(book.status)
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
      const catalogUrl = book.catalogUrl // 闭包捕获需局部常量（TS 收窄不跨回调）
      // 熔断感知：目录页撞熔断时等待冷却后自动重试（超限时按旧语义回退书页章节链接）
      const catalog = await withCircuitRetry(
        hostOf(catalogUrl),
        () => fetchCatalogChapters(run, catalogUrl, rule, bookUrl),
        {
          detect: (r) => (r.error ? circuitWaitMs(r.error) : null),
          isSuccess: (r) => r.error === null,
          isAlive: async () => !(await isCanceled(run.taskId)),
          onWait: (ms, cycle, max) =>
            run.log(`目标主机熔断冷却中，暂停 ${Math.round(ms / 1000)}s 后自动重试目录页（第 ${cycle}/${max} 轮）`),
        },
      )
      const catalogRefs = catalog.refs
      if (catalogRefs.length > allRefs.length) {
        run.log(`目录页提取到 ${catalogRefs.length} 条章节链接（书页仅 ${allRefs.length} 条），采用目录页结果`)
        allRefs = catalogRefs
      } else if (catalogRefs.length > 0) {
        run.log(`目录页提取 ${catalogRefs.length} 条不多于书页 ${allRefs.length} 条，维持书页结果`)
      }
    } else {
      run.log(`catalogLinkSelector "${catalogSel.slice(0, 60)}" 在书页无命中，仅用书页章节链接`)
    }
  }

  if (await isCanceled(run.taskId)) return canceledOutcome('任务已取消')

  // ---- 乱序重排（充分考虑分卷：同号不同卷不跨卷错排，卷名随章节移动）----
  // 源站目录常见「最新章节块（新→旧）+ 正文块（旧→新）」或整本倒序；直接按抓取序编 idx 会错乱。
  // 引擎响应未经 schema 校验，逐条形态兑底后再重排。
  allRefs = (Array.isArray(allRefs) ? allRefs : []).map((c) => ({
    title: typeof c?.title === 'string' ? c.title : '',
    url: typeof c?.url === 'string' ? c.url : null,
    volume: typeof c?.volume === 'string' && c.volume.trim() ? c.volume.trim().slice(0, 50) : undefined,
  })) as ChapterRef[]
  const rr = reorderChapterRefs(allRefs)
  if (rr.reordered) {
    allRefs = rr.refs
    run.log(`目录乱序重排：${rr.note}`)
  }

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
  const up = await upsertBook(run, book, categoryId, rule.proxy)
  if (!up.ok) {
    // 记录级失败（up.canceled=true：入库/更新失败、并发冲突后找不到记录）沿用取消通道停整个任务；
    // 书籍级失败（up.canceled=false，如空标题）只算本书失败：single 按 failed 收尾，list 继续下一本
    if (up.canceled) return canceledOutcome(up.message)
    return { ok: false, canceled: false, chapters: 0, failedChapters: 0, message: up.message }
  }
  // 采集的同时取搜索引擎下拉词 → 绑定书籍 + 生成 PSEO 书籍页（fire-and-forget，不阻塞章节抓取）
  scheduleBindBookSuggestKeywords(run, up.novelId, up.title || book.title, up.createdNew)

  // ---- 章节列表准备 ----
  const refs = allRefs.filter(
    (c): c is ChapterRef & { url: string } => !!c && typeof c.url === 'string' && !!c.url,
  )
  if (refs.length === 0) {
    run.log('未提取到任何有效章节链接')
    return { ok: true, canceled: false, chapters: 0, failedChapters: 0, message: '书籍已入库（未提取到章节链接）' }
  }
  // 同目录内预去重（并行抓取前完成）：按清洗后标题优先、URL 兜底去重，防同批重复入库
  const seenRef = new Set<string>()
  const uniqueRefs: (ChapterRef & { url: string })[] = []
  for (const c of refs) {
    const key = c.title.trim() ? `t:${cleanTextField(c.title)}` : `u:${c.url}`
    if (seenRef.has(key)) continue
    seenRef.add(key)
    uniqueRefs.push(c)
  }
  if (uniqueRefs.length < refs.length) run.log(`目录内去重：${refs.length} → ${uniqueRefs.length} 条（无数量上限，全量采集）`)

  if (opts.trackTotal) {
    // single 模式：进度主口径=本章节数，total 为分母（flush false=任务记录已删，立即停）
    if (!(await run.flush({ total: uniqueRefs.length }))) return canceledOutcome('任务记录已删除')
  } else if (opts.chapterProgress) {
    // list 模式：章节进度独立于 done/total（书）累计
    opts.chapterProgress.total += uniqueRefs.length
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
    .findMany({ where: { novelId: up.novelId }, select: { title: true, volume: true } })
    .catch(() => [] as { title: string; volume: string }[])
  // 去重键与入库标题共用同一清洗规约（cleanTextField 幂等）：存量脏标题与本次净标题可命中比对，
  // 避免清洗规约升级后同一章以两种写法重复入库
  const existingTitles = new Set(existingChapters.map((c) => cleanTextField(c.title)))
  // 同书内标题计数：用于「已存在章节」的卷名回填防误伤（重名章不回填）
  const existingTitleCount = new Map<string, number>()
  for (const c of existingChapters) {
    const k = cleanTextField(c.title)
    existingTitleCount.set(k, (existingTitleCount.get(k) ?? 0) + 1)
  }
  /** 已存在章节的卷名回填队列（title → volume；仅唯一标题且存量为空卷时写入） */
  const volumeBackfill = new Map<string, string>()
  const maxAgg = await db.chapter
    .aggregate({ where: { novelId: up.novelId }, _max: { idx: true } })
    .catch(() => ({ _max: { idx: null as number | null } }))
  // 章节槽位基准：现有最大 idx+1；每条按目录位次预分配（base+位次），保序且并行安全
  const baseIdx = (maxAgg._max.idx ?? 0) + 1

  // ---- 并行章节抓取入库 ----
  let done = 0
  let chaptersStored = 0
  let failedChapters = 0
  let cleanLogCount = 0 // 清洗日志节流：每本书最多记 3 条，防止日志爆炸
  let stopRun = false // 取消/记录删除 → 停止派发新章节，在途章节收尾后退出

  const alive = async (): Promise<boolean> => {
    if (stopRun) return false
    return !(await isCanceled(run.taskId))
  }

  // flush 串行链：并行分支共享 Run 缓冲与进度字段，写盘串行化避免交错/竞态
  let flushChain = Promise.resolve(true)
  const scheduleFlush = (fields: TaskFlushFields): Promise<boolean> => {
    flushChain = flushChain.then(async (ok) => {
      if (!ok || stopRun) return false
      const ok2 = await run.flush(fields)
      if (!ok2) stopRun = true // 任务记录被删除 → 全池停止派发
      return ok2
    })
    return flushChain
  }

  const processRef = async (ref: ChapterRef & { url: string }, position: number): Promise<void> => {
    const refTitle = cleanTextField(String(ref.title ?? '')).slice(0, 200)
    if (refTitle && existingTitles.has(refTitle)) {
      done++
      if (opts.chapterProgress) opts.chapterProgress.done++
      run.log(`章节「${refTitle.slice(0, 30)}」已存在，跳过`)
      // 分卷补齐：本次源站目录携带卷名、存量章节为空卷且标题在全书中唯一时，回填卷名
      const rv = ref.volume
      if (rv && existingTitleCount.get(refTitle) === 1 && !volumeBackfill.has(refTitle)) {
        volumeBackfill.set(refTitle, rv)
      }
      await scheduleFlush(progressFields())
      return
    }

    if (!(await alive())) {
      stopRun = true
      return
    }
    run.log(`抓取章节「${(refTitle || ref.url).slice(0, 36)}」`)
    // Referer 链：章节页带书页来路（站点常见「书页→章节」导航校验）；
    // fetchChapterPaged：同章分页（…_2.html / …/2.html）自动翻页拼接，避免长章只存半页。
    // 熔断感知：章节撞熔断（站点临时限流封禁）时同主机并发 worker 合流等待冷却后自动重试，
    // 而非把剩余章节全部烧成失败（Task 36 复盘：ggd66 一次临时封禁曾致 232 章被永久记失败）
    const circuitFetch = (): ReturnType<typeof fetchChapterPaged> =>
      withCircuitRetry(hostOf(ref.url), () => fetchChapterPaged(ref.url, rule, bookUrl), {
        detect: (r) => (r.ok ? null : circuitWaitMs(r.error, r.circuitRetryAfterMs)),
        isAlive: alive,
        onWait: (ms, cycle, max) =>
          run.log(`目标主机熔断冷却中，暂停 ${Math.round(ms / 1000)}s 后自动重试章节（第 ${cycle}/${max} 轮，等待期间不向源站发请求）`),
      })
    let ch = await circuitFetch()
    // 瞬时失败单次重试（预算耗尽/超时类）：高并发下域名限速排队可吃光引擎 55s 链预算，
    // 属暂时性压力而非站点拒绝——稍候片刻让队列排空后重试一次，减少无谓的永久失败章节
    if (!ch.ok && isTransientEngineError(ch.error)) {
      run.log(`章节「${(refTitle || ref.url).slice(0, 30)}」因引擎预算耗尽/超时失败，稍候重试一次`)
      await sleep(3_000 + Math.random() * 5_000)
      if (stopRun || !(await alive())) return
      ch = await circuitFetch()
    }
    if (stopRun || !(await alive())) return // 取消：抓取结果直接丢弃，尽快退出
    const data = ch.ok ? ch.data : null

    // 入库前统一清洗（去 \r\n/行首缩进/空行/噪声行），存储契约：无空行、无行首缩进
    const cleaned = cleanChapterContent(data?.content ?? '')
    let content = cleaned.text
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS)
      run.log(`章节正文超长（>${MAX_CONTENT_CHARS} 字符），截断保存（内存保护）`)
    }

    if (!data || !content.trim()) {
      failedChapters++
      done++
      if (opts.chapterProgress) opts.chapterProgress.done++
      run.log(`章节抓取失败: ${ch.ok ? '正文为空' : ch.error}`)
      await scheduleFlush({ ...progressFields(), chapters: run.counters.chapters })
      return
    }
    if (ch.warnings.length) run.logWarnings(ch.warnings)

    const idx = baseIdx + position // 槽位保序：目录顺序即阅读顺序
    const chTitle = (refTitle || cleanTextField(data.title) || `第${idx}章`).slice(0, 200)
    if (cleaned.removedLines > 0 && cleanLogCount < 3) {
      cleanLogCount++
      run.log(`章节「${chTitle.slice(0, 30)}」清洗 ${cleaned.removedLines} 行噪声`)
    }
    const wordCount = content.replace(/\s/g, '').length
    // storeChapter 内部处理 idx 唯一冲突顺延重试（并发任务写同书等场景）
    const stored = await storeChapter(run, up.novelId, idx, {
      title: chTitle,
      content,
      wordCount,
      volume: ref.volume ?? '',
    })
    if (stored.ok) {
      existingTitles.add(chTitle)
      chaptersStored++
      run.counters.chapters++
    } else {
      run.log(`章节入库失败: ${stored.message.slice(0, 120)}`)
      failedChapters++
    }
    done++
    if (opts.chapterProgress) opts.chapterProgress.done++
    await scheduleFlush({ ...progressFields(), chapters: run.counters.chapters })
  }

  await runPool(uniqueRefs, clampConcurrency(opts.concurrency), processRef)
  const flushOk = await flushChain
  if (stopRun || !flushOk) {
    run.log('任务已取消/记录已删除，停止章节抓取')
    await recalcNovelWordCount(up.novelId) // 取消点前已入库章节，重算字数保持一致性
    await run.flush({ ...progressFields(), chapters: run.counters.chapters }).catch(() => undefined)
    return canceledOutcome('任务已取消', chaptersStored, failedChapters)
  }

  // ---- 已存在章节的卷名回填（逐卷 updateMany，仅在唯一标题且存量空卷时入队）----
  if (volumeBackfill.size > 0) {
    let backfilled = 0
    for (const [title, volume] of volumeBackfill) {
      const res = await db.chapter
        .updateMany({ where: { novelId: up.novelId, title, volume: '' }, data: { volume } })
        .catch(() => null)
      if (res) backfilled += res.count
    }
    if (backfilled > 0) run.log(`分卷回填：${backfilled} 个已存在章节补记卷名`)
  }

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
  const outcome = await processBook(run, task.targetUrl, rule, { trackTotal: true, concurrency: task.concurrency })
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
  const startPage = Math.max(1, Math.floor(task.startPage) || 1)
  const endPage = startPage + Math.max(1, task.pages) - 1
  run.log(`抓取列表页第 ${startPage} 页…`)
  // 熔断感知：起始列表页撞熔断时等待冷却后自动重试；抓取失败（超限）与「空列表页」自此可区分
  const firstPage = await withCircuitRetry(hostOf(task.targetUrl), () => fetchListPage(run, task.targetUrl, rule), {
    detect: (r) => (r.error ? circuitWaitMs(r.error) : null),
    isSuccess: (r) => r.error === null,
    isAlive: async () => !(await isCanceled(run.taskId)),
    onWait: (ms, cycle, max) =>
      run.log(`目标主机熔断冷却中，暂停 ${Math.round(ms / 1000)}s 后自动重试列表页（第 ${cycle}/${max} 轮，等待期间不向源站发请求）`),
  })
  const first = firstPage.items
  if (await isCanceled(run.taskId)) {
    await finalize(run, 'canceled', '任务已取消')
    return
  }
  if (firstPage.error) {
    run.log('起始列表页持续抓取失败（熔断等待轮数耗尽或持续失败），任务终止')
    await finalize(run, 'failed', `列表页抓取失败: ${firstPage.error.slice(0, 180)}`)
    return
  }
  if (first.length === 0) {
    run.log('列表页未提取到书籍条目')
    await finalize(run, 'failed', '列表页未提取到书籍条目')
    return
  }
  run.log(`第 ${startPage} 页提取 ${first.length} 条`)

  const items = [...first]
  // 当前生效的列表页 URL（含翻页命中页）：作为后续书页抓取的 Referer 来路
  let currentListUrl = task.targetUrl
  for (let k = startPage + 1; k <= endPage; k++) {
    if (await isCanceled(run.taskId)) break
    let got: ListItem[] | null = null
    for (const v of pageVariants(task.targetUrl, k)) {
      // 熔断感知：翻页变体撞熔断时等待冷却后自动重试；变体持续失败 → 尝试下一变体
      const pv = await withCircuitRetry(hostOf(v), () => fetchListPage(run, v, rule), {
        detect: (r) => (r.error ? circuitWaitMs(r.error) : null),
        isSuccess: (r) => r.error === null,
        isAlive: async () => !(await isCanceled(run.taskId)),
        onWait: (ms, cycle, max) =>
          run.log(`目标主机熔断冷却中，暂停 ${Math.round(ms / 1000)}s 后自动重试列表页（第 ${cycle}/${max} 轮）`),
      })
      if (pv.error) continue
      if (pv.items.length > 0) {
        got = pv.items
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

  // 合并去重（按 URL，缺 URL 按标题）；不设书籍数量上限，全量采集
  const seen = new Set<string>()
  const merged: ListItem[] = []
  for (const it of items) {
    const key = it.url ?? `t:${it.title}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(it)
  }
  const total = merged.length
  await run.flush({ total, done: 0 })
  run.log(`去重后共 ${total} 本书待采集（并发 ${task.concurrency} 路书籍并行，书内章节再并行）`)

  let doneBooks = 0
  let okBooks = 0
  let failBooks = 0
  let stopRun = false
  // 任务级章节进度（跨书累计）：list 模式 done/total 主口径是「书」，章节进度走 chaptersDone/chaptersTotal
  const chapterProgress = { done: 0, total: 0 }
  // flush 串行链：并行书籍分支的进度写盘串行化
  let flushChain = Promise.resolve(true)
  const scheduleBookFlush = (): Promise<boolean> => {
    flushChain = flushChain.then(async (ok) => {
      if (!ok || stopRun) return false
      const ok2 = await run.flush({
        done: doneBooks,
        chaptersDone: chapterProgress.done,
        chaptersTotal: chapterProgress.total,
        created: run.counters.created,
        updated: run.counters.updated,
        chapters: run.counters.chapters,
      })
      if (!ok2) stopRun = true
      return ok2
    })
    return flushChain
  }

  const processItem = async (item: ListItem): Promise<void> => {
    if (stopRun) return
    if (await isCanceled(run.taskId)) {
      stopRun = true
      return
    }
    run.log(`━━ 《${(item.title || '未命名').slice(0, 30)}》`)
    const outcome = await processBook(run, item.url as string, rule, {
      trackTotal: false,
      chapterProgress,
      referer: currentListUrl,
      concurrency: task.concurrency,
    })
    doneBooks++
    if (outcome.canceled) stopRun = true // 取消传播：停止派发后续书籍
    else if (outcome.ok) okBooks++
    else failBooks++
    await scheduleBookFlush()
  }

  await runPool(merged, clampConcurrency(task.concurrency), processItem)
  const flushOk = await flushChain

  if (stopRun || !flushOk) {
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
    run.ruleId = task.ruleId ?? null // 封面回填链路：入库时记入 Novel.sourceRuleId
    const record: TaskRecord = {
      id: task.id,
      mode: task.mode,
      targetUrl: task.targetUrl,
      pages: task.pages,
      startPage: task.startPage,
      concurrency: clampConcurrency(task.concurrency),
      ruleId: task.ruleId,
    }
    const rule = await loadRule(record.ruleId)
    run.log(
      record.mode === 'list'
        ? `任务开始（范围采集）目标: ${record.targetUrl}，起始页: ${record.startPage}，页数: ${record.pages}，并发: ${record.concurrency}`
        : `任务开始（单本采集）目标: ${record.targetUrl}，并发: ${record.concurrency}`,
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

/**
 * fire-and-forget 入口：API 路由创建任务后调用，不 await。
 * 多任务天然并行：每个任务独立 worker promise，互不阻塞；
 * 对同一目标站的压力由引擎层域名限速统一收敛。
 */
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
