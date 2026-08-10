/**
 * Content Cleaning Test Helper
 * Tests cleanHtmlRaw + cleanText pipeline with realistic Chinese novel site content.
 * Usage: bun run mini-services/scraper-service/src/clean-test.ts
 */

import { cleanHtmlRaw, cleanText } from './cleaning';
import type { CleanRequest } from './types';

// ==================== Test Cases ====================

/** Typical clean config combining patterns from both 5165.org and 23.225.66.244 */
const TEST_CONFIG: CleanRequest['config'] = {
  removeAds: true,
  removePatterns: [
    '.reader-fun', '.footer', '.m-footer', '.m-setting',
    '.topbar', '.reader-header', '.reader-footer', '.reader-tool',
    '.breadcrumb', '.share-box', '.ad-', '.advert',
    '#ad', '[class*="advert"]', '.bottom-bar',
    '.gsc-', '.sharedaddy', '.share-end', '.sd-sharing-enabled',
    '.wpcnt', '.wpadvert', 'ins.adsbygoogle', '[id^="div-gpt-ad"]',
    '.entry-meta', '.post-navigation', '.nav-links',
    '.comments-area', '#comments', '.related',
    '.recommend', '.related-books', '.chapter-nav',
  ],
  adPatterns: [
    '请记住本书首发域名', '手机用户请浏览', '本章未完',
    '5165.org', '大悟读书网', '大悟读书',
    '本章最新章节', '请访问', '阅读请到',
    '如果您喜欢', '分享到', '扫码关注',
    '微信公众号', '关注公众号', '关注我们',
    '本章未完，点击下一页继续', '手机用户请浏览阅读',
    '请记住本书首发域名', '最快更新', '无弹窗小说',
    '无弹窗阅读', '最快更新速度',
    '最新章节请访问', '23.225.66.244', '二三阅读',
    'TXT下载', '全本下载', '下载本',
    '在线听书', '返回目录', '章节列表',
    '推荐本书', '打赏', '投推荐票',
    '本章完', '本章结束', '完结感言',
    '如果您喜欢本作',
  ],
};

interface TestCase {
  name: string;
  html: string;
  /** Substring(s) that must be present in the cleaned output */
  expectContains?: string[];
  /** Substring(s) that must NOT be present in the cleaned output */
  expectAbsent?: string[];
}

