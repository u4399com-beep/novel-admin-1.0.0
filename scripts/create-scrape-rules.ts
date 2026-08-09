/**
 * Script to create scrape rules via admin API.
 * Usage: bun run scripts/create-scrape-rules.ts
 * Requires: ADMIN_PASSWORD env var and a running dev server.
 */

const BASE = 'http://127.0.0.1:3000';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD, redirect: false }),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login failed');
  return setCookie.split(';')[0];
}

async function createRule(cookie: string, rule: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/scrape-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(rule),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Failed: ${JSON.stringify(data)}`);
    return null;
  }
  console.log(`Created: ${data.name} (id: ${data.id})`);
  return data;
}

async function main() {
  console.log('Logging in...');
  const cookie = await login();
  console.log('Logged in.\n');

  // ── Rule 1: 5165.org (大悟读书网) ──
  const rule5165 = {
    name: '5165.org 大悟读书网',
    description: '大悟读书网全站采集规则。支持所有分类(wangluo/yuanzhu/wenxue/wuxia/kehuan等)。使用cheerio引擎。',
    enabled: true,
    listUrl: 'https://5165.org/{category}/',
    listSelector: { type: 'css', value: 'article li' },
    listPagination: null,
    bookTitleSelector: { type: 'css', value: 'a[href*="5165.org/"]' },
    bookAuthorSelector: null,
    bookCategorySelector: null,
    bookKeywordsSelector: null,
    bookDescriptionSelector: null,
    bookCoverSelector: { type: 'css', value: 'a[href*="5165.org/"] img' },
    bookStatusSelector: null,
    chapterListUrl: '{bookUrl}',
    chapterListSelector: { type: 'css', value: 'article' },
    chapterTitleSelector: { type: 'css', value: 'a[href$=".html"]' },
    chapterLinkSelector: { type: 'css', value: 'a[href$=".html"]' },
    chapterPagination: null,
    contentTitleSelector: { type: 'css', value: 'h1.entry-title' },
    contentSelector: { type: 'css', value: '.entry-content' },
    contentPagination: null,
    antiCrawlConfig: {
      useJsRender: false,
      uaRotation: true,
      delay: [1500, 3000],
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    },
    cleanConfig: {
      removeAds: true,
      removePatterns: [
        '.indexpic',
        '.gsc-',
        'script',
        'style',
        '.sharedaddy',
        '.sd-sharing-enabled',
        '.jp-relatedposts',
      ],
      adPatterns: [
        '请记住本书首发域名',
        '手机用户请浏览',
        '本章未完',
        '天才一秒记住',
      ],
    },
    scrapeMode: 'full',
    engine: 'cheerio',
    storageMode: 'database',
    filePath: null,
    coverSavePath: '/app/public/covers/5165/',
    threadCount: 2,
    minDelay: 2000,
    maxDelay: 4000,
    enableShuffle: true,
    dedupMode: 'url',
  };

  await createRule(cookie, rule5165);

  // ── Rule 2: 23.225.66.244 (二三阅读) ──
  const rule23ip = {
    name: '二三阅读 (23.225.66.244)',
    description: '二三阅读全站采集规则。支持7个分类(玄幻奇幻/武侠仙侠/都市言情/历史军事/网游竞技/科幻灵异/女生频道)。章节内容为JS动态渲染，必须使用playwright引擎。',
    enabled: true,
    listUrl: 'http://23.225.66.244/sort/{sortId}/1.html',
    listSelector: { type: 'css', value: '.item' },
    listPagination: {
      type: 'next',
      selector: 'a.next',
      maxPage: 100,
    },
    bookTitleSelector: { type: 'css', value: 'dt a' },
    bookAuthorSelector: { type: 'css', value: 'dt span' },
    bookCategorySelector: null,
    bookKeywordsSelector: null,
    bookDescriptionSelector: { type: 'css', value: 'dd a' },
    bookCoverSelector: { type: 'css', value: '.image img' },
    bookStatusSelector: null,
    chapterListUrl: '{bookUrl}',
    chapterListSelector: { type: 'css', value: '.layout-col1' },
    chapterTitleSelector: { type: 'css', value: 'a[href*=".html"]' },
    chapterLinkSelector: { type: 'css', value: 'a[href*=".html"]' },
    chapterPagination: null,
    contentTitleSelector: { type: 'css', value: 'h1' },
    contentSelector: { type: 'css', value: '#container .layout-col1' },
    contentPagination: null,
    antiCrawlConfig: {
      useJsRender: true,
      uaRotation: true,
      delay: [2000, 5000],
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'http://23.225.66.244/',
      },
    },
    cleanConfig: {
      removeAds: true,
      removePatterns: [
        '.reader-fun',
        '.select',
        '.footer',
        '.m-footer',
        '.m-setting',
        '.topbar',
        '.header',
        'script',
        'style',
        '.pc-novel',
        '.row-section',
        '.detail-box',
      ],
      adPatterns: [
        '本章未完，点击下一页继续',
        '手机用户请浏览阅读',
        '请记住本书首发域名',
        '最快更新',
        '无弹窗小说',
      ],
    },
    scrapeMode: 'full',
    engine: 'playwright',
    storageMode: 'database',
    filePath: null,
    coverSavePath: '/app/public/covers/23ip/',
    threadCount: 1,
    minDelay: 3000,
    maxDelay: 6000,
    enableShuffle: true,
    dedupMode: 'url',
  };

  await createRule(cookie, rule23ip);

  console.log('\nDone!');
}

main().catch(console.error);
