/**
 * 清库重采脚本：删除全部小说业务数据并重置自增 ID（数据库从 1 开始计数）
 *
 * 删除范围：Chapter → Novel → Category（规范类由分类归并逻辑重采后自动重建）
 *          ScrapeTask（任务历史）；PseoKeyword 重置为 pending（pageData 引用旧书 id 悬空）
 * 保留：ScrapeRule（11 条采集规则）、SiteSetting（站点配置）
 * 附带：清 public/covers/*.webp（按书 id 命名，书已删即失效）、VACUUM 回收空间
 *
 * 默认 dry-run 只打印将执行的操作；--apply 才真正执行。
 * 运行：bun scripts/reset-db.ts [--apply]
 */
import { rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { db } from '../src/lib/db'

const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const [novels, chapters, categories, tasks, pseo, rules, site] = await Promise.all([
    db.novel.count(),
    db.chapter.count(),
    db.category.count(),
    db.scrapeTask.count(),
    db.pseoKeyword.count(),
    db.scrapeRule.count(),
    db.siteSetting.count(),
  ])
  console.log(`== 清库前 == novels=${novels} chapters=${chapters} categories=${categories} tasks=${tasks} pseo=${pseo} | 保留 rules=${rules} site=${site}`)
  if (rules === 0) throw new Error('ScrapeRule 为 0 条，疑似连配置也丢了，拒绝执行清库')

  const coversDir = 'public/covers'
  const coverFiles = existsSync(coversDir) ? readdirSync(coversDir).filter((f) => f.endsWith('.webp')) : []

  if (!APPLY) {
    console.log('[dry-run] 将执行：')
    console.log(`  1. DELETE Chapter(${chapters}) → Novel(${novels}) → Category(${categories}) → ScrapeTask(${tasks})`)
    console.log(`  2. PseoKeyword(${pseo}) 全部重置 status=pending, pageData=null`)
    console.log(`  3. DELETE FROM sqlite_sequence WHERE name IN ('Novel','Chapter','Category','ScrapeTask')`)
    console.log(`  4. rm public/covers/*.webp (${coverFiles.length} 个)`)
    console.log('  5. VACUUM')
    console.log('加 --apply 执行')
    return
  }

  // 1. 按依赖顺序删（Chapter.novelId FK → Novel；Novel.categoryId FK → Category）
  const delChapters = await db.chapter.deleteMany({})
  const delNovels = await db.novel.deleteMany({})
  const delCategories = await db.category.deleteMany({})
  const delTasks = await db.scrapeTask.deleteMany({})
  console.log(`已删：Chapter=${delChapters.count} Novel=${delNovels.count} Category=${delCategories.count} ScrapeTask=${delTasks.count}`)

  // 2. PSEO 关键词保留、生成数据重置（重采后可重新生成聚合页）
  const resetPseo = await db.pseoKeyword.updateMany({ data: { status: 'pending', pageData: null } })
  console.log(`PSEO 关键词已重置 pending：${resetPseo.count}`)

  // 3. 重置自增序列（AUTOINCREMENT 表仅 DELETE 数据不会归零，必须清 sqlite_sequence）
  const seqNames = ["'Novel'", "'Chapter'", "'Category'", "'ScrapeTask'"]
  await db.$executeRawUnsafe(`DELETE FROM sqlite_sequence WHERE name IN (${seqNames.join(',')})`)
  const seqLeft = await db.$queryRaw<{ name: string; seq: bigint }[]>`SELECT name, seq FROM sqlite_sequence`
  console.log(`sqlite_sequence 剩余: ${seqLeft.map((r) => `${r.name}=${r.seq}`).join(', ') || '(empty)'}`)

  // 4. 清封面文件
  for (const f of coverFiles) await rm(`${coversDir}/${f}`, { force: true })
  console.log(`已删封面文件 ${coverFiles.length} 个`)

  // 5. VACUUM（SQLite 文件收缩；必须在无活动事务时执行）
  await db.$executeRawUnsafe('VACUUM')

  // 6. 终态验证
  const [n2, c2, cat2, t2] = await Promise.all([db.novel.count(), db.chapter.count(), db.category.count(), db.scrapeTask.count()])
  console.log(`== 清库后 == novels=${n2} chapters=${c2} categories=${cat2} tasks=${t2}（应全为 0）`)
  const probe = await db.$queryRaw<{ seq: number | null }[]>`SELECT seq FROM sqlite_sequence WHERE name='Novel'`
  console.log(`Novel 序列探针: ${JSON.stringify(probe)}（空数组=下次插入从 1 开始）`)
  console.log('✅ 清库完成，数据库从 1 开始计数')
}

main()
  .catch((e) => {
    console.error('清库失败:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
