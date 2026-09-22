import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.novel.findMany({ where: { sourceRuleId: 13 }, select: { id: true, title: true, cover: true, remoteCoverUrl: true }, take: 12 })
for (const r of rows) console.log(`#${r.id} ${r.cover} ⟵ ${r.remoteCoverUrl.slice(0, 70)} | ${r.title.slice(0, 16)}`)
await db.$disconnect()
