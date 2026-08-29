/**
 * 鬼吹灯小说网 (guichuideng.info) Obscura Stealth 测试脚本
 *
 * Tests the full scraping pipeline using the Obscura engine with stealth mode:
 *   1. Fetch book listing page → extract novel URLs
 *   2. Fetch first novel's detail page → extract book metadata
 *   3. Fetch first chapter page → extract chapter content
 *
 * Usage: bun run mini-services/scraper-service/src/test-guichuideng.ts
 */

import { initEngines, getEngine, closeAllEngines } from './engines';
import { parseSelector, parseSelectorMulti, parseSelectorHtml } from './selectors';
import { resolveUrl } from './utils';
import type { Selector } from './types';

// ==================== Configuration ====================

const BASE_URL = 'https://www.guichuideng.info/book/';
const DOMAIN = 'www.guichuideng.info';

/** Selectors matching the HTML structure from guichuideng.json */
const SELECTORS = {
  // List page
  novelItem: { type: 'css' as const, value: '.item' },
  novelLink: { type: 'css' as const, value: '.item .image a' },
  novelTitleInList: { type: 'css' as const, value: '.item dl dt a' },
  novelAuthorInList: { type: 'css' as const, value: '.item dl dt span' },
  novelDescInList: { type: 'css' as const, value: '.item dl dd a' },
  novelCoverInList: { type: 'css' as const, value: '.item .image img', extract: 'src' as const },

  // Detail page
  bookTitle: { type: 'css' as const, value: 'h1' },
  bookAuthor: { type: 'css' as const, value: 'p' },
  bookCategory: { type: 'css' as const, value: 'p.xs-show' },
  bookCover: { type: 'css' as const, value: '.image img, .book-img img, .cover img', extract: 'src' as const },
  readBtn: { type: 'css' as const, value: 'a.btn-read, a.xs-show.btn-read', extract: 'href' as const },

  // Chapter list
  chapterListContainer: { type: 'css' as const, value: '.layout-col1, .listmain, .chapter-list, .mulu, #list' },
  chapterLink: { type: 'css' as const, value: 'a[href*=".html"]' },

  // Chapter content
  chapterContent: { type: 'css' as const, value: '#content' },
  chapterTitle: { type: 'css' as const, value: 'h1, title' },
  nextChapter: { type: 'css' as const, value: 'a:contains("下一章")', extract: 'href' as const },
} as const;

// ==================== Helpers ====================

function banner(text: string) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`  ${text}`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
}

function step(n: number, text: string) {
  console.log(`\n── Step ${n}: ${text} ──`);
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `... (${s.length} chars total)`;
}

