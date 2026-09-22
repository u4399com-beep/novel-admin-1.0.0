/** 无网络验证：各任务产出书的章节数分布（证明 catalog 链/规则可用性）+ 填充进度 */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  // 按创建批次看章节数分布（任务#24-30 顺序创建，novel id 递增）
  const novels = await db.novel.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, title: true, createdAt: true, _count: { select: { chapters: true } }, wordCount: true },
  })
  console.log(`总书数 ${novels.length}`)
  // 分桶统计：id 1-70（早期任务）/ 71-150 / 151-250 / 251+
  const buckets: Array<[string, number, number]> = [['1-70', 1, 70], ['71-150', 71, 150], ['151-250', 151, 250], ['251+', 251, 10 ** 9]]
  for (const [label, lo, hi] of buckets) {
    const seg = novels.filter((n) => n.id >= lo && n.id <= hi)
    if (seg.length === 0) continue
    const zeroCh = seg.filter((n) => n._count.chapters === 0).length
    const rich = seg.filter((n) => n._count.chapters >= 100).length
    const avg = Math.round(seg.reduce((s, n) => s + n._count.chapters, 0) / seg.length)
    console.log(`  id ${label}: ${seg.length} 本, 平均章节 ${avg}, ≥100章 ${rich} 本, 0章 ${zeroCh} 本`)
  }
  // 前 8 本与后 8 本明细
  for (const n of [...novels.slice(0, 6), ...novels.slice(-6)]) {
    console.log(`  #${n.id} 《${n.title.slice(0, 20)}》 章节=${n._count.chapters} wc=${n.wordCount} 创建=${n.createdAt.toISOString().slice(5, 16)}`)
  }
  // 填充进度
  const [total, filled] = await Promise.all([db.chapter.count(), db.chapter.count({ where: { wordCount: { gt: 0 } } })])
  console.log(`\n正文填充: ${filled}/${total} (${((filled / Math.max(total, 1)) * 100).toFixed(1)}%)`)
  // 未分类进度
  const cat = await db.category.findMany({ include: { _count: { select: { novels: true } } } })
  console.log('分类:', cat.map((c) => `${c.name}:${c._count.novels}`).join(' '))
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
