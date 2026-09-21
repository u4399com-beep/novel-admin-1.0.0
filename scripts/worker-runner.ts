/**
 * 采集 Worker 常驻 Runner（独立 bun 进程，与 Next 进程解耦）
 *
 * 背景与动机：
 * - 采集是全站最大负载源（并发抓取、骨架批量入库、正文缓冲）。原架构 fire-and-forget 在
 *   Next dev 进程内跑，长任务把进程内存/CPU 推高（用户诉求：不要堆内存堆到服务器崩溃），
 *   且沙箱守护会在任务运行期 SIGKILL Next 进程（实证：任务必死、空闲则存活）。
 * - 独立 bun 进程跑同一 worker 链路实测稳定（120s+ 真实抓取、bun --hot 热更）。
 *
 * 职责：
 * - 每 2s 轮询 status=pending 的采集任务 → triggerScrapeTask（worker 内 running Set 防重）
 * - 每次轮询刷新心跳文件（/tmp/scrape-runner-heartbeat），POST API 以此判断 runner 存活，
 *   runner 缺位时 Next 进程兜底自行执行（降级可用）
 * - SCRAPE_WORKER_RUNNER=1：仅本进程执行「僵尸任务回收」（Next 进程重启不再误杀本进程在跑的任务）
 *
 * 修复（本轮）：recoverStaleTasks 在 worker.ts 模块加载时即执行，而旧版在本文件顶层
 * import worker——ES import 提升使 main() 内的 SCRAPE_WORKER_RUNNER=1 设置晚于模块加载，
 * 僵尸回收条件永假（runner 重启后 running 任务永不回收，实证 7 条任务卡死）。
 * 改为 main() 内先设 env 再动态 import，保证回收标志在 worker 模块加载前就位。
 *
 * 运行：env SCRAPE_WORKER_RUNNER=1 bun scripts/worker-runner.ts
 * （勿用 --hot：热重载会重跑 main() 产生重复轮询循环，且清理 spawn 的子进程——
 *   实测 engine 被反复拉起后随热重载周期被杀；改代码后直接重启 runner 即可）
 */
import { existsSync, utimesSync, writeFileSync } from 'node:fs'
import { db } from '../src/lib/db'

const HEARTBEAT_FILE = '/tmp/scrape-runner-heartbeat'
const POLL_INTERVAL_MS = 2_000

/**
 * 未分类书慢速归类（LLM 限流自适应）：每轮轮询处理 0-1 本（LLM 429 冷却窗 30s 由
 * category.ts 进程内治理自动节流），不阻塞采集轮询；99 本约 1-2 小时自然消化。
 */
async function recategorizeOne(
  canonicalCategoryWithHint: (name: string, hint: { title: string; description: string }) => Promise<string>,
  FALLBACK_CATEGORY: string,
): Promise<boolean> {
  const unc = await db.category.findUnique({
    where: { name: FALLBACK_CATEGORY },
    select: { id: true, novels: { select: { id: true, title: true, description: true }, take: 1 } },
  })
  const book = unc?.novels[0]
  if (!book) return false
  const canon = await canonicalCategoryWithHint('', { title: book.title, description: book.description })
  if (canon === FALLBACK_CATEGORY) return false // LLM 冷却中：本轮跳过，下轮再试
  const cat = await db.category.upsert({ where: { name: canon }, update: {}, create: { name: canon } })
  await db.novel.update({ where: { id: book.id }, data: { categoryId: cat.id } }).catch(() => null)
  console.log(`[scrape-runner] recategorize 《${book.title.slice(0, 24)}》→ ${canon}`)
  return true
}

async function main(): Promise<void> {
  // 必须先于动态 import：worker.ts 模块加载时即执行 recoverStaleTasks，依赖此标志区分 runner/Next
  process.env.SCRAPE_WORKER_RUNNER = '1'
  const { triggerScrapeTask } = await import('../src/lib/scrape/worker')
  const { canonicalCategoryWithHint, FALLBACK_CATEGORY } = await import('../src/lib/scrape/category')

  console.log('[scrape-runner] started (pid', process.pid + '), polling pending tasks every 2s')

  /**
   * Engine 互监护（反向）：每 15 个轮询（≈30s）探测引擎 /api/strategies；
   * 不可达则杀残留后以 setsid 完全托孤方式拉起。独立 watchdog 进程在本环境会被
   * 静默回收（多轮实证），互监护建立在两个被实证长寿的常驻进程之间。
   */
  let tickCount = 0
  const ensureEngine = async (): Promise<void> => {
    try {
      const res = await fetch('http://127.0.0.1:3030/api/strategies', { signal: AbortSignal.timeout(8_000) })
      if (res.ok) return
    } catch {
      /* 不可达 → 拉起 */
    }
    console.log('[scrape-runner] engine 不可达，重新拉起')
    Bun.spawn(
      ['bash', '-c',
        "pkill -f 'bun --hot index.ts' 2>/dev/null; pkill -f 'env SCRAPER_PORT=3030 bun index.ts' 2>/dev/null; cd /home/z/my-project/mini-services/scraper-service && setsid nohup env SCRAPER_PORT=3030 bun index.ts >> /tmp/engine.log 2>&1 < /dev/null &"],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    )
  }

  for (;;) {
    try {
      // 心跳：mtime 每轮刷新
      const now = new Date()
      if (existsSync(HEARTBEAT_FILE)) utimesSync(HEARTBEAT_FILE, now, now)
      else writeFileSync(HEARTBEAT_FILE, now.toISOString())

      if (tickCount % 15 === 0) await ensureEngine()
      tickCount++

      const pending = await db.scrapeTask.findMany({
        where: { status: 'pending' },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 5,
      })
      for (const t of pending) triggerScrapeTask(t.id)
      if (pending.length > 0) console.log(`[scrape-runner] dispatched ${pending.length} task(s)`)
      await recategorizeOne(canonicalCategoryWithHint, FALLBACK_CATEGORY)
    } catch (e) {
      console.error('[scrape-runner] poll error:', e instanceof Error ? e.message.slice(0, 120) : e)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

main().catch((e) => {
  console.error('[scrape-runner] fatal:', e)
  process.exit(1)
})
