/**
 * 采集数据入库层（服务端专用）：规则加载/清洗、分类保障、书籍 upsert
 * （并发 P2002 回读）、章节入库（idx 竞态顺延重试）、字数重算。
 */
import { db } from '@/lib/db'
import { NOVEL_AUTHOR_MAX, NOVEL_DESCRIPTION_MAX, NOVEL_TITLE_MAX, CHAPTER_TITLE_MAX } from '@/lib/limits'
import { fetchAndStoreCover, gradientTokenFor, isLocalCoverPath } from '@/lib/covers-store'
import type { Run } from './run-log'
import type { BookData, LoadedRule, RuleMap } from './types'

// ==================== 规则 ====================

/** 单条规则映射的键数与键长上限（引擎只读取固定键名，防止畸形输入撑爆规则 JSON 存储） */
const MAX_RULE_KEYS = 60
const MAX_RULE_KEY_LEN = 100

/** 运行时清洗规则对象：仅保留非空字符串值并限长（API 输入与 DB 读出共用） */
export function sanitizeRuleMap(raw: unknown): RuleMap {
  const out: RuleMap = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) {
        // chapterListApi 为 JSON 目录接口配置字符串（与引擎白名单同步：普通选择器 300、配置串 1200）
        const cap = k === 'chapterListApi' ? 1200 : 300
        out[k.slice(0, MAX_RULE_KEY_LEN)] = v.trim().slice(0, cap)
        if (Object.keys(out).length >= MAX_RULE_KEYS) break
      }
    }
  }
  return out
}

/** 安全解析 DB 中的规则 JSON（历史数据可能损坏） */
export function safeParseRule(json: string | null | undefined): RuleMap {
  if (!json) return {}
  try {
    return sanitizeRuleMap(JSON.parse(json))
  } catch {
    return {}
  }
}

export async function loadRule(ruleId: number | null): Promise<LoadedRule> {
  if (!ruleId) return { listRule: {}, bookRule: {}, chapterRule: {} }
  const r = await db.scrapeRule.findUnique({ where: { id: ruleId } }).catch(() => null)
  if (!r) return { listRule: {}, bookRule: {}, chapterRule: {} }
  return {
    name: r.name,
    charset: r.charset ? r.charset.toLowerCase() : undefined,
    proxy: r.proxy?.trim() || undefined,
    insecureTLS: r.insecureTLS === true ? true : undefined,
    listRule: safeParseRule(r.listRule),
    bookRule: safeParseRule(r.bookRule),
    chapterRule: safeParseRule(r.chapterRule),
  }
}

// ==================== 基础工具 ====================

/** 分类归一/创建已迁移至 ./category.ts（智能归并：同义词→关键词→LLM 兜底）。re-export 保持 worker 既有 import 路径不变。 */
export { ensureCategory, canonicalCategory, CANONICAL_CATEGORIES, FALLBACK_CATEGORY } from './category'

/** Prisma 唯一约束冲突（P2002）或 SQLite unique 错误 */
export function isUniqueConflict(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return (e as { code?: string }).code === 'P2002' || /unique|constraint/i.test(e.message)
}

export function mapNovelStatus(raw: string): 'serial' | 'finished' {
  return /完|fin/i.test(raw) ? 'finished' : 'serial'
}

// COVER_TOKENS 已由 covers-store.gradientTokenFor 的确定性 hash 分配取代（同名书同 token）

// ==================== 书籍 upsert ====================

export interface UpsertOutcome {
  ok: boolean
  /** 书籍级失败（与任务取消共用 BookOutcome.canceled 通道，沿用原语义） */
  canceled: boolean
  novelId: number
  createdNew: boolean
  title: string
  message: string
}

/**
 * 书籍 upsert（title+author 查重，先 trim 规范化再截断；DB 层 @@unique([title,author]) 兜底并发）。
 * 新书 created+1 / 已有书 updated+1（结果记入 run.counters）。
 * canceled 仅对「记录级失败」（入库/更新失败、并发冲突后找不到记录）为 true，
 * 与原实现一致：空标题返回 canceled=false（任务按 failed 收尾，而非 canceled）。
 */
