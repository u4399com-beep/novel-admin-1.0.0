/**
 * 分类选择器离线自测（零网络）：把「拟新增/已配置」的 bookRule.categorySelector 应用到
 * 已抓取的真实书页 HTML（/tmp/probe-book/*.html，本轮 Task 12-h 低频探测留存），
 * 经引擎 extractBook 全链路（含 stripFieldLabel 标签剥离）验证 category 字段命中。
 *
 *   bun scripts/verify-category-selectors.ts
 *
 * 结论口径：category 非空且经主站归并规则 canonicalizeCategoryName 可归入规范集 = 通过。
 * 23qb 书页实测为关键用例（76 本未分类书的来源站）。
 */
import * as cheerio from 'cheerio'
import { extractBook } from '../mini-services/scraper-service/src/extract'
import { canonicalizeCategoryName } from '../src/lib/scrape/category'

/** 拟验证的 bookRule.categorySelector（与 scripts/fix-category-selectors.ts 落库值一字不差） */
const CASES: { ruleId: number; name: string; file: string; categorySelector: string; expect?: string }[] = [
  {
    ruleId: 10,
    name: 'aijjxs',
    file: '/tmp/probe-book/aijjxs.html',
    categorySelector: '.kv p:contains(书籍分类)',
    expect: '书籍分类：玄幻小说 行（依赖引擎 stripFieldLabel 剥「书籍分类：」前缀）',
  },
  {
    ruleId: 11,
    name: 'ddyueshu',
    file: '/tmp/probe-book/ddyueshu.html',
    categorySelector: 'meta[property="og:novel:category"]@content',
    expect: '历史小说（og meta）',
  },
  {
    ruleId: 12,
    name: '23qb',
    file: '/tmp/probe-book/23qb.html',
    categorySelector: '.novel-info-header a.tag-link[href*="lastupdate"]',
    expect: '都市小说（分类 tag 链接，与作者/状态 tag 同列）',
  },
  {
    ruleId: 13,
    name: 'huangjinwu',
    file: '/tmp/probe-book/huangjinwu.html',
    categorySelector: 'meta[property="og:novel:category"]@content',
    expect: '其他小说（og meta）',
  },
  {
    ruleId: 14,
    name: 'ggd66',
    file: '/tmp/probe-book/ggd66.html',
    categorySelector: 'meta[property="og:novel:category"]@content',
    expect: '玄幻魔法（og meta）',
  },
  {
    ruleId: 15,
    name: 'xinjianpan',
    file: '/tmp/probe-book/xinjianpan.html',
    categorySelector: 'meta[property="og:novel:category"]@content',
    expect: '其他小说（og meta）',
  },
]

/** 顺手复核 23qb 既有 statusSelector / catalogLinkSelector（Task 12-h 体检项） */
const EXTRA_23QB_CHECKS = {
  statusSelector: '.novel-info-header a.tag-link[href="javascript:;"]',
  catalogLinkSelector: 'a[href$="/catalog"]',
}

async function main() {
  let pass = 0
  let fail = 0
  for (const c of CASES) {
    const html = await Bun.file(c.file).text()
    const $ = cheerio.load(html)
    const warnings: string[] = []
    const book = extractBook($, { categorySelector: c.categorySelector }, `https://offline.test/`, warnings)
    const cat = book.category
    const merged = canonicalizeCategoryName(cat)
    const ok = cat.length > 0 && merged.rule !== 'none'
    if (ok) pass++
    else fail++
    console.log(
      `[rule ${c.ruleId} ${c.name}] categorySelector=${c.categorySelector}\n` +
        `  → category="${cat}" 归并=${merged.name}(${merged.rule})  ${ok ? '✓' : '✗ 未命中/无法归并'}` +
        (c.expect ? `  预期: ${c.expect}` : ''),
    )
  }

  // ---- 23qb 既有选择器复核（status/catalog） ----
  const html23 = await Bun.file('/tmp/probe-book/23qb.html').text()
  const $ = cheerio.load(html23)
  const b = extractBook(
    $,
    { statusSelector: EXTRA_23QB_CHECKS.statusSelector, catalogLinkSelector: EXTRA_23QB_CHECKS.catalogLinkSelector },
    'https://www.23qb.net/book/12449/',
    [],
  )
  console.log(`\n[rule 12 23qb 复核] status="${b.status}" catalogUrl=${b.catalogUrl}`)

  console.log(`\n自测结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

await main()
