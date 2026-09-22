/**
 * 清库重采前取证审计（只读，不改任何数据）
 *
 * 产出：
 * 1. 各表行数
 * 2. 分类分布（定位"分类过多"与"未分类"规模）
 * 3. 未分类书籍样本 + 通过任务日志交叉溯源其来源规则/站点
 * 4. 章节健康度：同书重复标题 / idx 断档 / 空正文章节 / 无章节书
 * 5. ScrapeRule.listRule 现状（确认是否存在分页模板字段）
 *
 * 运行：bun scripts/preclear-audit.ts
 */
import { db } from '../src/lib/db'

async function main(): Promise<void> {
  const [novels, chapters, categories, rules, tasks, pseo, site] = await Promise.all([
    db.novel.count(),
    db.chapter.count(),
    db.category.count(),
    db.scrapeRule.count(),
    db.scrapeTask.count(),
    db.pseoKeyword.count(),
    db.siteSetting.count(),
  ])
  console.log('== 表行数 ==')
  console.log(JSON.stringify({ novels, chapters, categories, rules, tasks, pseo, site }))

  console.log('\n== 分类分布（按书数降序） ==')
  const cats = await db.category.findMany({
    select: { id: true, name: true, _count: { select: { novels: true } } },
    orderBy: [{ novels: { _count: 'desc' } }, { id: 'asc' }],
  })
  for (const c of cats) console.log(`  #${c.id}\t${c.name}\t${c._count.novels}本`)

  console.log('\n== 未分类书籍样本（≤40） ==')
  const uncCats = cats.filter((c) => /未分类|其他|unknown/i.test(c.name))
  const uncCatIds = uncCats.map((c) => c.id)
  const uncNovels = uncCatIds.length
    ? await db.novel.findMany({
        where: { categoryId: { in: uncCatIds } },
        select: { id: true, title: true, author: true, categoryId: true, createdAt: true },
        orderBy: { id: 'asc' },
        take: 40,
      })
    : []
  for (const n of uncNovels) console.log(`  #${n.id}\tcat${n.categoryId}\t《${n.title}》/${n.author}\t${n.createdAt.toISOString().slice(0, 10)}`)
  console.log(`  未分类类目: ${JSON.stringify(uncCats.map((c) => ({ id: c.id, name: c.name, count: c._count.novels })))}`)

  // 通过任务日志交叉溯源未分类书籍来源（任务日志有《书名》行）
  console.log('\n== 未分类书籍来源溯源（任务日志匹配） ==')
  const taskLogs = await db.scrapeTask.findMany({
    select: { id: true, ruleId: true, mode: true, targetUrl: true, log: true },
    orderBy: { id: 'asc' },
  })
  const rulesAll = await db.scrapeRule.findMany({ select: { id: true, name: true, siteUrl: true } })
  const ruleName = (id: number | null): string => {
    if (!id) return '无规则'
    const r = rulesAll.find((x) => x.id === id)
    return r ? `${r.name}(${r.siteUrl})` : `规则#${id}已删`
  }
  const found = new Map<string, string>()
  for (const t of taskLogs) {
    for (const line of (t.log || '').split('\n')) {
      const m = line.match(/《(.+?)》/)
      if (!m) continue
      const title = m[1].slice(0, 30)
      for (const n of uncNovels) {
        if (n.title.startsWith(title) || title.startsWith(n.title.slice(0, 20))) {
          if (!found.has(n.title)) found.set(n.title, `task#${t.id} ${ruleName(t.ruleId)} [${t.mode}] ${t.targetUrl.slice(0, 50)}`)
        }
      }
    }
  }
  for (const [title, src] of found) console.log(`  《${title}》← ${src}`)
  if (found.size === 0) console.log('  （任务日志无匹配——任务历史可能已被删除）')

  console.log('\n== 章节健康度 ==')
  // 同书重复标题
  const dupTitles = await db.$queryRaw<{ novelId: number; title: string; c: number }[]>`
    SELECT novelId, title, COUNT(*) as c FROM Chapter
    GROUP BY novelId, title HAVING c > 1 ORDER BY c DESC LIMIT 15`
  console.log(`  同书重复标题组数(采样≤15): ${dupTitles.length}`)
  for (const d of dupTitles) console.log(`    novel#${d.novelId}「${d.title.slice(0, 30)}」x${d.c}`)

  // idx 断档：章节行数 != maxIdx（含删章造成的洞）；SQLite 聚合返回 bigint，统一 Number 化
  const gapsRaw = await db.$queryRaw<{ id: number; title: string; chapters: bigint; maxIdx: bigint | null }[]>`
    SELECT n.id, n.title, COUNT(c.id) as chapters, MAX(c.idx) as maxIdx
    FROM Novel n JOIN Chapter c ON c.novelId = n.id
    GROUP BY n.id HAVING COUNT(c.id) != MAX(c.idx) + 1 ORDER BY (MAX(c.idx) + 1 - COUNT(c.id)) DESC LIMIT 15`
  const gaps = gapsRaw.map((g) => ({ ...g, chapters: Number(g.chapters), maxIdx: Number(g.maxIdx) }))
  console.log(`  idx 断档书数(采样≤15): ${gaps.length}`)
  for (const g of gaps) console.log(`    #${g.id}《${g.title.slice(0, 24)}》rows=${g.chapters} maxIdx=${g.maxIdx} 缺洞=${g.maxIdx + 1 - g.chapters}`)

  const [emptyChapters, noChapterBooks, zeroWordBooks] = await Promise.all([
    db.chapter.count({ where: { wordCount: 0 } }),
    db.novel.count({ where: { chapters: { none: {} } } }),
    db.novel.count({ where: { wordCount: 0 } }),
  ])
  console.log(`  空正文章节(wordCount=0): ${emptyChapters}`)
  console.log(`  无章节书: ${noChapterBooks}`)
  console.log(`  零字书: ${zeroWordBooks}`)

  console.log('\n== ScrapeRule 清单（含 listRule 原文，确认分页模板现状） ==')
  const ruleRows = await db.scrapeRule.findMany({ select: { id: true, name: true, siteUrl: true, enabled: true, proxy: true, listRule: true } })
  for (const r of ruleRows) {
    console.log(`  #${r.id} ${r.name} ${r.siteUrl} enabled=${r.enabled} proxy=${r.proxy || '-'} listRule=${r.listRule.slice(0, 220)}`)
  }

  console.log('\n== ScrapeTask 现存任务 ==')
  for (const t of taskLogs) {
    console.log(`  task#${t.id} rule=${ruleName(t.ruleId)} mode=${t.mode} url=${t.targetUrl.slice(0, 60)}`)
  }
}

main()
  .catch((e) => {
    console.error('审计失败:', e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