// ==================== Main Test ====================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  鬼吹灯小说网 - Obscura Stealth Engine Test               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Initialize all engines (including Obscura)
  initEngines();
  console.log('[Init] Engines initialized');

  const engine = getEngine('obscura');
  console.log(`[Init] Using engine: ${engine.name}`);

  const antiCrawl = {
    useJsRender: true,
    uaRotation: true,
    delay: [2000, 4000] as [number, number],
    humanBehavior: true,
    retries: 1,
    referer: BASE_URL,
  };

  try {
    // ── Step 1: Fetch book listing page ──
    banner('Step 1: Scrape Book Listing Page');
    console.log(`[Fetch] URL: ${BASE_URL}`);

    const listResult = await engine.fetch(BASE_URL, {
      antiCrawl,
      timeout: 60000,
    });
    console.log(`[Fetch] Status: ${listResult.statusCode}, Size: ${listResult.html.length} bytes`);

    if (listResult.captcha) {
      console.warn(`[CAPTCHA] Detected: type=${listResult.captcha.type}, confidence=${listResult.captcha.confidence}`);
    }

    // Extract novel links from listing
    const novelLinks = parseSelectorMulti(listResult.html, SELECTORS.novelLink);
    console.log(`[Extract] Found ${novelLinks.length} novel links`);

    // Also extract titles from items
    const novelItems = parseSelectorMulti(listResult.html, SELECTORS.novelItem);
    console.log(`[Extract] Found ${novelItems.length} novel items (.item elements)`);

    // Parse individual novel metadata from each item
    const novels: Array<{ title: string; author: string; url: string; description: string; cover: string }> = [];
    const $ = (await import('cheerio')).load(listResult.html);
    $('.item').slice(0, 10).each((_, el) => {
      const $el = $(el);
      const link = $el.find('.image a').attr('href') || '';
      const title = $el.find('dl dt a').text().trim();
      const author = $el.find('dl dt span').text().trim();
      const desc = $el.find('dl dd a').text().trim();
      const cover = $el.find('.image img').attr('src') || '';
      if (link && title) {
        novels.push({
          title,
          author: author || '未知',
          url: resolveUrl(BASE_URL, link),
          description: desc,
          cover: cover ? resolveUrl(BASE_URL, cover) : '',
        });
      }
    });

    console.log(`\n[Results] Extracted ${novels.length} novels (showing first 3):`);
    for (let i = 0; i < Math.min(3, novels.length); i++) {
      const n = novels[i];
      console.log(`  ${i + 1}. 「${n.title}」 by ${n.author}`);
      console.log(`     URL: ${n.url}`);
      console.log(`     Cover: ${n.cover || '(none)'}`);
      if (n.description) {
        console.log(`     Desc: ${truncate(n.description, 80)}`);
      }
    }

    if (novels.length === 0) {
      console.error('[Error] No novels found on listing page. Check selectors or site structure.');
      return;
    }

    // ── Step 2: Fetch first novel's detail page ──
    banner('Step 2: Scrape Novel Detail Page');
    const firstNovel = novels[0];
    console.log(`[Fetch] Novel: 「${firstNovel.title}」`);
    console.log(`[Fetch] URL: ${firstNovel.url}`);

    // Add a delay between requests (polite scraping)
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

    const detailResult = await engine.fetch(firstNovel.url, {
      antiCrawl: {
        ...antiCrawl,
        referer: BASE_URL,
      },
      timeout: 60000,
    });
    console.log(`[Fetch] Status: ${detailResult.statusCode}, Size: ${detailResult.html.length} bytes`);

    // Extract book info
    const detailTitle = parseSelector(detailResult.html, SELECTORS.bookTitle);
    const detailAuthorRaw = parseSelector(detailResult.html, SELECTORS.bookAuthor);
    const detailCategory = parseSelector(detailResult.html, SELECTORS.bookCategory);
    const detailCover = parseSelector(detailResult.html, SELECTORS.bookCover);
    const readBtnHref = parseSelector(detailResult.html, SELECTORS.readBtn);

    // Parse author from "作者：XXX" format
    const authorMatch = detailAuthorRaw.match(/作者[：:]\s*(.+)/);
    const detailAuthor = authorMatch ? authorMatch[1].trim() : detailAuthorRaw;

    // Parse category from "类别：XXX" format
    const categoryMatch = detailCategory.match(/类别[：:]\s*(.+)/);
    const finalCategory = categoryMatch ? categoryMatch[1].trim() : detailCategory;

    console.log(`\n[Results] Book Info:`);
    console.log(`  Title: ${detailTitle || firstNovel.title}`);
    console.log(`  Author: ${detailAuthor || '(not found)'}`);
    console.log(`  Category: ${finalCategory || '(not found)'}`);
    console.log(`  Cover: ${detailCover ? resolveUrl(firstNovel.url, detailCover) : '(not found)'}`);
    console.log(`  Read Button: ${readBtnHref || '(not found)'}`);

    // Extract chapter list from detail page (many novel sites embed TOC on the book page)
    const chapterListHtml = parseSelectorHtml(detailResult.html, SELECTORS.chapterListContainer);
    let firstChapterUrl = '';
    let firstChapterTitle = '';
    let chapterCount = 0;

    if (chapterListHtml) {
      const $chapters = (await import('cheerio')).load(chapterListHtml);
      const chapterLinks = $chapters('a[href*=".html"]');
      chapterCount = chapterLinks.length;
      if (chapterLinks.length > 0) {
        const firstLink = chapterLinks.first();
        firstChapterTitle = firstLink.text().trim();
        firstChapterUrl = resolveUrl(firstNovel.url, firstLink.attr('href') || '');
      }
      console.log(`  Chapters found on detail page: ${chapterCount}`);
    }

    // If no chapters found on detail page, use the "read" button URL
    if (!firstChapterUrl && readBtnHref) {
      firstChapterUrl = resolveUrl(firstNovel.url, readBtnHref);
      console.log(`  Using read button URL as chapter entry: ${firstChapterUrl}`);
    }

    // ── Step 3: Fetch first chapter ──
    if (!firstChapterUrl) {
      banner('Step 3: Skipped (no chapter URL found)');
      console.log('No chapter URL could be resolved from the detail page.');
      console.log('This may indicate the chapter list is on a separate page.');
    } else {
      banner('Step 3: Scrape First Chapter');
      console.log(`[Fetch] Chapter: ${firstChapterTitle || '(untitled)'}`);
      console.log(`[Fetch] URL: ${firstChapterUrl}`);

      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

      const chapterResult = await engine.fetch(firstChapterUrl, {
        antiCrawl: {
          ...antiCrawl,
          referer: firstNovel.url,
        },
        timeout: 60000,
      });
      console.log(`[Fetch] Status: ${chapterResult.statusCode}, Size: ${chapterResult.html.length} bytes`);

      // Extract chapter title and content
      const chTitle = parseSelector(chapterResult.html, SELECTORS.chapterTitle);
      const chContentHtml = parseSelectorHtml(chapterResult.html, SELECTORS.chapterContent);
      const nextChapterHref = parseSelector(chapterResult.html, SELECTORS.nextChapter);

      // Strip HTML to get plain text preview
      const chContentText = chContentHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<p[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      console.log(`\n[Results] Chapter Info:`);
      console.log(`  Title: ${chTitle || firstChapterTitle || '(not found)'}`);
      console.log(`  Content length: ${chContentText.length} chars`);
      console.log(`  Next chapter: ${nextChapterHref ? resolveUrl(firstChapterUrl, nextChapterHref) : '(none)'}`);
      console.log(`\n  Content preview (first 500 chars):`);
      console.log(`  ┌${'─'.repeat(58)}┐`);
      for (const line of truncate(chContentText, 500).split('\n')) {
        console.log(`  │ ${line.padEnd(58)}│`);
      }
      console.log(`  └${'─'.repeat(58)}┘`);
    }

    // ── Summary ──
    banner('Test Complete - Summary');
    console.log(`  Engine: obscura (stealth mode)`);
    console.log(`  Listing page: ${BASE_URL}`);
    console.log(`  Novels found: ${novels.length}`);
    console.log(`  Detail page: ${firstNovel.title}`);
    console.log(`  Chapters on detail: ${chapterCount}`);
    console.log(`  First chapter scraped: ${firstChapterTitle || 'N/A'}`);
    console.log('');
  } catch (err) {
    console.error('[Error] Test failed:', err);
    throw err;
  } finally {
    // Clean up browser resources
    await closeAllEngines();
    console.log('[Cleanup] All engines closed');
  }
}

// Run directly when executed as a script
if (typeof Bun !== 'undefined' && Bun.main) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
