/**
 * worker 真实路径诊断：bun 进程内创建任务并触发两阶段采集，观察是否 native crash。
 * 用法：bun scripts/test-worker.ts create <ruleId> <targetUrl> [pages]
 */
import { db } from '../../src/lib/db'
import { triggerScrapeTask } from '../../src/lib/scrape/worker'

async function main(): Promise<void> {
  const ruleId = Number(process.argv[3] ?? 13)
  const targetUrl = process.argv[4] ?? 'https://www.huangjinwu.org/'
  const pages = Number(process.argv[5] ?? 1)
  const task = await db.scrapeTask.create({
    data: { ruleId, mode: 'list', targetUrl, pages, status: 'pending' },
  })
  console.log(`[diag] task#${task.id} created, triggering...`)
  triggerScrapeTask(task.id)
  let beats = 0
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      beats++
      if (beats % 5 === 0) console.log(`[diag] heartbeat ${beats} (${new Date().toISOString().slice(11, 19)})`)
      if (beats >= 60) {
        clearInterval(timer)
        resolve()
      }
    }, 2000)
  })
  const t = await db.scrapeTask.findUnique({ where: { id: task.id } })
  console.log(`[diag] 120s 存活。任务终态: ${t?.status} 书:${t?.done}/${t?.total} 章:${t?.chaptersDone}/${t?.chaptersTotal}`)
  await db.$disconnect()
}

main().catch((e) => {
  console.error('[diag] 失败:', e)
  process.exit(1)
})
