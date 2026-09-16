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
 *
 * 合规红线：仅抓取公开页面；robots 提示与域名限速由 scraper-service 引擎层负责；
 * 单本章节上限 100、单任务书籍上限 60、正文 5 万字截断，防止滥用。
 */
import { db } from '@/lib/db'

const SCRAPER_BASE = 'http://127.0.0.1:3030'
// 引擎策略链整体预算 55s（CHAIN_BUDGET_MS），超时须 ≥ 预算否则慢站点会被提前切断；与 /api/scrape 代理的 60s 对齐
const ENGINE_TIMEOUT_MS = 60_000
const MAX_CHAPTERS_PER_BOOK = 100
const MAX_BOOKS_PER_TASK = 60
const MAX_CONTENT_CHARS = 50_000
const MAX_LOG_LINES = 100
const MAX_WARNINGS_LOGGED = 3

/** 模块级防并发：同一任务 id 同时只允许一个 worker 实例 */
const running = new Set<number>()

// ==================== 类型 ====================

type RuleMap = Record<string, string>

interface LoadedRule {
  name?: string
  charset?: string
  listRule: RuleMap
  bookRule: RuleMap
  chapterRule: RuleMap
}

interface ChapterRef {
  title: string
  url: string | null
}

interface BookData {
  title: string
  author: string
  description: string
  cover: string | null
  status: string
  category: string
  chapterCount: number
  chapters: ChapterRef[]
}

interface ListItem {
  title: string
  url: string | null
  author: string
  category: string
}

interface ChapterData {
  title: string
  content: string
  wordCount: number
  nextUrl: string | null
}

interface TaskRecord {
  id: number
  mode: string
  targetUrl: string
  pages: number
  ruleId: number | null
}

interface BookOutcome {
  ok: boolean // 书籍是否成功入库（含"已入库但无章节链接"）
  canceled: boolean // 任务被取消/记录被删除
  chapters: number // 本次入库章节数
  failedChapters: number
  message: string
}

type EngineResult<T> =
  | { ok: true; data: T; warnings: string[] }
  | { ok: false; error: string; warnings: string[] }

// ==================== 运行日志 ====================

