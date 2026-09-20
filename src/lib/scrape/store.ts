/**
 * 采集数据入库层（服务端专用）：规则加载/清洗、分类保障、书籍 upsert
 * （并发 P2002 回读）、章节入库（idx 竞态顺延重试）、字数重算。
 */
import { db } from '@/lib/db'
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
        out[k.slice(0, MAX_RULE_KEY_LEN)] = v.trim().slice(0, 300)
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
    listRule: safeParseRule(r.listRule),
    bookRule: safeParseRule(r.bookRule),
    chapterRule: safeParseRule(r.chapterRule),
  }
}

// ==================== 基础工具 ====================

/**
 * 分类归一/创建已迁移至 ./category.ts（规范集+同义词+LLM 兜底三级归并）。
 * 此处 re-export 保持既有 import 路径兼容。
 */
export { ensureCategory } from './category'

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

  const title = (book.title || '').trim().slice(0, 200)
  if (!title) return fail('书籍标题为空，入库中止', false)
  const author = ((book.author || '').trim() || '佚名').slice(0, 100)

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
          description: (book.description || '').slice(0, 2000),
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
          description: (book.description || '').slice(0, 2000),
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

// ==================== 章节入库与字数 ====================

export interface ChapterRow {
  title: string
  content: string
  wordCount: number
  /** 源站章节页 URL（两阶段采集骨架行必填；用于内容回填与断点续采） */
  url?: string | null
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
      .create({
        data: {
          novelId,
          idx: idxVal,
          title: row.title,
          content: row.content,
          wordCount: row.wordCount,
          ...(row.url ? { url: row.url } : {}),
        },
      })
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
