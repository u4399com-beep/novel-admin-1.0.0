/** 快速诊断：规则 siteUrl/listRule 配置 + aijjxs 列表 warnings + 101kks 策略链 */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const rules = await db.scrapeRule.findMany({ orderBy: { id: 'asc' } })
  for (const r of rules) {
    const list = JSON.parse(r.listRule || '{}') as Record<string, unknown>
    console.log(`#${r.id} ${r.name} siteUrl=${r.siteUrl} proxy=${r.proxy || '-'} 分页模板=${String(list.paginationTemplate ?? '-')}`)
    console.log(`   itemSelector=${String(list.itemSelector ?? '-')} linkSelector=${String(list.linkSelector ?? '-')}`)
    const book = JSON.parse(r.bookRule || '{}') as Record<string, unknown>
    console.log(`   catalogLinkSelector=${String(book.catalogLinkSelector ?? '-')} chapterLinkSelector=${String(book.chapterLinkSelector ?? '-')}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
