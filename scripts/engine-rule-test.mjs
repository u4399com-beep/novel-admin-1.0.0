/**
 * engine-rule-test.mjs —— 采集规则三段试测工具（面向现行 Go 引擎 scraper-go :3030）。
 *
 * 通过 backend API（:3000 /api/scrape-rules）读指定规则（Task 44 起替代已拆除的
 * Prisma 直连——纯 Go 栈零 Node DB 依赖），向引擎发抓取请求并打印提取摘要，
 * 用于规则校准/排障（对齐 docs/scrape-rules.md 的三段实测流程）。
 *
 * 用法：
 *   bun scripts/engine-rule-test.mjs <规则名> <URL> [list|book|chapter]
 * 例：
 *   bun scripts/engine-rule-test.mjs aijjxs "https://aijjxs.com" list
 * 前置：引擎在 3030 在线（curl :3030/api/health）；backend 在 3000 在线（curl :3000/api/health）。
 */
const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:3000';
const ENGINE = process.env.ENGINE_URL ?? 'http://127.0.0.1:3030';

const name = process.argv[2];
const url = process.argv[3];
const seg = process.argv[4] ?? 'list'; // list | book | chapter
if (!name || !url) {
  console.error('用法: bun scripts/engine-rule-test.mjs <规则名> <URL> [list|book|chapter]');
  process.exit(1);
}

const rulesRes = await fetch(`${BACKEND}/api/scrape-rules`);
if (!rulesRes.ok) {
  console.error(`规则读取失败: backend ${BACKEND} HTTP ${rulesRes.status}`);
  process.exit(1);
}
const rulesPayload = await rulesRes.json();
const rules = Array.isArray(rulesPayload) ? rulesPayload : (rulesPayload.list ?? rulesPayload.rules ?? []);
const rule = rules.find((r) => r.name === name);
if (!rule) {
  console.error(`规则不存在: ${name}（可用: ${rules.map((r) => r.name).join(', ')}）`);
  process.exit(1);
}

const ruleKey = seg === 'list' ? 'listRule' : 'bookRule';
const ruleField = seg === 'chapter' ? rule.chapterRule : rule[ruleKey];
if (!ruleField) {
  console.error(`规则缺少 ${seg === 'chapter' ? 'chapterRule' : ruleKey} 段`);
  process.exit(1);
}
const rulePayload = seg === 'chapter' ? ruleField : { [ruleKey]: ruleField };
const body = {
  url,
  rule: rulePayload,
  charset: rule.charset,
  ...(rule.insecureTLS ? { insecureTLS: true } : {}),
  timeoutMs: 30000,
};
const res = await fetch(`${ENGINE}/api/${seg === 'chapter' ? 'chapter' : 'test'}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const j = await res.json();
console.log('ok:', j.ok, 'strategy:', j.strategy, 'status:', j.status);
if (j.data?.list) {
  console.log('items:', j.data.list.count);
  for (const it of j.data.list.items.slice(0, 5)) console.log(' -', it.title, '|', it.author, '|', it.category, '|', it.url);
}
if (j.data?.book) {
  console.log('title:', j.data.book.title, '| author:', j.data.book.author, '| status:', j.data.book.status);
  console.log('cover:', j.data.book.cover);
  console.log('desc:', (j.data.book.description ?? '').slice(0, 80));
  console.log('chapters:', j.data.book.chapterCount, '首:', JSON.stringify(j.data.book.chapters?.[0]), '末:', JSON.stringify(j.data.book.chapters?.at(-1)));
}
if (j.data?.title !== undefined && seg === 'chapter') {
  console.log('title:', j.data.title, '| words:', j.data.wordCount);
  console.log('content:', (j.data.content ?? '').slice(0, 150).replaceAll('\n', ' / '));
}
console.log('warnings:', (j.warnings ?? []).slice(0, 6));
