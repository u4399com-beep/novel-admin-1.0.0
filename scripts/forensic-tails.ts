/** 检查 idx=1 跳转链接是否与尾部章节重复 */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  for (const nid of [149, 152, 153, 154, 158, 147]) {
    const first = await db.chapter.findFirst({ where: { novelId: nid }, orderBy: { idx: 'asc' }, select: { idx: true, title: true, wordCount: true } })
    const last = await db.chapter.findMany({ where: { novelId: nid }, orderBy: { idx: 'desc' }, take: 2, select: { idx: true, title: true, wordCount: true } })
    console.log(`novel#${nid} 首=${JSON.stringify(first)} 尾=${JSON.stringify(last.reverse())}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
