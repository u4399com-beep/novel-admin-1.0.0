/**
 * 存量分类合并脚本（治理近义分类泛滥）：
 *   bun scripts/merge-categories.ts          # 默认 dry-run，只打印合并计划
 *   bun scripts/merge-categories.ts --apply  # 实际执行（迁书 → 删空源分类 → 清理 0 书空分类）
 *
 * 复用 src/lib/scrape/category.ts 的同一套归并规则（a 归一化+同义词 / b 规范词包含，纯规则、
 * 确定性、零网络），保证「存量治理」与「未来新采集」（ensureCategory）归类口径一致。
 *
 * 执行语义：
 *   1. 扫描 Category + Novel 分布，对每个「归并目标 ≠ 自身名」的分类生成合并计划；
 *   2. 目标分类不存在时先创建（如 N次元 → 同人 的「同人」）；
 *   3. 事务式迁移：novels.categoryId 批量指向目标 → 删除空的源分类（任一步失败整体回滚）；
 *   4. 收尾清理合并后 0 书籍的空分类（「未分类」保留除外），并输出前后对比。
 */
import { PrismaClient } from '@prisma/client'
import {
  canonicalizeCategoryName,
  describeCanonicalMatch,
  RESERVED_CATEGORY_NAME,
} from '../src/lib/scrape/category'

const apply = process.argv.includes('--apply')

const db = new PrismaClient()

/** 分类行（含书籍数）统一查询 */
async function loadCategories() {
  return db.category.findMany({
    orderBy: { sort: 'asc' },
    include: { _count: { select: { novels: true } } },
  })
}

/** 打印分类分布快照 */
function printSnapshot(title: string, cats: Awaited<ReturnType<typeof loadCategories>>) {
  const totalBooks = cats.reduce((n, c) => n + c._count.novels, 0)
  console.log(`\n${title}：共 ${cats.length} 个分类 / ${totalBooks} 本书`)
  for (const c of cats) {
    console.log(`  #${c.id}\t${c.name}\t${c._count.novels} 本`)
  }
}

async function main() {
  const before = await loadCategories()
  printSnapshot(apply ? '【执行前】' : '【当前状态】', before)
  const totalBooks = before.reduce((n, c) => n + c._count.novels, 0)
  const byName = new Map(before.map((c) => [c.name, c]))

  // ---- 生成合并计划：套用 category.ts 同一套归并规则 ----
  type PlanItem = {
    sourceId: number
    sourceName: string
    bookCount: number
    targetName: string
    targetExists: boolean
    reason: string
  }
  const plan: PlanItem[] = []
  for (const c of before) {
    // 保留分类永不作为合并源（「未分类」是系统兜底去处）
    if (c.name === RESERVED_CATEGORY_NAME) continue
    const m = canonicalizeCategoryName(c.name)
    // 规则未命中（需 LLM 或人工判断）→ 不自动合并
    if (m.rule === 'none') continue
    // 目标与自身同名（已归类到位）/ 目标是保留名（防御：避免制造「未分类」堆积）→ 跳过。
    // 注意不能按 rule==='canonical' 跳过：如「科幻小说」归一化后即规范名「科幻」，rule=canonical
    // 但库名与目标不同，仍需合并。
    if (m.name === c.name || m.name === RESERVED_CATEGORY_NAME) continue
    plan.push({
      sourceId: c.id,
      sourceName: c.name,
      bookCount: c._count.novels,
      targetName: m.name,
      targetExists: byName.has(m.name),
      reason: describeCanonicalMatch(m),
    })
  }

  if (plan.length === 0) {
    console.log('\n未发现可合并的近义分类，无需操作。')
    await db.$disconnect()
    return
  }

  console.log(`\n合并计划（${plan.length} 组）：`)
  for (const p of plan) {
    console.log(
      `  ${p.sourceName}（${p.bookCount} 本）→ ${p.targetName}${p.targetExists ? '' : '（目标不存在，将新建）'}  [${p.reason}]`
    )
  }

  if (!apply) {
    console.log('\ndry-run 结束：以上为计划，未改动数据库。确认无误后加 --apply 执行。')
    await db.$disconnect()
    return
  }

  // ---- 执行合并 ----
  let movedTotal = 0
  for (const p of plan) {
    // 目标分类不存在则先建（sort 沿用源分类位置，前台导航顺序尽量不变）
    let target = await db.category.findUnique({ where: { name: p.targetName } })
    if (!target) {
      const src = byName.get(p.sourceName)
      target = await db.category.create({ data: { name: p.targetName, sort: src?.sort ?? 0 } })
      console.log(`  已新建目标分类「${target.name}」(#${target.id})`)
    }
    const targetRow = target // const 快照：闭包内类型收窄 + 防御后续重赋值
    if (targetRow.id === p.sourceId) continue // 防御：目标与源同 id（理论上不可能）
    // 事务式：迁书 → 删空源分类；任一步失败整体回滚（不会出现书迁了源分类还在的中间态落库）
    const moved = await db.$transaction(async (tx) => {
      const r = await tx.novel.updateMany({
        where: { categoryId: p.sourceId },
        data: { categoryId: targetRow.id },
      })
      await tx.category.delete({ where: { id: p.sourceId } })
      return r.count
    })
    movedTotal += moved
    console.log(`  ✓ ${p.sourceName}（${p.bookCount} 本）→ ${targetRow.name}：迁移 ${moved} 本，源分类已删除`)
  }

  // ---- 收尾：清理合并后 0 书籍的空分类（保留「未分类」；规范分类 0 书时同样可删，ensureCategory 按需重建）----
  let pruned = 0
  for (const c of await loadCategories()) {
    if (c.name === RESERVED_CATEGORY_NAME) continue
    if (c._count.novels > 0) continue
    await db.category.delete({ where: { id: c.id } })
    pruned++
    console.log(`  ✓ 清理空分类「${c.name}」（0 本）`)
  }

  // ---- 前后对比 ----
  const after = await loadCategories()
  printSnapshot('【执行后】', after)
  const afterBooks = after.reduce((n, c) => n + c._count.novels, 0)
  console.log(
    `\n完成：分类 ${before.length} → ${after.length}（-${before.length - after.length}），` +
      `迁移书籍 ${movedTotal} 本，清理空分类 ${pruned} 个；` +
      `书籍总数核对 ${totalBooks} → ${afterBooks} ${totalBooks === afterBooks ? '一致 ✓' : '不一致 ✗（异常！）'}`
  )
  await db.$disconnect()
}

main().catch(async (e) => {
  console.error('执行失败：', e instanceof Error ? e.message : e)
  await db.$disconnect().catch(() => {})
  process.exit(1)
})
