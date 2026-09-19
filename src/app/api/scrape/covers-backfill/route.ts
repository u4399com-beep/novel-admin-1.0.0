/**
 * 封面回填端点（POST /api/scrape/covers-backfill）：
 *
 * 对「封面仍是渐变 token 且已存 remoteCoverUrl」的书籍批量重试封面下载落盘。
 * 背景：采集时封面可能因图床限流/代理瞬断/图床临时不可达而落盘失败——
 * remoteCoverUrl 与 sourceRuleId 已在 upsertBook 持久化，本端点凭此重试：
 *   - 代理出口按 sourceRuleId 解析（被封锁站点的图床须经同一出口访问）
 *   - 已是本地 webp 的书自动跳过；单轮上限 LIMIT 防长时间占用请求
 *
 * 请求体（可选）：{ limit?: number }  单轮最多处理的书籍数（默认 40，上限 200）
 * 响应：{ attempted, upgraded, failed, remaining }
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fetchAndStoreCover } from '@/lib/covers-store'

export const dynamic = 'force-dynamic'

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 200
/** 并发下载封面数（图床友好：低并发 + covers-store 自带 12s 超时） */
const CONCURRENCY = 4

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(n))
}

/** GET：封面覆盖统计（管理后台 CoversCard 展示用） */
export async function GET() {
  const [total, local, backfillable] = await Promise.all([
    db.novel.count().catch(() => 0),
    db.novel.count({ where: { cover: { startsWith: '/covers/' } } }).catch(() => 0),
    db.novel
      .count({ where: { NOT: { cover: { startsWith: '/covers/' } }, remoteCoverUrl: { not: '' } } })
      .catch(() => 0),
  ])
  return NextResponse.json({ total, local, gradient: Math.max(0, total - local), backfillable })
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { limit?: unknown } | null
  const limit = parseLimit(body?.limit)

  // 候选：渐变 token 封面 + 有远程来源。按更新时间倒序（最近采集的先回填，图床 URL 更可能仍有效）
  const candidates = await db.novel
    .findMany({
      where: { NOT: { cover: { startsWith: '/covers/' } }, remoteCoverUrl: { not: '' } },
      select: { id: true, remoteCoverUrl: true, sourceRuleId: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })
    .catch(() => [])

  const remainingAgg = await db.novel
    .count({ where: { NOT: { cover: { startsWith: '/covers/' } }, remoteCoverUrl: { not: '' } } })
    .catch(() => 0)

  // 一次性取回候选涉及的规则代理（避免每书一次查询）
  const ruleIds = [...new Set(candidates.map((n) => n.sourceRuleId).filter((id): id is number => typeof id === 'number'))]
  const rules = await db.scrapeRule
    .findMany({ where: { id: { in: ruleIds } }, select: { id: true, proxy: true } })
    .catch(() => [] as { id: number; proxy: string }[])
  const proxyByRule = new Map(rules.map((r) => [r.id, r.proxy?.trim() || '']))

  let upgraded = 0
  let failed = 0

  // 低并发流水线：失败不中断后续（单书失败仅计数）
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const n = candidates[cursor++]
      if (!n) continue
      const proxy = typeof n.sourceRuleId === 'number' ? (proxyByRule.get(n.sourceRuleId) ?? '') : ''
      const stored = await fetchAndStoreCover(n.id, n.remoteCoverUrl, proxy || null)
      if (stored) {
        await db.novel.update({ where: { id: n.id }, data: { cover: stored } }).catch(() => null)
        upgraded++
      } else {
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker))

  return NextResponse.json({
    attempted: candidates.length,
    upgraded,
    failed,
    remaining: Math.max(0, remainingAgg - candidates.length),
  })
}