export async function upsertBook(
  run: Run,
  book: BookData,
  categoryId: number,
  proxy?: string,
): Promise<UpsertOutcome> {
  const fail = (message: string, canceled: boolean): UpsertOutcome => ({
    ok: false,
    canceled,
    novelId: 0,
    createdNew: false,
    title: '',
    message,
  })

  const title = (book.title || '').trim().slice(0, NOVEL_TITLE_MAX)
  if (!title) return fail('书籍标题为空，入库中止', false)
  const author = ((book.author || '').trim() || '佚名').slice(0, NOVEL_AUTHOR_MAX)

  let novelId: number
  let createdNew = false
  const existing = await db.novel.findFirst({ where: { title, author }, select: { id: true, cover: true } }).catch(() => null)
  if (existing) {
    novelId = existing.id
  } else {
    try {
      const row = await db.novel.create({
        data: {
          title,
          author,
          description: (book.description || '').slice(0, NOVEL_DESCRIPTION_MAX),
          cover: gradientTokenFor(title, author), // 无封面时的确定性渐变 token；抓到封面后立即覆写为 /covers/*.webp
          categoryId,
          status: mapNovelStatus(book.status),
        },
      })
      novelId = row.id
      createdNew = true
    } catch (e) {
      if (!isUniqueConflict(e)) {
        run.log(`书籍入库失败: ${e instanceof Error ? e.message.slice(0, 120) : '未知错误'}`)
        return fail('书籍入库失败', true)
      }
      // 并发另一任务已抢先创建同一本书（撞 @@unique([title,author])）→ 回读命中查重，走更新路径
      const winner = await db.novel.findFirst({ where: { title, author }, select: { id: true, cover: true } }).catch(() => null)
      if (!winner) return fail('书籍入库失败（并发冲突后未找到记录）', true)
      novelId = winner.id
      run.log(`并发入库冲突，命中已有书籍 #${novelId}`)
    }
  }

  // ---- 封面采集落盘（下载远程封面 → webp → public/covers/{id}.webp）----
  // 触发条件：引擎提取到远程封面 URL，且（新书 或 已有书仍是渐变 token 可升级）；已是本地 webp 则跳过
  const remoteCover = typeof book.cover === 'string' && /^https?:\/\//.test(book.cover) ? book.cover : ''
  if (remoteCover && (createdNew || (existing && !isLocalCoverPath(existing.cover)))) {
    // 封面与目标站常同域同封锁策略：经规则代理出口下载（图床直连不可达时必须走代理）
    const stored = await fetchAndStoreCover(novelId, remoteCover, proxy)
    if (stored) {
      await db.novel.update({ where: { id: novelId }, data: { cover: stored } }).catch(() => null)
      run.log(`封面已保存 ${stored.slice(0, 40)}（webp）`)
    } else {
      run.log(`封面下载失败，保留渐变封面（${remoteCover.slice(0, 80)}）`)
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
          description: (book.description || '').slice(0, NOVEL_DESCRIPTION_MAX),
          categoryId,
          status: mapNovelStatus(book.status),
        },
      })
      .then(() => true)
      .catch(() => false)
    if (!okUpd) return fail('书籍更新失败（记录可能已被删除）', true)
    run.counters.updated++
    run.log(`书籍已存在，更新信息（#${novelId}）`)
  }
  return { ok: true, canceled: false, novelId, createdNew, title, message: '' }
}

// ==================== 章节骨架（Task 13-a 两阶段并发 Phase 1） ====================

/** 章节标题入库规范化：统一 trim + 上限截断（骨架与正文入库共用，保持存储契约一致） */
export function normalizeChapterTitle(raw: string | null | undefined): string {
  return (raw ?? '').trim().slice(0, CHAPTER_TITLE_MAX)
}

/** 已有章节行（骨架补齐/去重判断所需的最小字段集） */
export interface ExistingChapterRow {
  id: number
  idx: number
  title: string
  wordCount: number
}

/** 读取某本书的既有章节（按 idx 升序）；失败静默返回空数组（视为全新目录） */
export async function loadExistingChapters(novelId: number): Promise<ExistingChapterRow[]> {
  return db.chapter
    .findMany({
      where: { novelId },
      select: { id: true, idx: true, title: true, wordCount: true },
      orderBy: { idx: 'asc' },
    })
    .catch(() => [] as ExistingChapterRow[])
}