const TEST_CASES: TestCase[] = [
  // ── Test 1: Chapter with inline ad divs ──
  {
    name: '章节含内联广告div',
    html: `
      <div class="entry-content">
        <h1>第一章 初入江湖</h1>
        <p>那是一个风雨交加的夜晚，少年林风独自一人踏上了前往武林的道路。</p>
        <div class="ad">
          <ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-xxx"></ins>
          <p>推广链接：下载最新APP，免费阅读万本小说！</p>
        </div>
        <p>远处的山峦在夜色中若隐若现，一道闪电划过天际，照亮了前方的古道。</p>
        <div class="advert" style="margin: 10px auto;">
          <a href="http://ads.example.com/click">点击了解更多优惠</a>
        </div>
        <p>他紧了紧身上的斗篷，加快了脚步。江湖的风浪，他终将一一面对。</p>
      </div>
    `,
    expectContains: ['第一章 初入江湖', '风雨交加的夜晚', '少年林风独自', '山峦在夜色中'],
    expectAbsent: ['adsbygoogle', '推广链接', '下载最新APP', '点击了解更多优惠', '广告'],
  },

  // ── Test 2: Chapter with site watermark text ──
  {
    name: '章节含站点水印文本',
    html: `
      <div class="entry-content">
        <p>两人对视了一眼，同时出手。剑气纵横，刀光凛冽，在一瞬间碰撞出无数火花。</p>
        <p>请记住本书首发域名 www.example.com</p>
        <p>战斗持续了整整一个时辰，双方都渐渐感到力竭。</p>
        <p>最新章节请访问 www.example.com 阅读完整内容</p>
        <p>最终，还是少年略胜一筹，以一招"飞龙在天"将对手击退。</p>
        <p>手机用户请浏览 m.example.com 阅读，更流畅体验</p>
        <p>他收剑入鞘，淡淡说道："承让了。"</p>
      </div>
    `,
    expectContains: ['两人对视了一眼', '剑气纵横', '飞龙在天', '承让了'],
    expectAbsent: ['www.example.com', '最新章节请访问', '手机用户请浏览', '首发域名', 'm.example.com'],
  },

  // ── Test 3: Chapter with "本章未完" boilerplate ──
  {
    name: '章节含本章未完等固定模板文本',
    html: `
      <div class="entry-content">
        <p>夜深了，客栈里只剩下几个赶路的行商。角落里，一个黑衣人正在低声计算着什么。</p>
        <p>笔趣阁 www.biquge.com，最快更新斗破苍穹</p>
        <p>"这笔账，迟早要算清的。"黑衣人喃喃自语。</p>
        <p>天才一秒记住本站地址：www.example.com</p>
        <p>他推开窗户，一阵凉风吹入，带着秋天的肃杀之气。</p>
        <p>无弹窗小说 www.example.com 最新章节已更新</p>
        <p>本章未完，点击下一页继续阅读--</p>
        <p>远处的钟声敲了三下，已是子时。</p>
        <p>最快更新速度，全文字无弹窗阅读，请访问 www.example.com</p>
      </div>
    `,
    expectContains: ['客栈里只剩下', '黑衣人正在低声', '这笔账', '推开窗户', '钟声敲了三下', '子时'],
    expectAbsent: ['biquge', '笔趣阁', '本章未完', '天才一秒记住', '无弹窗小说', '最快更新速度', '下一页继续'],
  },

  // ── Test 4: Chapter with navigation remnants ──
  {
    name: '章节含导航残留文本',
    html: `
      <div class="entry-content">
        <div class="chapter-nav">
          <a href="/prev.html">上一页</a>
          <a href="/toc.html">返回目录</a>
          <a href="/next.html">下一页</a>
          <a href="/list.html">章节列表</a>
        </div>
        <p>天色渐渐亮了起来，一缕晨光透过窗户洒在书桌上。桌上摊开着一封泛黄的信纸。</p>
        <p>推荐本书给好友，分享到微博、微信！</p>
        <p>信上写着："吾儿亲启，父已远行，勿念。"</p>
        <p>打赏作者，投推荐票，支持作者创作更多精彩内容！</p>
        <p>他反复读了三遍，眼眶渐渐湿润。</p>
        <p>如果您喜欢本作，请多多推荐！</p>
        <p>"父亲……"他轻声呢喃，将信纸小心折好，放入怀中。</p>
        <p>扫码关注微信公众号"-example"，获取最新章节推送</p>
        <p>这是一个全新的开始。</p>
        <div class="footer">
          <p>Copyright © 2024 Example.com All Rights Reserved</p>
        </div>
      </div>
    `,
    expectContains: ['天色渐渐亮了起来', '泛黄的信纸', '吾儿亲启', '眼眶渐渐湿润', '父亲', '全新的开始'],
    expectAbsent: ['上一页', '返回目录', '下一页', '章节列表', '推荐本书', '打赏', '投推荐票', '如果您喜欢', '扫码关注', '微信公众号', 'Copyright'],
  },
];

// ==================== Test Runner ====================

/**
 * Run all cleaning test cases and print results.
 * Returns true if all assertions pass, false otherwise.
 */
export function testCleaning(): boolean {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        Content Cleaning Test Suite              ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  let allPassed = true;

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    const label = `Test ${i + 1}: ${tc.name}`;
    console.log(`── ${label} ──`);

    // Step 1: cleanHtmlRaw (HTML-level cleaning)
    const cleanedHtml = cleanHtmlRaw(tc.html, TEST_CONFIG);
    // Step 2: extract text (simulate what task-engine does after parseSelector)
    const text = cleanedHtml.replace(/<[^>]*>/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    // Step 3: cleanText (text-level cleaning)
    const finalText = cleanText(text, TEST_CONFIG);

    console.log('  Output (first 300 chars):');
    const preview = finalText.slice(0, 300);
    for (const line of preview.split('\n')) {
      console.log(`    ${line || '(empty)'}`);
    }
    if (finalText.length > 300) {
      console.log(`    ... (${finalText.length} chars total)`);
    }
    console.log('');

    // Assertions
    let passed = true;

    if (tc.expectContains) {
      for (const expected of tc.expectContains) {
        if (finalText.includes(expected)) {
          console.log(`  ✅ Contains: "${expected}"`);
        } else {
          console.log(`  ❌ MISSING: "${expected}"`);
          passed = false;
        }
      }
    }

    if (tc.expectAbsent) {
      for (const absent of tc.expectAbsent) {
        if (!finalText.includes(absent)) {
          console.log(`  ✅ Absent:   "${absent}"`);
        } else {
          console.log(`  ❌ LEAKED:   "${absent}"`);
          passed = false;
        }
      }
    }

    if (!passed) allPassed = false;
    console.log(passed ? '  🟢 PASSED\n' : '  🔴 FAILED\n');
  }

  console.log('══════════════════════════════════════════════════');
  console.log(allPassed ? '✅ All tests passed!' : '❌ Some tests failed!');
  console.log('══════════════════════════════════════════════════\n');

  return allPassed;
}

// Run directly when executed as a script
if (typeof require !== 'undefined' || (typeof Bun !== 'undefined' && Bun.main)) {
  const ok = testCleaning();
  process.exit(ok ? 0 : 1);
}
