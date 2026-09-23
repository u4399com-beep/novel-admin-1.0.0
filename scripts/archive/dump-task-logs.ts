/** 导出任务的规则/URL/日志中与「书页 URL、翻页命中」相关的行（校准参考，只读） */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.scrapeTask.findMany({ select: { id: true, ruleId: true, mode: true, targetUrl: true, log: true, status: true }, orderBy: { id: 'asc' } })
for (const t of rows) {
  if (!t.log) continue
  const lines = t.log.split('\n')
  const hits = lines.filter((l) => /抓取书页|页命中|列表页|书页提取成功|封面/.test(l)).slice(0, 14)
  if (!hits.length) continue
  console.log(`\n===== task#${t.id} rule=${t.ruleId} mode=${t.mode} [${t.status}] ${t.targetUrl} =====`)
  for (const l of hits) console.log(`  ${l.slice(0, 150)}`)
}
await db.$disconnect()
