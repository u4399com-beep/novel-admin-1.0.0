const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const t = await p.$queryRaw`SELECT name FROM sqlite_master WHERE type='table'`;
  console.log('tables:', t.map(r => r.name).join(','));
  await p.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
