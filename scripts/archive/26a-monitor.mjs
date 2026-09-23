import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const ids = process.argv[2] ? process.argv[2].split(',').map(Number) : [26, 27, 28, 29, 30, 31, 32, 33];
const ts = await db.scrapeTask.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
const now = new Date().toISOString().slice(11, 19);
for (const t of ts) {
  console.log(`T${t.id} ${String(t.status).padEnd(8)} books=${t.done}/${t.total} ch=${t.chaptersDone}/${t.chaptersTotal} cre=${t.created} upd=${t.updated} chN=${t.chapters} | ${now}`);
}
const ch = await db.chapter.count();
const nv = await db.novel.count();
const empty = await db.chapter.count({ where: { wordCount: 0 } });
console.log(`DB novels=${nv} chapters=${ch} emptySkeleton=${empty}`);
await db.$disconnect();
