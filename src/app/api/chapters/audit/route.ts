import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { firstLine } from '@/lib/errors'

export const dynamic = 'force-dynamic'

/**
 * 章节目录体检与修复：
 *
 * GET（只读体检）
 * - ?novelId=N：单本书详细报告（重复组/断档/空骨架/编号乱序/分卷结构）
 * - 不带参数：全站概览（按问题严重度降序，最多 100 本）
 *
 * POST（写库修复，body: { action, novelId }）
 * - dedupe：同书同名章节去重（保留 wordCount 最大者），并压实 idx
 * - reindex：按标题「第N章/节/回」编号升序重排 idx（无编号章节按原相对顺序置后）
 * - 单本操作在采集任务运行时也允许：Phase 2 按 title 匹配空骨架、idx 冲突有顺延兜底，
 *   对已填充行的删除/重排不产生数据损坏（正在填充的行 update-by-id 失败仅计入任务失败数）
 */

// ==================== 中文数字解析 ====================

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
}
const CN_UNIT: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 }

/** 中文/全角数字 → 阿拉伯数字；不可解析返回 null */
function parseChapterNumber(raw: string): number | null {
  const s = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  let result = 0
  let section = 0
  let cur = -1
  for (const ch of s) {
    if (ch === '万' || ch === '萬') {
      section = (section + Math.max(cur, 0)) * 10000
      result += section
      section = 0
      cur = -1
    } else if (ch in CN_DIGIT) {
      cur = CN_DIGIT[ch]
    } else if (ch in CN_UNIT) {
      section += (cur < 0 ? 1 : cur) * CN_UNIT[ch]
      cur = -1
    } else {
      return null
    }
  }
  return result + section + Math.max(cur, 0)
}

const CH_NUM_RE = /^第\s*([0-9０-９]+|[零〇一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟萬万]+)\s*(?:章|节|節)/
const VOLUME_RE = /第\s*([0-9０-９]+|[零〇一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟萬万]+)\s*(?:卷|部|篇)/

/**
 * 提取章节编号（严格版）：标题必须以「第N章/节」开头（章回体「回」量词排除——叙事句
 * 「第一回有人…」并非章节号）；编号后剩余标题超 30 字视为叙述句不参与编号判定。
 */
function extractNum(title: string): number | null {
  const m = title.match(CH_NUM_RE)
  if (!m) return null
  if (title.slice(m[0].length).length > 30) return null
  return parseChapterNumber(m[1])
}

// ==================== 体检核心 ====================

export interface NovelAuditItem {
  novelId: number
  title: string
  chapters: number
  /** 同书同名重复组数（保留 1 行后多余行数） */
  dupGroups: number
  /** 可删除的重复行数 */
  dupRows: number
  /** idx 断档缺口数（maxIdx+1-rows，≥0） */
  idxGaps: number
  /** 空骨架行数（wordCount=0，采集进行中属正常） */
  emptyRows: number
  /** 标题编号乱序（编号序列存在回退） */
  disordered: boolean
  /** 乱序示例（相邻回退对，最多 3 组） */
  disorderSamples: string[]
  /** 分卷结构（单本详情时提供） */
  volumes?: { title: string; from: number; to: number; chapters: number }[]
}

async function auditNovel(novelId: number, title: string): Promise<NovelAuditItem> {
  const rows = await db.chapter
    .findMany({
      where: { novelId },
      orderBy: { idx: 'asc' },
      select: { id: true, idx: true, title: true, wordCount: true },
    })
    .catch(() => [])

  // 重复标题分组
  const byTitle = new Map<string, number>()
  for (const r of rows) byTitle.set(r.title, (byTitle.get(r.title) ?? 0) + 1)
  let dupGroups = 0
  let dupRows = 0
  for (const c of byTitle.values()) {
    if (c > 1) {
      dupGroups++
      dupRows += c - 1
    }
  }

  // idx 断档（rows 与 maxIdx 不符；idx 从 1 连续为健康）
  const maxIdx = rows.reduce((m, r) => Math.max(m, r.idx), 0)
  const idxGaps = Math.max(0, maxIdx - rows.length)

  const emptyRows = rows.filter((r) => r.wordCount === 0).length

  // 编号乱序：相邻回退检测（前章编号大于后章编号）
  const disorderSamples: string[] = []
  let prev: { n: number; title: string } | null = null
  for (const r of rows) {
    const n = extractNum(r.title)
    if (n === null) continue
    if (prev && n < prev.n && disorderSamples.length < 3) {
      disorderSamples.push(`「${prev.title.slice(0, 24)}」→「${r.title.slice(0, 24)}」`)
    }
    prev = { n, title: r.title }
  }

  const item: NovelAuditItem = {
    novelId,
    title,
    chapters: rows.length,
    dupGroups,
    dupRows,
    idxGaps,
    emptyRows,
    disordered: disorderSamples.length > 0,
    disorderSamples,
  }

  // 分卷结构（仅单本详情）：以「第X卷/部/篇」标题行为卷边界
  if (rows.length > 0) {
    const volumes: { title: string; from: number; to: number; chapters: number }[] = []
    let current: { title: string; from: number; to: number; chapters: number } | null = null
    for (const r of rows) {
      if (VOLUME_RE.test(r.title)) {
        current = { title: r.title.slice(0, 60), from: r.idx, to: r.idx, chapters: 0 }
        volumes.push(current)
      }
      if (current) {
        current.to = r.idx
        current.chapters++
      }
    }
    if (volumes.length > 0) item.volumes = volumes
  }
  return item
}

