/** 各规则书籍的章节数分布（章节链接选择器历史有效性 DB 证据，只读） */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
for (const ruleId of [11, 12, 13, 14, 17, 18, 20]) {
  const novels = await db.novel.findMany({ where: { sourceRuleId: ruleId }, select: { id: true, title: true, _count: { select: { chapters: true } } }, take: 4 })
  console.log(`rule#${ruleId}:`, novels.map((n) => `#${n.id}${n.title.slice(0, 10)}=${n._count.chapters}章`).join(' | ') || '(无)')
}
await db.$disconnect()
