/**
 * 离线规则验证器（零网络请求）：把 DB 规则的 listRule/bookRule 应用到已抓取的真实 HTML，
 * 验证 itemSelector/封面选择器命中情况。bun run scripts/extract-offline.ts
 */
import * as cheerio from 'cheerio'
import { PrismaClient } from '@prisma/client'
import { extractBook, extractList } from '../mini-services/scraper-service/src/extract'

const db = new PrismaClient()

async function ruleById(id: number) {
  const r = await db.scrapeRule.findUnique({ where: { id } })
  if (!r) throw new Error(`rule ${id} missing`)
  return { listRule: JSON.parse(r.listRule), bookRule: JSON.parse(r.bookRule), name: r.name }
}

async function main() {
  // ---- listRule 离线验证 ----
  const listCases: { file: string; ruleId: number; label: string; override?: Record<string, string> }[] = [
    { file: '/tmp/probe/aijjxs-list.html', ruleId: 10, label: 'aijjxs 首页(现规则)' },
    { file: '/tmp/probe/aijjxs-cat.html', ruleId: 10, label: 'aijjxs 分类页(现规则)' },
    {
      file: '/tmp/probe/aijjxs-cat.html',
      ruleId: 10,
      label: 'aijjxs 分类页(拟更新)',
      override: {
        itemSelector: 'ul.lines-books li, ul.lines li',
        titleSelector: 'a',
        linkSelector: '.line-main a, a',
        authorSelector: '.author, .date',
        categorySelector: '.cat',
      },
    },
    { file: '/tmp/probe/23qb-list.html', ruleId: 12, label: '23qb lastupdate' },
    { file: '/tmp/probe/huangjinwu-list.html', ruleId: 13, label: 'huangjinwu 首页' },
    { file: '/tmp/probe/ggd66-list.html', ruleId: 14, label: 'ggd66 /sort/1/1/' },
    { file: '/tmp/probe/x2552-list2.html', ruleId: 17, label: 'x2552 /list/1/2/' },
    { file: '/tmp/probe/trxsw-list.html', ruleId: 18, label: 'trxsw /lastupdate/' },
    { file: '/tmp/probe/77shuku-home.txt', ruleId: 20, label: '77shuku 首页' },
    { file: '/tmp/probe/ddyueshu-list.html', ruleId: 11, label: 'ddyueshu 首页' },
  ]
  for (const c of listCases) {
    const { listRule } = await ruleById(c.ruleId)
    const rule = { ...listRule, ...c.override }
    const html = await Bun.file(c.file).text()
    const $ = cheerio.load(html)
    const warnings: string[] = []
    const base = 'https://offline.test/'
    const data = extractList($, rule, base, warnings)
    console.log(`[${c.label}] itemSelector="${rule.itemSelector}" → ${data.count} 条`)
    if (data.items[0]) console.log('   首条:', JSON.stringify(data.items[0]))
    if (data.items[1]) console.log('   次条:', JSON.stringify(data.items[1]))
    if (warnings.length) console.log('   warnings:', warnings.slice(0, 2))
  }

  // ---- bookRule catalogUrl / cover 离线复核（有 html 的场景） ----
  console.log('\n---- catalogUrl 字段核对（来自引擎书页探测 payload） ----')
  for (const tag of ['aijjxs-book', 'x2552-book', 'ggd66-book', '23qb-book', '77shuku-book', 'xinjianpan-book', 'huangjinwu-book']) {
    try {
      const j = await Bun.file(`/tmp/probe/${tag}.json`).json()
      const book = j.payload?.data?.book
      if (book) console.log(`[${tag}] catalogUrl=${book.catalogUrl} cover=${book.cover}`)
    } catch {
      /* skip */
    }
  }
}

await main()
await db.$disconnect()