export interface SkeletonCreateResult {
  added: number
  /** 本批次实际占用的最大 idx+1（慢路径顺延后可能与预分配不同） */
  nextIdx: number
}

/**
 * 批量创建章节骨架（content=''、wordCount=0，title/idx 来自目录）。
 *
 * - 快路径：createMany 分块（500/块）一次落库 —— 纯本地 SQLite，远快于逐行 create；
 * - 慢路径：块内任一冲突（并发任务同书写骨架 / 既有目录变化）→ 该块逐行 storeChapter
 *   （内部带 idx 顺延重试）兜底，只损失速度不丢数据；
 * - 去重由调用方完成（(novelId, title) 语义 + idx 预分配），本函数不做判断。
 */
export async function createChapterSkeletons(
  run: Run,
  novelId: number,
  rows: Array<{ idx: number; title: string }>,
): Promise<SkeletonCreateResult> {
  let nextIdx = rows.length > 0 ? (rows[rows.length - 1]?.idx ?? 0) + 1 : 0
  if (rows.length === 0) return { added: 0, nextIdx }

  const CHUNK = 500
  let added = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const payload = chunk.map((r) => ({ novelId, idx: r.idx, title: r.title, content: '', wordCount: 0 }))
    const ok = await db.chapter
      .createMany({ data: payload })
      .then((res) => {
        added += res.count
        return true
      })
      .catch(() => false)
    if (ok) continue
    // 慢路径：逐行入库（idx 冲突顺延重试），保证并发/重跑场景数据完整
    for (const r of chunk) {
      const stored = await storeChapter(run, novelId, r.idx, { title: r.title, content: '', wordCount: 0 })
      if (stored.ok) {
        added++
        if (stored.idx !== r.idx) nextIdx = Math.max(nextIdx, stored.idx + 1)
      } else {
        run.log(`骨架入库失败(${r.title.slice(0, 30)}): ${stored.message.slice(0, 100)}`)
      }
    }
  }
  return { added, nextIdx }
}

// ==================== 章节入库与字数 ====================

export interface ChapterRow {
  title: string
  content: string
  wordCount: number
}

/**
 * 章节入库。唯一冲突（P2002，如并发任务写同一本书）时顺延 idx 有界重试
 * （默认 1 次；并发双写同书可能连锁占用多个连续序号，单次重试会漏），
 * 避免序号停滞导致后续所有章节连锁失败。
 * 成功返回实际落库使用的 idx（调用方据此推进下一章序号）；失败返回错误消息。
 */
const MAX_IDX_BUMPS = 4 // 首次尝试外最多顺延 4 次（共 5 次尝试）

export async function storeChapter(
  run: Run,
  novelId: number,
  idx: number,
  row: ChapterRow,
): Promise<{ ok: true; idx: number } | { ok: false; message: string }> {
  const attempt = (idxVal: number): Promise<true | Error> =>
    db.chapter
      .create({ data: { novelId, idx: idxVal, title: row.title, content: row.content, wordCount: row.wordCount } })
      .then(() => true as const)
      .catch((e: unknown) => (e instanceof Error ? e : new Error('章节入库失败')))

  let stored = await attempt(idx)
  for (let bumps = 0; stored !== true && isUniqueConflict(stored) && bumps < MAX_IDX_BUMPS; bumps++) {
    run.log(`章节序号 ${idx} 已被占用，顺延重试`)
    idx++
    stored = await attempt(idx)
  }
  if (stored === true) return { ok: true, idx }
  return { ok: false, message: stored.message }
}

/** 重算书籍字数合计（失败静默，不影响任务状态机） */
export async function recalcNovelWordCount(novelId: number): Promise<void> {
  const sum = await db.chapter
    .aggregate({ where: { novelId }, _sum: { wordCount: true } })
    .catch(() => ({ _sum: { wordCount: null as number | null } }))
  await db.novel
    .update({ where: { id: novelId }, data: { wordCount: sum._sum.wordCount ?? 0 } })
    .catch(() => {})
}

// ==================== 两阶段采集：骨架批量入库 ====================

