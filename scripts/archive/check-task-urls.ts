/** Task 12-c：查历史采集任务各规则用过的 targetUrl（只读） */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.scrapeTask.findMany({
  where: { mode: 'list' },
  select: { ruleId: true, targetUrl: true, status: true, id: true },
  orderBy: { id: 'desc' },
  take: 400,
})
const byRule = new Map<number, { url: string; n: number; lastId: number }[]>()
for (const t of rows) {
  if (t.ruleId == null) continue
  const arr = byRule.get(t.ruleId) ?? []
  const hit = arr.find((x) => x.url === t.targetUrl)
  if (hit) hit.n++
  else arr.push({ url: t.targetUrl, n: 1, lastId: t.id })
  byRule.set(t.ruleId, arr)
}
for (const [ruleId, arr] of [...byRule.entries()].sort((a, b) => a[0] - b[0])) {
  // URL 含 [h 的显示失真风险低；targetUrl 大多无方括号。用 JSON 输出保持结构。
  console.log(`rule ${ruleId}: ${JSON.stringify(arr.slice(0, 6).map((x) => x.url))} (${arr.length} distinct)`)
}
await db.$disconnect()