// ==================== 路由 ====================

export async function GET(req: NextRequest) {
  const novelIdParam = req.nextUrl.searchParams.get('novelId')
  try {
    if (novelIdParam) {
      const novelId = Number(novelIdParam)
      if (!Number.isInteger(novelId) || novelId <= 0) {
        return NextResponse.json({ error: 'novelId 非法' }, { status: 400 })
      }
      const novel = await db.novel.findUnique({ where: { id: novelId }, select: { id: true, title: true } })
      if (!novel) return NextResponse.json({ error: '书籍不存在' }, { status: 404 })
      const item = await auditNovel(novel.id, novel.title)
      return NextResponse.json({ mode: 'single', item })
    }

    // 全站概览：逐书体检（含书目量大时的分批由调用方按需处理；当前书量级一次可承受）
    const novels = await db.novel.findMany({ select: { id: true, title: true }, orderBy: { id: 'asc' } })
    const items: NovelAuditItem[] = []
    for (const n of novels) items.push(await auditNovel(n.id, n.title))
    const problem = items
      .filter((i) => i.dupRows > 0 || i.idxGaps > 0 || i.disordered)
      .sort((a, b) => b.dupRows * 10 + b.idxGaps - (a.dupRows * 10 + a.idxGaps))
      .slice(0, 100)
    return NextResponse.json({ mode: 'overview', novels: items.length, healthy: items.length - problem.length, problem })
  } catch (e) {
    return NextResponse.json({ error: '目录体检失败', detail: firstLine(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: { action?: string; novelId?: number | string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体非法 JSON' }, { status: 400 })
  }
  const action = body.action
  const novelId = Number(body.novelId)
  if (action !== 'dedupe' && action !== 'reindex') {
    return NextResponse.json({ error: 'action 仅支持 dedupe / reindex' }, { status: 400 })
  }
  if (!Number.isInteger(novelId) || novelId <= 0) {
    return NextResponse.json({ error: 'novelId 必填（正整数）' }, { status: 400 })
  }

  try {
    const novel = await db.novel.findUnique({ where: { id: novelId }, select: { id: true, title: true } })
    if (!novel) return NextResponse.json({ error: '书籍不存在' }, { status: 404 })

    const rows = await db.chapter.findMany({
      where: { novelId },
      orderBy: [{ idx: 'asc' }, { id: 'asc' }],
      select: { id: true, idx: true, title: true, wordCount: true },
    })
    if (rows.length === 0) return NextResponse.json({ error: '该书无章节' }, { status: 400 })

    // ---- 去重：同书同名保留 wordCount 最大（并列取 idx 最小）----
    let removed = 0
    if (action === 'dedupe') {
      const best = new Map<string, { id: number; wordCount: number; idx: number }>()
      for (const r of rows) {
        const b = best.get(r.title)
        if (!b || r.wordCount > b.wordCount || (r.wordCount === b.wordCount && r.idx < b.idx)) {
          best.set(r.title, { id: r.id, wordCount: r.wordCount, idx: r.idx })
        }
      }
      if (best.size < rows.length) {
        const keepIds = new Set([...best.values()].map((b) => b.id))
        const dropIds = rows.filter((r) => !keepIds.has(r.id)).map((r) => r.id)
        const res = await db.chapter.deleteMany({ where: { id: { in: dropIds } } })
        removed = res.count
      }
    }

    // ---- 重排：有编号按编号升序（稳定），无编号按原相对顺序置后；压实 idx 1..n ----
    const kept = await db.chapter.findMany({
      where: { novelId },
      orderBy: [{ idx: 'asc' }, { id: 'asc' }],
      select: { id: true, idx: true, title: true },
    })
    let moved = 0
    const numbered = kept
      .map((r, i) => ({ r, i, n: extractNum(r.title) }))
      .filter((x): x is { r: { id: number; idx: number; title: string }; i: number; n: number } => x.n !== null)
    const ordered = [
      ...numbered.sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.r),
      ...kept.filter((r) => extractNum(r.title) === null),
    ]
    // 两段式重排：先全部移出到负数暂存区（避开目标 idx 被占），再落位 1..n
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].idx !== i + 1) {
        await db.chapter.updateMany({ where: { id: ordered[i].id }, data: { idx: -1_000_000 - i } }).catch(() => null)
      }
    }
    for (let i = 0; i < ordered.length; i++) {
      const target = i + 1
      if (ordered[i].idx !== target) {
        const res = await db.chapter
          .updateMany({ where: { id: ordered[i].id }, data: { idx: target } })
          .catch(() => null)
        if (res && res.count > 0) moved++
      }
    }

    // 重算字数（去重可能删行）
    if (removed > 0) {
      const sum = await db.chapter
        .aggregate({ where: { novelId }, _sum: { wordCount: true } })
        .catch(() => ({ _sum: { wordCount: null as number | null } }))
      await db.novel
        .update({ where: { id: novelId }, data: { wordCount: sum._sum.wordCount ?? 0 } })
        .catch(() => {})
    }

    const after = await auditNovel(novelId, novel.title)
    return NextResponse.json({ ok: true, action, novelId, removed, moved, audit: after })
  } catch (e) {
    return NextResponse.json({ error: '目录修复失败', detail: firstLine(e) }, { status: 500 })
  }
}
