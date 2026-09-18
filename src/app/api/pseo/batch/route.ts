import { NextRequest, NextResponse } from 'next/server'
import { fetchSuggestionsMulti } from '@/lib/suggest'
import { generatePendingPages, getPseoConfig, insertKeywords, savePseoConfig } from '@/lib/pseo'
import type { PseoRunnerConfig } from '@/lib/types'

export const dynamic = 'force-dynamic'

interface EngineStat { engine: string; ok: boolean; count: number; error?: string }
interface SeedOutcome {
  seed: string
  level: 1 | 2
  words: { word: string; engine: string }[]
  engines: EngineStat[]
}

const LOCK_KEY = '__pseoBatchStartedAt'
const LOCK_TTL_MS = 180_000 // 仅防僵尸锁：正常完成/异常都在 finally 主动释放

function acquireLock(): boolean {
  const g = globalThis as unknown as Record<string, unknown>
  const at = typeof g[LOCK_KEY] === 'number' ? (g[LOCK_KEY] as number) : 0
  if (at && Date.now() - at < LOCK_TTL_MS) return false
  g[LOCK_KEY] = Date.now()
  return true
}

function releaseLock() {
  ;(globalThis as unknown as Record<string, unknown>)[LOCK_KEY] = 0
}

/** 一批种子并发跑（限并发 2，引擎聚合内部再限 3），结果保持输入顺序 */
async function runSeedBatch(seeds: string[], cfg: PseoRunnerConfig, level: 1 | 2): Promise<SeedOutcome[]> {
  const results: SeedOutcome[] = new Array(seeds.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(2, seeds.length) }, async () => {
    for (;;) {
      const idx = cursor++
      if (idx >= seeds.length) return
      const seed = seeds[idx]
      // 批量场景种子/引擎叠加并发更高，引擎超时放宽到 6s（单发 suggest 仍为 4s）
      const agg = await fetchSuggestionsMulti(seed, cfg.sources, { timeoutMs: 6000 })
      results[idx] = {
        seed,
        level,
        words: agg.words.slice(0, cfg.perSeedLimit),
        engines: agg.results.map((r) => ({ engine: r.engine, ok: r.ok, count: r.words.length, error: r.error })),
      }
    }
  })
  await Promise.allSettled(workers)
  return results
}

// POST /api/pseo/batch — 应用 PSEO 设置：种子 × multi-search-engine 批量获取下拉词入库
// body: { config?: Partial<PseoRunnerConfig> }（提供时先持久化再执行，「保存+应用」一步完成）
export async function POST(req: NextRequest) {
  if (!acquireLock()) {
    return NextResponse.json({ error: '批量获取正在进行中，请稍后再试' }, { status: 409 })
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { config?: unknown }
    const cfg: PseoRunnerConfig =
      body.config !== undefined ? await savePseoConfig(body.config) : await getPseoConfig()

    if (cfg.seeds.length === 0) {
      return NextResponse.json({ error: '请先在 PSEO 设置中填写种子关键词' }, { status: 400 })
    }

    const outcomes = await runSeedBatch(cfg.seeds, cfg, 1)

    // 二级挖掘：一级下拉词（引擎优先序、去重并排除一级种子）取前 8 个作为新种子再挖一轮
    let level2Seeds: string[] = []
    let level2Words = 0
    if (cfg.expand) {
      const seen = new Set(cfg.seeds)
      for (const o of outcomes) {
        for (const w of o.words) {
          if (level2Seeds.length >= 8) break
          if (seen.has(w.word)) continue
          seen.add(w.word)
          level2Seeds.push(w.word)
        }
      }
      const level2Outcomes = await runSeedBatch(level2Seeds, cfg, 2)
      outcomes.push(...level2Outcomes)
      level2Words = level2Outcomes.reduce((s, o) => s + o.words.length, 0)
    }

    const entries = outcomes.flatMap((o) => o.words)
    const added = await insertKeywords(entries, cfg.maxKeywords)
    const generated = cfg.autoGenerate ? await generatePendingPages(50) : 0

    return NextResponse.json({
      added,
      generated,
      level2Seeds: level2Seeds.length,
      level2Words,
      report: outcomes.map((o) => ({ seed: o.seed, level: o.level, engines: o.engines, words: o.words.length })),
    })
  } finally {
    releaseLock()
  }
}
