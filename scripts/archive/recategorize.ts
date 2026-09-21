/**
 * 未分类书批量重归类：对 category=「未分类」的书，用书名+简介走 LLM 推断规范类。
 * 复用 src/lib/scrape/category.ts 的三级归并 + LLM 串行/冷却/缓存治理。
 *
 * 默认 dry-run 只打印归类计划；--apply 才更新 DB。
 * 运行：bun scripts/recategorize.ts [--apply] [--limit 30]
 */
import { db } from '../../src/lib/db'
import { canonicalCategoryWithHint, FALLBACK_CATEGORY } from '../../src/lib/scrape/category'

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const limitIdx = process.argv.indexOf('--limit')
  const limit = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) || 0 : 0

  const unc = await db.category.findUnique({ where: { name: FALLBACK_CATEGORY }, include: { novels: { select: { id: true, title: true, description: true } } } })
  if (!unc || unc.novels.length === 0) {
    console.log('没有未分类书籍')
    return
  }
  let books = unc.novels
  if (limit > 0) books = books.slice(0, limit)
  console.log(`未分类书 ${unc.novels.length} 本，本次处理 ${books.length} 本（${apply ? 'APPLY' : 'dry-run'}）`)

  let moved = 0
  let still = 0
  const plan = new Map<string, number[]>()
  const pending: typeof books = []
  for (const b of books) {
    const canon = await canonicalCategoryWithHint('', { title: b.title, description: b.description })
    if (canon === FALLBACK_CATEGORY) {
      pending.push(b) // 冷却窗/限流内未判定：留待下轮重试
      continue
    }
    moved++
    const arr = plan.get(canon) ?? []
    arr.push(b.id)
    plan.set(canon, arr)
    console.log(`  《${b.title.slice(0, 26)}》→ ${canon}`)
  }

  // LLM 冷却重试轮：429 冷却窗 30s，等一窗再试残余（最多 2 轮）
  for (let round = 1; round <= 2 && pending.length > 0; round++) {
    console.log(`  [冷却重试轮 ${round}] 等待 32s 后重试 ${pending.length} 本…`)
    await new Promise((r) => setTimeout(r, 32_000))
    const next: typeof books = []
    for (const b of pending) {
      const canon = await canonicalCategoryWithHint('', { title: b.title, description: b.description })
      if (canon === FALLBACK_CATEGORY) {
        next.push(b)
        continue
      }
      moved++
      const arr = plan.get(canon) ?? []
      arr.push(b.id)
      plan.set(canon, arr)
      console.log(`  《${b.title.slice(0, 26)}》→ ${canon}`)
    }
    pending.length = 0
    pending.push(...next)
  }
  still = pending.length
  if (pending.length > 0) {
    console.log(`  仍无法判断 ${pending.length} 本：`)
    for (const b of pending) console.log(`    《${b.title.slice(0, 26)}》`)
  }

  if (!apply) {
    console.log(`dry-run 完成：可归类 ${moved} 本，仍未知 ${still} 本。加 --apply 落库`)
    await db.$disconnect()
    return
  }

  for (const [canon, ids] of plan) {
    const cat = await db.category.upsert({ where: { name: canon }, update: {}, create: { name: canon } })
    const res = await db.novel.updateMany({ where: { id: { in: ids } }, data: { categoryId: cat.id } })
    console.log(`  ${canon}: ${res.count} 本已更新`)
  }
  // 清理可能残留的空「未分类」行不做（保留兜底类供未来使用）
  console.log(`完成：归类 ${moved} 本，仍未知 ${still} 本`)
}

main()
  .catch((e) => {
    console.error('失败:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
