/**
 * 临时脚本：导出全部 ScrapeRule 的关键字段，供规则编写参考。
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const rules = await db.scrapeRule.findMany({ orderBy: { id: 'asc' } })
  for (const r of rules) {
    console.log(`\n===== id=${r.id} name=${r.name} =====`)
    console.log(`siteUrl: ${r.siteUrl}`)
    console.log(`charset: ${r.charset}  proxy: ${r.proxy || '(直连)'}  enabled: ${r.enabled}`)
    console.log(`listRule: ${r.listRule}`)
    console.log(`bookRule: ${r.bookRule}`)
    console.log(`chapterRule: ${r.chapterRule}`)
    console.log(`notes: ${(r.notes || '').slice(0, 300)}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