export interface SkeletonOutcome {
  /** 新入库骨架数 */
  stored: number
  /** 已有正文而跳过数（同名标题且 wordCount>0） */
  skippedFilled: number
  /** 有效章节链接总数（stored + fillRows + skippedFilled，single 模式进度分母） */
  total: number
  /** 是否因单本章节数上限截断 */
  capped: boolean
  /**
   * 待填充行（title→URL）：新建骨架 + 已存在但 wordCount=0 的空骨架（续传）。
   * URL 仅驻留内存（进程内 client 与 DB schema 一致性约束，不新增列），
   * 任务中断后重发即自动续传（Phase 1 重新匹配空骨架）。
   */
  fillRows: { title: string; url: string }[]
}

/**
 * Phase 1 骨架批量入库：按标题去重（批内 + 与既有章节），idx 从现有最大值连续分配。
 * - 全新标题 → 建骨架（content=''、wordCount=0），title 为空用「第{idx}章」占位
 * - 同名但 wordCount=0（历史中断遗留的空骨架） → 不重建，其 title/URL 计入 fillRows 续传
 * - 同名且 wordCount>0 → 跳过
 * 并发同书建骨架撞 (novelId,idx) 唯一约束时退化为逐条顺延重试（复用 storeChapter）。
 */
export async function storeChapterSkeletons(
  run: Run,
  novelId: number,
  refs: { title: string; url: string }[],
  cap: number,
): Promise<SkeletonOutcome> {
  // 批内按标题去重（同书同名章只保留首个 URL）
  const byTitle = new Map<string, string>()
  for (const r of refs) {
    const title = r.title.trim()
    if (!byTitle.has(title)) byTitle.set(title, r.url)
  }
  // 与既有章节对齐：区分「已填充跳过」与「空骨架续传」
  const existing = await db.chapter
    .findMany({ where: { novelId }, select: { title: true, wordCount: true } })
    .catch(() => [] as { title: string; wordCount: number }[])
  const filledTitles = new Set<string>()
  const emptyTitles = new Set<string>()
  for (const c of existing) (c.wordCount > 0 ? filledTitles : emptyTitles).add(c.title)

  const fresh: { title: string; url: string }[] = []
  const resume: { title: string; url: string }[] = []
  let skippedFilled = 0
  for (const [title, url] of byTitle) {
    if (filledTitles.has(title)) {
      skippedFilled++
    } else if (emptyTitles.has(title)) {
      resume.push({ title, url })
    } else {
      fresh.push({ title, url })
    }
  }

  let capped = false
  if (fresh.length > cap) {
    fresh.length = cap
    capped = true
  }
  const total = byTitle.size
  if (fresh.length === 0) {
    return { stored: 0, skippedFilled, total, capped, fillRows: resume }
  }

  const maxAgg = await db.chapter
    .aggregate({ where: { novelId }, _max: { idx: true } })
    .catch(() => ({ _max: { idx: null as number | null } }))
  let idx = (maxAgg._max.idx ?? 0) + 1
  const data = fresh.map((r) => {
    const auto = `第${idx}章`
    return { novelId, idx: idx++, title: r.title || auto, url: r.url }
  })

  try {
    const res = await db.chapter.createMany({
      data: data.map((r) => ({ novelId: r.novelId, idx: r.idx, title: r.title, content: '', wordCount: 0 })),
    })
    const fillRows: { title: string; url: string }[] = [
      ...data.map((r) => ({ title: r.title, url: r.url })),
      ...resume,
    ]
    return { stored: res.count, skippedFilled, total, capped, fillRows }
  } catch (e) {
    // 并发任务同书建骨架撞唯一约束 → 逐条入库（storeChapter 自带 idx 顺延重试）
    if (!isUniqueConflict(e)) throw e
    run.log('骨架批量入库冲突，退化为逐条写入')
    const fillRows: { title: string; url: string }[] = []
    let stored = 0
    for (const row of data) {
      const r = await storeChapter(run, novelId, row.idx, { title: row.title, content: '', wordCount: 0 })
      if (r.ok) {
        stored++
        fillRows.push({ title: row.title, url: row.url })
      }
    }
    return { stored, skippedFilled, total, capped, fillRows: [...fillRows, ...resume] }
  }
}