function ts(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

class Run {
  readonly taskId: number
  private lines: string[] = []
  /** 任务级成果计数（跨多本书累积） */
  counters = { created: 0, updated: 0, chapters: 0 }

  constructor(taskId: number) {
    this.taskId = taskId
  }

  log(msg: string): void {
    this.lines.push(`[${ts()}] ${msg}`.slice(0, 500))
    if (this.lines.length > MAX_LOG_LINES) this.lines = this.lines.slice(-MAX_LOG_LINES)
  }

  logWarnings(warnings: unknown[]): void {
    for (const w of warnings.slice(0, MAX_WARNINGS_LOGGED)) this.log(`引擎提示: ${String(w).slice(0, 200)}`)
  }

  logText(): string {
    return this.lines.join('\n')
  }

  /** 写回日志与进度字段；任务记录被删除时返回 false（调用方应停止执行）
   *
   * chaptersDone/chaptersTotal 走 $executeRaw 兜底：长期运行的 dev 进程可能仍持有
   * schema 变更前生成的 Prisma Client（globalThis 单例 + require 缓存，不重启无法刷新），
   * 类型化 update 会报 Unknown field；原生 SQL 不依赖 client 的 dmmf，新旧 client 下均正确。
   * （SQLite 无 @map，列名与字段名一致）
   */
  async flush(extra?: Record<string, unknown>): Promise<boolean> {
    try {
      const { chaptersDone, chaptersTotal, ...rest } = extra ?? {}
      await db.scrapeTask.update({
        where: { id: this.taskId },
        data: { log: this.logText(), ...(rest as Record<string, unknown>) },
      })
      if (chaptersDone !== undefined || chaptersTotal !== undefined) {
        await db.$executeRaw`
          UPDATE "ScrapeTask"
          SET "chaptersDone" = ${Number(chaptersDone ?? 0)}, "chaptersTotal" = ${Number(chaptersTotal ?? 0)}
          WHERE "id" = ${this.taskId}
        `
      }
      return true
    } catch {
      return false
    }
  }
}

// ==================== 基础工具 ====================

/** 协作式取消检查：记录不存在视为取消；DB 瞬时错误不误判为取消（fail-open） */
async function isCanceled(taskId: number): Promise<boolean> {
  const t = await db.scrapeTask
    .findUnique({ where: { id: taskId }, select: { status: true } })
    .catch(() => undefined)
  if (t === undefined) return false // 查询失败 ≠ 被取消，避免瞬时 DB 错误误停任务
  return !t || t.status === 'canceled'
}

/** 调用 scraper-service；网络异常/超时/非 2xx 一律返回结构化失败，绝不 throw */
async function callEngine<T>(path: string, body: Record<string, unknown>): Promise<EngineResult<T>> {
  try {
    const res = await fetch(`${SCRAPER_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json) return { ok: false, error: `引擎响应解析失败(HTTP ${res.status})`, warnings: [] }
    const warnings = Array.isArray(json.warnings) ? json.warnings.map(String) : []
    if (!res.ok || json.ok === false) {
      const base = String(json.error ?? `HTTP ${res.status}`)
      const detail = json.detail ? String(json.detail).slice(0, 200) : ''
      return { ok: false, error: detail ? `${base}（${detail}）` : base, warnings }
    }
    return { ok: true, data: json.data as T, warnings }
  } catch (e) {
    const timedOut =
      e instanceof Error && (/timeout|abort/i.test(e.message) || (e as { name?: string }).name === 'TimeoutError')
    return {
      ok: false,
      error: timedOut ? `引擎请求超时(${ENGINE_TIMEOUT_MS / 1000}s)` : '采集引擎不可达(3030)',
      warnings: [],
    }
  }
}

function safeParseRule(json: string | null | undefined): RuleMap {
  if (!json) return {}
  try {
    const v = JSON.parse(json) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: RuleMap = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && val.trim()) out[k] = val.trim().slice(0, 300)
      }
      return out
    }
    return {}
  } catch {
    return {}
  }
}

async function loadRule(ruleId: number | null): Promise<LoadedRule> {
  if (!ruleId) return { listRule: {}, bookRule: {}, chapterRule: {} }
  const r = await db.scrapeRule.findUnique({ where: { id: ruleId } }).catch(() => null)
  if (!r) return { listRule: {}, bookRule: {}, chapterRule: {} }
  return {
    name: r.name,
    charset: r.charset ? r.charset.toLowerCase() : undefined,
    listRule: safeParseRule(r.listRule),
    bookRule: safeParseRule(r.bookRule),
    chapterRule: safeParseRule(r.chapterRule),
  }
}

async function ensureCategory(name: string): Promise<number> {
  const clean = (name || '').replace(/\s+/g, ' ').trim().slice(0, 50) || '未分类'
  const found = await db.category.findUnique({ where: { name: clean } }).catch(() => null)
  if (found) return found.id
  try {
    const created = await db.category.create({ data: { name: clean } })
    return created.id
  } catch {
    // 并发创建撞唯一约束 → 重查
    const again = await db.category.findUnique({ where: { name: clean } }).catch(() => null)
    if (!again) throw new Error(`分类「${clean}」创建失败`)
    return again.id
  }
}

/** Prisma 唯一约束冲突（P2002）或 SQLite unique 错误 */
function isUniqueConflict(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return (e as { code?: string }).code === 'P2002' || /unique|constraint/i.test(e.message)
}

function mapNovelStatus(raw: string): 'serial' | 'finished' {
  return /完|fin/i.test(raw) ? 'finished' : 'serial'
}

const COVER_TOKENS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10', 'g11', 'g12']

/** 生成第 k 页候选 URL：?page=k（已有 query 则 &page=k）与 /page/k 两种变体 */
export function pageVariants(url: string, k: number): string[] {
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

// ==================== 引擎调用封装 ====================

async function fetchBookPage(
  run: Run,
  url: string,
  rule: LoadedRule,
): Promise<{ ok: true; book: BookData } | { ok: false; error: string }> {
  const res = await callEngine<{ book?: BookData }>('/api/test', {
    url,
    rule: { bookRule: rule.bookRule },
    charset: rule.charset,
  })
  if (!res.ok) return { ok: false, error: res.error }
  if (res.warnings.length) run.logWarnings(res.warnings)
  const book = res.data.book
  if (!book || !book.title) return { ok: false, error: '未提取到书籍标题（规则与内置回退均未命中）' }
  return { ok: true, book }
}

async function fetchListPage(run: Run, url: string, rule: LoadedRule): Promise<ListItem[]> {
  const res = await callEngine<{ list?: { items?: ListItem[] } }>('/api/test', {
    url,
    rule: { listRule: rule.listRule },
    charset: rule.charset,
  })
  if (!res.ok) {
    run.log(`列表页抓取失败(${url.slice(0, 100)}): ${res.error}`)
    return []
  }
  if (res.warnings.length) run.logWarnings(res.warnings)
  return (res.data.list?.items ?? []).filter((it) => !!it.url)
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
  opts: { trackTotal: boolean; chapterProgress?: { done: number; total: number } },
): Promise<BookOutcome> {
  const canceledOutcome = (message: string, chapters = 0, failedChapters = 0): BookOutcome => ({
    ok: false,
    canceled: true,
    chapters,
    failedChapters,
    message,
  })

  run.log(`抓取书页 ${bookUrl.slice(0, 120)}…`)
  const page = await fetchBookPage(run, bookUrl, rule)
  if (!page.ok) {
    run.log(`书页提取失败: ${page.error}`)
    return { ok: false, canceled: false, chapters: 0, failedChapters: 0, message: page.error }
  }
  const book = page.book
  run.log(
    `书页提取成功：《${book.title.slice(0, 40)}》${book.author ? ` / ${book.author.slice(0, 20)}` : ''}，章节链接 ${book.chapterCount} 条`,
  )

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

  // ---- 书籍 upsert（title+author 查重，先 trim 规范化再截断；DB 层 @@unique([title,author]) 兜底并发）----
  const title = (book.title || '').trim().slice(0, 200)
  if (!title) {
    return { ok: false, canceled: false, chapters: 0, failedChapters: 0, message: '书籍标题为空，入库中止' }
  }
  const author = ((book.author || '').trim() || '佚名').slice(0, 100)

  let novelId: number
  let createdNew = false
  const existing = await db.novel.findFirst({ where: { title, author }, select: { id: true } }).catch(() => null)
  if (existing) {
    novelId = existing.id
  } else {
    try {
      const row = await db.novel.create({
        data: {
          title,
          author,
          description: book.description.slice(0, 2000),
          cover: COVER_TOKENS[Math.floor(Math.random() * COVER_TOKENS.length)],
          categoryId,
          status: mapNovelStatus(book.status),
        },
      })
      novelId = row.id
      createdNew = true
    } catch (e) {
      if (!isUniqueConflict(e)) {
        run.log(`书籍入库失败: ${e instanceof Error ? e.message.slice(0, 120) : '未知错误'}`)
        return canceledOutcome('书籍入库失败')
      }
      // 并发另一任务已抢先创建同一本书（撞 @@unique([title,author])）→ 回读命中查重，走更新路径
      const winner = await db.novel.findFirst({ where: { title, author }, select: { id: true } }).catch(() => null)
      if (!winner) return canceledOutcome('书籍入库失败（并发冲突后未找到记录）')
      novelId = winner.id
      run.log(`并发入库冲突，命中已有书籍 #${novelId}`)
    }
  }
  if (createdNew) {
    run.counters.created++
    run.log(`新建书籍 #${novelId}《${title.slice(0, 30)}》`)
  } else {
    const okUpd = await db.novel
      .update({
        where: { id: novelId },
        data: {
          description: book.description.slice(0, 2000),
          categoryId,
          status: mapNovelStatus(book.status),
        },
      })
      .then(() => true)
      .catch(() => false)
    if (!okUpd) return canceledOutcome('书籍更新失败（记录可能已被删除）')
    run.counters.updated++
    run.log(`书籍已存在，更新信息（#${novelId}）`)
  }

  // ---- 章节列表准备 ----
  const refs = book.chapters.filter((c): c is { title: string; url: string } => !!c.url)
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
  const progressFields = (): Record<string, number> =>
    opts.trackTotal
      ? { done }
      : {
          chaptersDone: opts.chapterProgress?.done ?? 0,
          chaptersTotal: opts.chapterProgress?.total ?? 0,
        }

  const existingChapters = await db.chapter
    .findMany({ where: { novelId }, select: { title: true } })
    .catch(() => [] as { title: string }[])
  const existingTitles = new Set(existingChapters.map((c) => c.title))
  const maxAgg = await db.chapter
    .aggregate({ where: { novelId }, _max: { idx: true } })
    .catch(() => ({ _max: { idx: null as number | null } }))
  let idx = (maxAgg._max.idx ?? 0) + 1

  // ---- 逐章抓取入库 ----
  let done = 0
  let chaptersStored = 0
  let failedChapters = 0
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

    run.log(`(${done + 1}/${refs.length}) 抓取章节「${(refTitle || ref.url!).slice(0, 36)}」`)
    const ch = await callEngine<ChapterData>('/api/chapter', {
      url: ref.url,
      rule: rule.chapterRule,
      charset: rule.charset,
    })
    const data = ch.ok ? ch.data : null
    const content = (data?.content ?? '').slice(0, MAX_CONTENT_CHARS)

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
    const wordCount = content.replace(/\s/g, '').length
    const storeAt = (idxVal: number): Promise<true | Error> =>
      db.chapter
        .create({ data: { novelId, idx: idxVal, title: chTitle, content, wordCount } })
        .then(() => true as const)
        .catch((e: unknown) => (e instanceof Error ? e : new Error('章节入库失败')))
    // 唯一冲突（P2002，如并发任务写同一本书）时跳过被占用的 idx 重试一次，
    // 避免序号停滞导致后续所有章节连锁失败
    let stored = await storeAt(idx)
    if (stored !== true && isUniqueConflict(stored)) {
      run.log(`章节序号 ${idx} 已被占用，顺延重试`)
      idx++
      stored = await storeAt(idx)
    }
    if (stored === true) {
      existingTitles.add(chTitle)
      idx++
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
  const sum = await db.chapter
    .aggregate({ where: { novelId }, _sum: { wordCount: true } })
    .catch(() => ({ _sum: { wordCount: null as number | null } }))
  await db.novel
    .update({ where: { id: novelId }, data: { wordCount: sum._sum.wordCount ?? 0 } })
    .catch(() => {})

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
  for (let k = 2; k <= task.pages; k++) {
    if (await isCanceled(run.taskId)) break
    let got: ListItem[] | null = null
    for (const v of pageVariants(task.targetUrl, k)) {
      const pageItems = await fetchListPage(run, v, rule)
      if (pageItems.length > 0) {
        got = pageItems
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
    const outcome = await processBook(run, item.url as string, rule, { trackTotal: false, chapterProgress })
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
