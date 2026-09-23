/**
 * 规则体检修复脚本（Task 12-h）：为缺失 bookRule.categorySelector 的采集规则补配分类选择器。
 *
 *   bun scripts/fix-category-selectors.ts           # dry-run：打印逐站体检结论与拟落库 JSON
 *   bun scripts/fix-category-selectors.ts --apply   # 实际落库（幂等：值相同则跳过）
 *
 * 背景：76 本未分类书全部来自 rule 12（23qb）——其 bookRule 缺 categorySelector，
 * 引擎提取不到分类 → book.category='' → ensureCategory 兜底「未分类」。
 * 本轮低频探测（每站 ≤1 次书页请求，HTML 留存 /tmp/probe-book/）确认各站分类元素：
 *   - 23qb      .novel-info-header a.tag-link[href*="lastupdate"]（分类 tag 链接，
 *               与作者 [href*="/author/"]、状态 [href="javascript:;"]、字数 span.tag-link 同列可区分）
 *   - aijjxs    .kv p:contains(书籍分类)（「书籍分类：玄幻小说」行；
 *               引擎 extract.ts stripFieldLabel 已同步支持剥「书籍」前缀）
 *   - ddyueshu / huangjinwu / ggd66 / xinjianpan：书页均输出 og:novel:category meta，
 *               显式补配（此前仅靠引擎内置回退，显式化后不依赖回退顺序）
 * 其余规则（16/17/18/19/20）已配置 categorySelector，体检通过不改动：
 *   - 16 101kks / 20 77shuku：og meta 显式配置（77shuku 存量 4 书分类落库正确）
 *   - 17 x2552 / 19 pilishuwu：#at tr td:nth-of-type(1) a（x2552 存量 4 书正确；19 CF 拦截未实测，草稿维持）
 *   - 18 trxsw：td:contains(小说分类)（存量 1 书正确）
 * 注：前期汇报中的「[h 字符丢失 bug」（aref$=… / tag-linkref=…）经 DB 字节级核验
 * （长度 + contains('[h') 布尔）确认为 IM 网关 bash 输出显示假象，库内字节完整正确，无需修复。
 */
import { PrismaClient } from '@prisma/client'

const apply = process.argv.includes('--apply')

const db = new PrismaClient()

/** 拟补配的 categorySelector（与 scripts/verify-category-selectors.ts 自测值一字不差） */
const FIXES: { id: number; name: string; categorySelector: string; note: string }[] = [
  {
    id: 12,
    name: '23qb',
    categorySelector: '.novel-info-header a.tag-link[href*="lastupdate"]',
    note: 'Task 12-h 补配 bookRule.categorySelector（书页 .novel-info-header 分类 tag 链接；76 本未分类书根因修复）',
  },
  {
    id: 10,
    name: 'aijjxs',
    categorySelector: '.kv p:contains(书籍分类)',
    note: 'Task 12-h 补配 bookRule.categorySelector（书籍分类：行；引擎 stripFieldLabel 同步剥「书籍」前缀）',
  },
  {
    id: 11,
    name: 'ddyueshu',
    categorySelector: 'meta[property="og:novel:category"]@content',
    note: 'Task 12-h 显式补配 bookRule.categorySelector（书页 og:novel:category meta）',
  },
  {
    id: 13,
    name: 'huangjinwu',
    categorySelector: 'meta[property="og:novel:category"]@content',
    note: 'Task 12-h 显式补配 bookRule.categorySelector（书页 og:novel:category meta）',
  },
  {
    id: 14,
    name: 'ggd66',
    categorySelector: 'meta[property="og:novel:category"]@content',
    note: 'Task 12-h 显式补配 bookRule.categorySelector（书页 og:novel:category meta）',
  },
  {
    id: 15,
    name: 'xinjianpan',
    categorySelector: 'meta[property="og:novel:category"]@content',
    note: 'Task 12-h 显式补配 bookRule.categorySelector（书页 og:novel:category meta）',
  },
]

async function main() {
  console.log(apply ? '== 修复落库模式 ==' : '== dry-run（加 --apply 落库）==\n')
  for (const fix of FIXES) {
    const r = await db.scrapeRule.findUnique({ where: { id: fix.id } })
    if (!r) {
      console.log(`[id=${fix.id} ${fix.name}] 规则不存在，跳过`)
      continue
    }
    const book = (JSON.parse(r.bookRule || '{}') as Record<string, string>) ?? {}
    const before = book.categorySelector ?? '(缺失)'
    if (before === fix.categorySelector) {
      console.log(`[id=${fix.id} ${fix.name}] categorySelector 已是目标值，跳过`)
      continue
    }
    console.log(`[id=${fix.id} ${fix.name}] categorySelector: ${before} → ${fix.categorySelector}`)
    if (!apply) continue
    const updated = { ...book, categorySelector: fix.categorySelector }
    await db.scrapeRule.update({
      where: { id: fix.id },
      data: {
        bookRule: JSON.stringify(updated),
        notes: `${r.notes || ''}\n${fix.note}`.trim().slice(0, 2000),
      },
    })
    console.log(`  ✓ 已落库（notes 已追加）`)
  }
  console.log(apply ? '\n完成。' : '\ndry-run 结束，未改动数据库。')
  await db.$disconnect()
}

main().catch(async (e) => {
  console.error('执行失败：', e instanceof Error ? e.message : e)
  await db.$disconnect().catch(() => {})
  process.exit(1)
})
