/** Task 12-c：各规则已入库书籍的 remoteCoverUrl 形态盘点（只读，判断封面选择器历史命中与 URL 形态） */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const novels = await db.novel.findMany({
  where: { remoteCoverUrl: { not: '' } },
  select: { id: true, sourceRuleId: true, remoteCoverUrl: true, cover: true },
  take: 3000,
})
const byRule = new Map<number, { total: number; local: number; examples: string[] }>()
for (const n of novels) {
  const rid = n.sourceRuleId ?? 0
  const e = byRule.get(rid) ?? { total: 0, local: 0, examples: [] }
  e.total++
  if (n.cover.startsWith('/covers/')) e.local++
  if (e.examples.length < 3) e.examples.push(n.remoteCoverUrl)
  byRule.set(rid, e)
}
for (const [rid, e] of [...byRule.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`rule ${rid}: books=${e.total} coverLocal=${e.local}`)
  for (const ex of e.examples) {
    // URL 形态判断（不直接回显，防 [h 显示失真；用特征布尔表达）
    const feats = [
      `abs=${/^https?:\/\//.test(ex)}`,
      `dataSrc=${/data-src|\.src|\/static\/|img/.test(ex)}`,
      `ext=${/\.(\w{3,4})(\?|$)/.exec(ex)?.[1] ?? 'none'}`,
      `len=${ex.length}`,
    ]
    console.log(`   ${feats.join(' ')}`)
  }
}
const noRemote = await db.novel.count({ where: { remoteCoverUrl: '' } })
const gradientNoRemote = await db.novel.count({ where: { remoteCoverUrl: '', NOT: { cover: { startsWith: '/covers/' } } } })
console.log(`\nnoRemoteUrl=${noRemote} gradientNoRemote=${gradientNoRemote}`)
await db.$disconnect()
