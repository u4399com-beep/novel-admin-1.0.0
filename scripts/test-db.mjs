import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  const r = await db.$queryRaw`SELECT 1 as ok`;
  console.log('DB OK:', JSON.stringify(r));
  const tables = await db.novel.count();
  console.log('Novels count:', tables);
  const cats = await db.category.count();
  console.log('Categories count:', cats);
} catch (e) {
  console.error('DB ERR:', e instanceof Error ? e.message : e);
} finally {
  await db.$disconnect();
}
