/** 检查各规则书籍的封面落盘情况（封面选择器历史有效性的 DB 证据，只读） */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
for (const ruleId of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
  const rows = await db.novel.findMany({
    where: { sourceRuleId: ruleId },
    select: { id: true, title: true, cover: true, remoteCoverUrl: true },
    take: 3,
  })
  console.log(`rule#14→${ruleId}:`, rows.map((r) => `#${r.id}[${r.cover === '/covers/' + r.id + '.webp' ? 'webp' : r.cover}]${r.title.slice(0, 12)}${r.remoteCoverUrl ? ' ⟵remote' : ''}`).join(' | ') || '(无书籍)')
}
const agg = await db.novel.groupBy({ by: ['sourceRuleId'], _count: true, _max: { updatedAt: true } })
console.log(JSON.stringify(agg.filter((a) => a.sourceRuleId).map((a) => ({ rule: a.sourceRuleId, n: a._count, last: a._max.updatedAt }))))
await db.$disconnect()
