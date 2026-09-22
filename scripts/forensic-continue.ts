/**
 * 只读取证脚本：任务状态 / 数据量 / 「立即阅读」标题污染 / 目录异常统计
 * 用法: bun scripts/forensic-continue.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  // 1. 任务状态
  const tasks = await db.scrapeTask.findMany({
    orderBy: { id: 'desc' },
    take: 15,
    select: { id: true, status: true, ruleId: true, mode: true, pages: true, total: true, done: true, chapters: true, message: true, targetUrl: true },
  })
  console.log('=== 最近 15 条任务 ===')
  for (const t of tasks) console.log(`#${t.id} [${t.status}] rule=${t.ruleId} mode=${t.mode} pages=${t.pages} done=${t.done}/${t.total} ch=${t.chapters} ${t.targetUrl.slice(0, 50)}`)

  // 2. 数据量
  const [novels, chapters, filled, cats] = await Promise.all([
    db.novel.count(), db.chapter.count(), db.chapter.count({ where: { wordCount: { gt: 0 } } }), db.category.findMany({ include: { _count: { select: { novels: true } } } }),
  ])
  console.log(`\n=== 数据量 ===\n小说 ${novels} / 章节 ${chapters} / 已填正文 ${filled} (${((filled / Math.max(chapters, 1)) * 100).toFixed(1)}%)`)
  console.log('分类:', cats.map((c) => `${c.name}:${c._count.novels}`).join(' '))

  // 3. 「立即阅读」类标题污染
  const bad = await db.chapter.findMany({
    where: { title: { contains: '立即阅读' } },
    select: { id: true, novelId: true, idx: true, title: true },
    take: 20,
  })
  const badCount = await db.chapter.count({ where: { title: { contains: '立即阅读' } } })
  console.log(`\n=== 「立即阅读」标题章节: ${badCount} 条 ===`)
  for (const b of bad) console.log(`  ch#${b.id} novel=${b.novelId} idx=${b.idx} title="${b.title}"`)
  const badNovels = await db.chapter.findMany({
    where: { title: { contains: '立即阅读' } },
    select: { novelId: true },
    distinct: ['novelId'],
  })
  console.log(`涉及小说数: ${badNovels.length}`)

  // 4. 目录异常统计（复用 audit 逻辑核心指标）
  const dupGroups = await db.$queryRaw<Array<{ novelId: number; title: string; c: number }>>`
    SELECT novelId, title, COUNT(*) as c FROM Chapter GROUP BY novelId, title HAVING c > 1 ORDER BY c DESC LIMIT 10`
  const dupTotal = await db.$queryRaw<Array<{ c: number }>>`
    SELECT COUNT(*) as c FROM (SELECT novelId, title FROM Chapter GROUP BY novelId, title HAVING COUNT(*) > 1)`
  console.log(`\n=== 重复标题组: ${dupTotal[0]?.c ?? 0} 组（top10）===`)
  for (const g of dupGroups) console.log(`  novel=${g.novelId} "${g.title}" x${g.c}`)

  // 5. 空 content 但 wordCount=0 的骨架统计
  const emptySkeleton = chapters - filled
  console.log(`\n=== 空骨架（未填正文）: ${emptySkeleton} 章 ===`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
