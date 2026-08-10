/**
 * Seed scrape rules directly via Prisma Client.
 * Usage: bun run scripts/create-scrape-rules.ts
 * No running dev server required.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── Rule 1: 5165.org (大悟读书网) ──
// Cloudflare protected — must use playwright engine.
// All books listed on a single category page (.entry-content li a[href]).
// No list pagination needed.
const rule5165 = {
  name: '5165.org 大悟读书网',
  description: '大悟读书网全站采集。Cloudflare保护，必须使用playwright引擎。所有书籍在分类页单页列出。',
  enabled: true,
  listUrl: 'https://5165.org/wangluo/',
  listSelector: JSON.stringify({ type: 'css', value: '.entry-content li a[href]' }),
  listPagination: null,
  bookTitleSelector: JSON.stringify({ type: 'css', value: 'h1.entry-title, h1' }),
  bookAuthorSelector: JSON.stringify({ type: 'css', value: '.entry-content .text-muted, .author' }),
  bookCategorySelector: JSON.stringify({ type: 'css', value: '.entry-meta a, .cat-links a' }),
  bookKeywordsSelector: null,
  bookDescriptionSelector: JSON.stringify({ type: 'css', value: "meta[property='og:description']", extract: 'content' }),
  bookCoverSelector: JSON.stringify({ type: 'css', value: '.entry-content img, article img' }),
  bookStatusSelector: null,
  chapterListUrl: '{bookUrl}',
  chapterListSelector: JSON.stringify({ type: 'css', value: '.entry-content' }),
  chapterTitleSelector: JSON.stringify({ type: 'css', value: 'a[href$=".html"]' }),
  chapterLinkSelector: JSON.stringify({ type: 'css', value: 'a[href$=".html"]' }),
  chapterPagination: null,
  contentTitleSelector: JSON.stringify({ type: 'css', value: 'h1.entry-title, h1' }),
  contentSelector: JSON.stringify({ type: 'css', value: '.entry-content' }),
  contentPagination: null,
  antiCrawlConfig: JSON.stringify({
    useJsRender: true,
    uaRotation: true,
    delay: [2000, 4000],
    headers: { Referer: 'https://5165.org/' },
  }),
  cleanConfig: JSON.stringify({
    removeAds: true,
    removePatterns: [
      '.gsc-', '.sharedaddy', '.share-end', '.sd-sharing-enabled',
      '.wpcnt', '.wpadvert', 'ins.adsbygoogle', '[id^="div-gpt-ad"]',
      '.entry-meta', '.post-navigation', '.nav-links',
      '.comments-area', '#comments', '.related',
    ],
    adPatterns: [
      '请记住本书首发域名', '手机用户请浏览', '本章未完',
      '5165.org', '大悟读书网', '大悟读书',
      '本章最新章节', '请访问', '阅读请到',
      '如果您喜欢', '分享到', '扫码关注',
      '微信公众号', '关注公众号', '关注我们',
    ],
  }),
  scrapeMode: 'full',
  engine: 'playwright',
  storageMode: 'database',
  filePath: null,
  coverSavePath: '/app/public/covers/5165/',
  threadCount: 1,
  minDelay: 3000,
  maxDelay: 5000,
  enableShuffle: true,
  dedupMode: 'both',
};

// ── Rule 2: 23.225.66.244 (二三阅读) ──
// JS-rendered content, must use playwright.
// Chapters may span multiple pages (contentPagination enabled).
// Stricter selectors (dl > dt > a) to avoid false matches.
const rule23ip = {
  name: '二三阅读 (23.225.66.244)',
  description: '二三阅读全站采集。章节内容JS动态渲染，必须使用playwright引擎。反爬较严格，建议单线程慢速采集。',
  enabled: true,
  listUrl: 'http://23.225.66.244/sort/1/1.html',
  listSelector: JSON.stringify({ type: 'css', value: '.item' }),
  listPagination: JSON.stringify({ type: 'next', selector: 'a.next', maxPage: 100 }),
  bookTitleSelector: JSON.stringify({ type: 'css', value: 'dl > dt > a' }),
  bookAuthorSelector: JSON.stringify({ type: 'css', value: 'dl > dt > span' }),
  bookCategorySelector: null,
  bookKeywordsSelector: null,
  bookDescriptionSelector: JSON.stringify({ type: 'css', value: 'dl > dd > a' }),
  bookCoverSelector: JSON.stringify({ type: 'css', value: '.image img' }),
  bookStatusSelector: null,
  chapterListUrl: '{bookUrl}',
  chapterListSelector: JSON.stringify({ type: 'css', value: '.layout-col1' }),
  chapterTitleSelector: JSON.stringify({ type: 'css', value: 'a[href*=".html"]' }),
  chapterLinkSelector: JSON.stringify({ type: 'css', value: 'a[href*=".html"]' }),
  chapterPagination: null,
  contentTitleSelector: JSON.stringify({ type: 'css', value: 'h1' }),
  contentSelector: JSON.stringify({ type: 'css', value: '.row-reader .layout-col1, #container .layout-col1' }),
  contentPagination: JSON.stringify({ type: 'next', selector: 'a.next, a:contains("下一页")', maxPage: 10 }),
  antiCrawlConfig: JSON.stringify({
    useJsRender: true,
    uaRotation: true,
    delay: [3000, 6000],
    headers: { Referer: 'http://23.225.66.244/' },
  }),
  cleanConfig: JSON.stringify({
    removeAds: true,
    removePatterns: [
      '.reader-fun', '.select', '.footer', '.m-footer', '.m-setting',
      '.topbar', '.pc-novel', '.row-section', '.detail-box',
      '.reader-header', '.reader-footer', '.reader-tool',
      '.breadcrumb', '.share-box', '.ad-', '.advert',
      '#ad', '[class*="advert"]', '.bottom-bar',
      '.recommend', '.related-books', '.chapter-nav',
    ],
    adPatterns: [
      '本章未完，点击下一页继续', '手机用户请浏览阅读',
      '请记住本书首发域名', '最快更新', '无弹窗小说',
      '无弹窗阅读', '最快更新速度', '本章最新章节',
      '最新章节请访问', '23.225.66.244', '二三阅读',
      'TXT下载', '全本下载', '下载本',
      '在线听书', '返回目录', '章节列表',
      '推荐本书', '打赏', '投推荐票',
      '本章完', '本章结束', '完结感言',
      '如果您喜欢', '如果您喜欢本作',
    ],
  }),
  scrapeMode: 'full',
  engine: 'playwright',
  storageMode: 'database',
  filePath: null,
  coverSavePath: '/app/public/covers/23ip/',
  threadCount: 1,
  minDelay: 3000,
  maxDelay: 6000,
  enableShuffle: true,
  dedupMode: 'both',
};

const RULES = [rule5165, rule23ip];

async function upsertRule(rule: typeof rule5165) {
  const existing = await prisma.scrapeRule.findFirst({
    where: { name: rule.name },
  });

  if (existing) {
    const updated = await prisma.scrapeRule.update({
      where: { id: existing.id },
      data: rule,
    });
    console.log(`  ✓ Updated: ${rule.name} (id: ${updated.id})`);
    return 'updated';
  } else {
    const created = await prisma.scrapeRule.create({
      data: rule,
    });
    console.log(`  ✓ Created: ${rule.name} (id: ${created.id})`);
    return 'created';
  }
}

async function main() {
  console.log('Seeding scrape rules via Prisma...\n');

  let created = 0;
  let updated = 0;

  for (const rule of RULES) {
    const result = await upsertRule(rule);
    if (result === 'created') created++;
    else updated++;
  }

  console.log(`\nDone! Created: ${created}, Updated: ${updated}, Total: ${RULES.length}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
