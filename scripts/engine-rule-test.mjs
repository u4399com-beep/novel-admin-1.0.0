/**
 * engine-rule-test.mjs —— 采集规则三段试测工具（面向现行 Go 引擎 scraper-go :3030）。
 *
 * 从 DB（Prisma 直连 SQLite）读指定规则，向引擎发抓取请求并打印提取摘要，
 * 用于规则校准/排障（对齐 docs/scrape-rules.md 的三段实测流程）。
 *
 * 用法：
 *   bun scripts/engine-rule-test.mjs <规则名> <URL> [list|book|chapter]
 * 例：
 *   bun scripts/engine-rule-test.mjs aijjxs "https://aijjxs.com" list
 * 前置：引擎在 3030 在线（curl :3030/api/health）；需先 bun run db:generate 生成 Prisma Client。
 */
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const name = process.argv[2];
const url = process.argv[3];
const seg = process.argv[4] ?? 'list'; // list | book | chapter
const rule = await db.scrapeRule.findUnique({ where: { name } });
const ruleKey = seg === 'list' ? 'listRule' : 'bookRule';
const rulePayload = seg === 'chapter' ? JSON.parse(rule.chapterRule) : { [ruleKey]: JSON.parse(rule[ruleKey]) };
const body = { url, rule: rulePayload, charset: rule.charset, ...(rule.insecureTLS ? { insecureTLS: true } : {}), timeoutMs: 30000 };
const res = await fetch('http://127.0.0.1:3030/api/' + (seg === 'chapter' ? 'chapter' : 'test'), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
const j = await res.json();
console.log('ok:', j.ok, 'strategy:', j.strategy, 'status:', j.status);
if (j.data?.list) {
  console.log('items:', j.data.list.count);
  for (const it of j.data.list.items.slice(0,5)) console.log(' -', it.title, '|', it.author, '|', it.category, '|', it.url);
}
if (j.data?.book) {
  console.log('title:', j.data.book.title, '| author:', j.data.book.author, '| status:', j.data.book.status);
  console.log('cover:', j.data.book.cover);
  console.log('desc:', (j.data.book.description ?? '').slice(0,80));
  console.log('chapters:', j.data.book.chapterCount, '首:', JSON.stringify(j.data.book.chapters?.[0]), '末:', JSON.stringify(j.data.book.chapters?.at(-1)));
}
if (j.data?.title !== undefined && seg === 'chapter') {
  console.log('title:', j.data.title, '| words:', j.data.wordCount);
  console.log('content:', (j.data.content ?? '').slice(0,150).replaceAll('\n',' / '));
}
console.log('warnings:', (j.warnings ?? []).slice(0,6));
await db.$disconnect();
