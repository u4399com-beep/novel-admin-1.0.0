/** 导出 list 模式任务的目标 URL 形态（校准分页模板参考，只读） */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.scrapeTask.findMany({
  where: { mode: 'list' },
  select: { id: true, ruleId: true, targetUrl: true, startPage: true, pages: true, status: true, message: true },
  orderBy: { id: 'asc' },
})
for (const t of rows) console.log(`task#${t.id} rule=${t.ruleId} start=${t.startPage} pages=${t.pages} [${t.status}] ${t.targetUrl} | ${(t.message||'').slice(0,60)}`)
await db.$disconnect()
