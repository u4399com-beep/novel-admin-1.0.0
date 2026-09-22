/** 查看涉事小说详情与前 4 章 */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  for (const nid of [147, 149, 152, 153, 154, 158]) {
    const n = await db.novel.findUnique({ where: { id: nid }, select: { id: true, title: true, author: true, categoryId: true, _count: { select: { chapters: true } } } })
    const chs = await db.chapter.findMany({ where: { novelId: nid }, orderBy: { idx: 'asc' }, take: 4, select: { id: true, idx: true, title: true, wordCount: true } })
    console.log(`\nnovel#${nid} 《${n?.title}》 ${n?.author} 分类=${n?.categoryId} 章节数=${n?._count.chapters}`)
    for (const c of chs) console.log(`   idx=${c.idx} #${c.id} wc=${c.wordCount} "${c.title.slice(0, 30)}"`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
