/**
 * Anti-Anti-Crawl Effectiveness Test Suite
 * 
 * Tests that each scraping rule (list, book, chapters, content, cover) correctly
 * integrates with the full anti-anti-crawl stack.
 *
 * Usage: bun run mini-services/scraper-service/src/test-anti-crawl-effectiveness.ts
 */

import { buildFetchHeaders, getSpoofedReferer, getAcceptLanguageForUA, getRandomUA, getSecFetchHeadersForDomain, getChromeClientHints } from './utils';
import { selectEngine } from './engines';
import { clearDohCache, getForwardedFor } from './doh-simulation';
import { referrerChain } from './referrer-chain';
import { rateLimiter } from './rate-limiter';
import { getStealthScript, generateFingerprintProfile } from './stealth';
import type { AntiCrawl, EngineType } from './types';

// ==================== Test Framework ====================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    const msg = `  ❌ ${name}${detail ? ': ' + detail : ''}`;
    failures.push(msg);
    console.log(msg);
  }
}

function assertEqual(actual: unknown, expected: unknown, name: string) {
  assert(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertNotEqual(actual: unknown, expected: unknown, name: string) {
  assert(actual !== expected, name, `expected NOT ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(str: string, substr: string, name: string) {
  assert(str.includes(substr), name, `expected "${substr}" in "${str.substring(0, 200)}"`);
}

function assertNotIncludes(str: string, substr: string, name: string) {
  assert(!str.includes(substr), name, `did NOT expect "${substr}" in "${str.substring(0, 200)}"`);
}

// ==================== Constants ====================

const TEST_URL = 'https://www.example-novel.com/book/123/chapter/1';
const TEST_DOMAIN = 'www.example-novel.com';
const NOVEL_LIST_URL = 'https://www.biquge.com.cn/list/1.html';
const BOOK_URL = 'https://www.biquge.com.cn/book/123/';
const CHAPTER_DIR_URL = 'https://www.biquge.com.cn/book/123/';
const CONTENT_URL = 'https://www.biquge.com.cn/book/123/chapter/456.html';

// ==================== Test Suite ====================

console.log('\n═══════════════════════════════════════════');
console.log('  采集规则反反爬效果测试 (R35)');
console.log('═══════════════════════════════════════════\n');

// ─── 1. UA Rotation + Accept-Language Consistency ───

console.log('── 1. UA Rotation + Accept-Language Consistency ───');

let chromeUa = getRandomUA();
// getRandomUA may return Safari (~18% weight). Ensure we test with a Chrome UA.
if (!chromeUa.includes('Chrome/')) {
  chromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
}
assertIncludes(chromeUa, 'Chrome/', 'Chrome UA contains Chrome/');

const acceptLang = getAcceptLanguageForUA(chromeUa);
assert(acceptLang.includes('zh-CN') || acceptLang.includes('en'), 'Accept-Language matches UA language hint', `got: ${acceptLang}`);

// Firefox UA
const firefoxUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const ffLang = getAcceptLanguageForUA(firefoxUa);
assert(ffLang.length > 0, 'Firefox UA gets valid Accept-Language', `got: ${ffLang}`);

// ─── 2. Sec-Fetch Domain Awareness ───

console.log('\n── 2. Sec-Fetch Domain Awareness ───');

referrerChain.clearHistory(TEST_DOMAIN);
const firstVisitHeaders = getSecFetchHeadersForDomain(TEST_DOMAIN);
assertEqual(firstVisitHeaders['Sec-Fetch-Site'], 'cross-site', 'First visit: Sec-Fetch-Site = cross-site');
assertEqual(firstVisitHeaders['Sec-Fetch-User'], '?1', 'First visit: Sec-Fetch-User = ?1');
assertEqual(firstVisitHeaders['Sec-Fetch-Dest'], 'document', 'Sec-Fetch-Dest = document');
assertEqual(firstVisitHeaders['Sec-Fetch-Mode'], 'navigate', 'Sec-Fetch-Mode = navigate');

// Record a visit, then subsequent should be same-origin
referrerChain.recordVisit(TEST_URL);
const sameOriginHeaders = getSecFetchHeadersForDomain(TEST_DOMAIN);
assertEqual(sameOriginHeaders['Sec-Fetch-Site'], 'same-origin', 'Subsequent visit: Sec-Fetch-Site = same-origin');
assert(!('Sec-Fetch-User' in sameOriginHeaders), 'Subsequent visit: no Sec-Fetch-User');

// Subdomain awareness
const subDomain = 'sub.example-novel.com';
referrerChain.clearHistory(subDomain);
const subHeaders = getSecFetchHeadersForDomain(subDomain, `https://${TEST_DOMAIN}/`);
assertEqual(subHeaders['Sec-Fetch-Site'], 'same-origin', 'Subdomain: same-origin via referer');

// ─── 3. Chrome Client Hints Version Matching ───

console.log('\n── 3. Chrome Client Hints Version Matching ───');

const hints131 = getChromeClientHints('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36');
assert(hints131 !== null, 'Chrome 131 UA gets Client Hints');
assertIncludes(hints131!['sec-ch-ua'], 'v="131"', 'Client Hints version matches UA (131)');
assertEqual(hints131!['sec-ch-ua-platform'], '"Windows"', 'Client Hints platform matches UA (Windows)');

const hintsMac = getChromeClientHints('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36');
assert(hintsMac !== null, 'macOS Chrome UA gets Client Hints');
assertIncludes(hintsMac!['sec-ch-ua'], 'v="130"', 'Client Hints version matches UA (130)');
assertEqual(hintsMac!['sec-ch-ua-platform'], '"macOS"', 'Client Hints platform matches UA (macOS)');

const ffHints = getChromeClientHints(firefoxUa);
assert(ffHints === null, 'Firefox UA gets null Client Hints');

const edgeHints = getChromeClientHints('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0');
assert(edgeHints === null, 'Edge UA gets null Client Hints');

// ─── 4. Referrer Chain Integration ───

console.log('\n── 4. Referrer Chain Integration ───');

referrerChain.clearHistory();

// Cold start: first request should ALWAYS get a referer (R35 fix)
const coldReferer = getSpoofedReferer(TEST_URL, 'novel');
assert(coldReferer !== undefined, 'Cold start novel URL always gets a referer');
assert(coldReferer!.includes('baidu.com') || coldReferer!.includes('google.com') || coldReferer!.includes('bing.com') || coldReferer!.includes('sogou.com') || coldReferer!.includes('so.com') || coldReferer!.includes('yahoo.com'), 
  'Cold start referer is a search engine', `got: ${coldReferer}`);

// Cold start for non-novel URL (R35: raised from 20% to 100%)
const coldNonNovel = getSpoofedReferer('https://example.com/page');
assert(coldNonNovel !== undefined, 'Cold start non-novel URL always gets a referer (R35 fix)');

// After recording a visit, chain referer should be used
referrerChain.recordVisit(BOOK_URL);
const chainRef = referrerChain.getReferer(CONTENT_URL);
assert(chainRef === BOOK_URL, 'Chain referer returns last visited URL on same domain');

// ─── 5. buildFetchHeaders Full Anti-Crawl Integration ───

console.log('\n── 5. buildFetchHeaders Full Anti-Crawl Integration ───');

referrerChain.clearHistory();
const antiCrawlConfig: AntiCrawl = {
  uaRotation: true,
  delay: [1000, 3000],
  retries: 2,
  humanBehavior: true,
};

const headers = buildFetchHeaders(antiCrawlConfig, undefined, TEST_URL, 'novel');

assert(headers['User-Agent'], 'Has User-Agent header');
assert(headers['Accept'], 'Has Accept header');
assert(headers['Accept-Language'], 'Has Accept-Language header');
assert(headers['Accept-Encoding'], 'Has Accept-Encoding header');
assert(headers['Referer'], 'Has Referer header (R35: always present)');
assert(headers['Sec-Fetch-Dest'], 'Has Sec-Fetch-Dest');
assert(headers['Sec-Fetch-Mode'], 'Has Sec-Fetch-Mode');
assert(headers['Sec-Fetch-Site'], 'Has Sec-Fetch-Site');
assert(headers['Connection'], 'Has Connection header');
assert(headers['Cache-Control'], 'Has Cache-Control header');
assert(headers['Upgrade-Insecure-Requests'], 'Has Upgrade-Insecure-Requests');

if (headers['User-Agent']!.includes('Chrome/') && !headers['User-Agent']!.includes('Edg/')) {
  assert(headers['sec-ch-ua'], 'Chrome UA has sec-ch-ua header');
  assert(headers['sec-ch-ua-mobile'], 'Chrome UA has sec-ch-ua-mobile');
  assert(headers['sec-ch-ua-platform'], 'Chrome UA has sec-ch-ua-platform');
}

assertNotEqual(headers['User-Agent'], 
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'UA rotation produces non-default UA');

const noRotHeaders = buildFetchHeaders({}, undefined, TEST_URL);
assertEqual(noRotHeaders['User-Agent'],
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'No UA rotation uses default Chrome UA');

// ─── 6. DoH XFF Proxy Skip + Session Affinity ───

console.log('\n── 6. DoH XFF Proxy Skip + Session Affinity ───');

clearDohCache();

const noProxyHeaders = buildFetchHeaders({ uaRotation: true }, undefined, TEST_URL, 'novel');
assert(noProxyHeaders['X-Forwarded-For'], 'XFF present without proxy');

const withProxyHeaders = buildFetchHeaders({ uaRotation: true, proxy: 'http://proxy.example.com:8080' }, undefined, TEST_URL, 'novel');
assert(!withProxyHeaders['X-Forwarded-For'], 'XFF absent with proxy (R35 fix)');

// Session affinity
const xff1 = getForwardedFor('test-domain.com');
const xff2 = getForwardedFor('test-domain.com');
const xff3 = getForwardedFor('other-domain.com');
assertEqual(xff1, xff2, 'XFF session affinity: same domain returns same IP');
assert(xff1 !== xff3, 'XFF differs across domains');

// ─── 7. Engine Selection Logic ───

console.log('\n── 7. Engine Selection Logic ───');

assertEqual(selectEngine(undefined, {}), 'cheerio', 'No config → cheerio');
assertEqual(selectEngine('cheerio'), 'cheerio', 'Explicit cheerio');
assertEqual(selectEngine('playwright'), 'playwright', 'Explicit playwright');
assertEqual(selectEngine('obscura'), 'obscura', 'Explicit obscura');
assertEqual(selectEngine(undefined, { cloudBrowser: true }), 'cloud-browser', 'cloudBrowser → cloud-browser');
assertEqual(selectEngine(undefined, { humanBehavior: true }), 'obscura', 'humanBehavior → obscura');
assertEqual(selectEngine(undefined, { proxy: 'http://p:8080', uaRotation: true }), 'obscura', 'proxy+uaRotation → obscura');
assertEqual(selectEngine(undefined, { useJsRender: true }), 'playwright', 'useJsRender → playwright');
assertEqual(selectEngine(undefined, { uaRotation: true }), 'cheerio', 'uaRotation only → cheerio');
assertEqual(selectEngine('invalid-engine' as EngineType), 'cheerio', 'Invalid engine → cheerio fallback');

// ─── 8. Stealth Script: Firefox window.chrome Skip ───

console.log('\n── 8. Stealth Script: Firefox window.chrome Skip ───');

const chromeProfile = generateFingerprintProfile('test-chrome');
const chromeScript = getStealthScript(chromeProfile);
assertIncludes(chromeScript, 'window.chrome', 'Chrome profile: window.chrome injected');

const ffProfile = generateFingerprintProfile('test-ff');
const ffScript = getStealthScript(ffProfile);
assertIncludes(ffScript, '_isFirefox', 'Script defines _isFirefox flag');
assertIncludes(ffScript, '!_isFirefox', 'Script uses _isFirefox guard for chrome (R35 fix)');

// ─── 9. Stealth: performance.memory Always Override (R35) ───

console.log('\n── 9. Stealth: performance.memory Always Override ───');

const memScript = getStealthScript(chromeProfile);
assertIncludes(memScript, 'performance.memory', 'Stealth script patches performance.memory');
assertNotIncludes(memScript, '!window.performance.memory', 'R35: ALWAYS override (not only when missing)');
assertIncludes(memScript, '(!_isFirefox)', 'performance.memory skipped for Firefox');

// ─── 10. Stealth: WebGL Shader Precision Float vs Int (R35) ───

console.log('\n── 10. Stealth: WebGL Shader Precision Float vs Int ───');

const shaderScript = getStealthScript(chromeProfile);
assertIncludes(shaderScript, '0x8DF5', 'Shader precision: handles INT types (0x8DF5)');
assertIncludes(shaderScript, 'isInt', 'Shader precision: differentiates float vs int');
assertIncludes(shaderScript, 'isInt ? 0', 'Shader precision: INT types return precision=0');

// ─── 11. Rate Limiter Integration ───

console.log('\n── 11. Rate Limiter Integration ───');

const rl1 = rateLimiter.acquire('fresh-test-domain-r35.com');
assert(rl1.allowed, 'Fresh domain: rate limiter allows');
rateLimiter.recordResult('fresh-test-domain-r35.com', true, 200);

// ─── 12. Anti-Crawl Advisor Rule 8 Per-Feature ───

console.log('\n── 12. Anti-Crawl Advisor Rule 8 Per-Feature ───');

const { antiCrawlAdvisor } = await import('./anti-crawl-advisor');

// Test with all features enabled on hard site → no engine rec for obscura
const report1 = antiCrawlAdvisor.analyze('qidian.com', { engine: 'obscura', useProxy: true, uaRotation: true, humanBehavior: true, sessionManagement: true });
const obscuraRecs = report1.recommendations.filter(r => r.configKey === 'engine' && r.recommendedValue === 'obscura');
assert(obscuraRecs.length === 0, 'Rule 8 does not recommend obscura when already using it (R35 fix)');

// Test with missing features → recommends specific features
const report2 = antiCrawlAdvisor.analyze('qidian.com', { engine: 'cheerio', useProxy: false, uaRotation: false, humanBehavior: false, sessionManagement: false });
const engineRecs2 = report2.recommendations.filter(r => r.configKey === 'engine');
assert(engineRecs2.length === 1, 'Rule 8 recommends obscura when using cheerio on hard site');
const uaRecs2 = report2.recommendations.filter(r => r.configKey === 'uaRotation');
assert(uaRecs2.length === 1, 'Rule 8 recommends UA rotation when missing on hard site');

// ─── 13. CAPTCHA Strategy: GeeTest Retry Cap ───

console.log('\n── 13. CAPTCHA Strategy: GeeTest Retry Cap ───');

const { autoHandleCaptcha } = await import('./captcha-strategy');
const { detectCaptcha } = await import('./captcha-detector');

const geetestHtml = '<div class="geetest_container">Please verify</div>';
const geetestDetection = detectCaptcha(geetestHtml, 'https://test.com', 200);
assert(geetestDetection.detected, 'GeeTest detection works');

// retryCount=4 on obscura → give up
const geetestResult = await autoHandleCaptcha(geetestDetection, {
  url: 'https://test.com', domain: 'test.com', currentEngine: 'obscura', retryCount: 4, maxRetries: 10,
});
assertEqual(geetestResult.action, 'none', 'GeeTest on obscura retryCount=4 → action=none (R35 fix)');
assertIncludes(geetestResult.message, 'Manual intervention', 'GeeTest give-up message mentions manual intervention');

// retryCount=1 on obscura → delay-retry
const geetestResult2 = await autoHandleCaptcha(geetestDetection, {
  url: 'https://test.com', domain: 'test.com', currentEngine: 'obscura', retryCount: 1, maxRetries: 10,
});
assertEqual(geetestResult2.action, 'delay-retry', 'GeeTest on obscura retryCount=1 → delay-retry');

// ─── 14. Proxy Manager Credential Safety ───

console.log('\n── 14. Proxy Manager Credential Safety ───');

const { proxyManager } = await import('./proxy-manager');
const stats = proxyManager.getDetailedStats();
for (const p of stats.proxies) {
  assert(!p.url.includes('@') || p.url.includes('***:***@'), `Proxy URL redacted: ${p.url}`);
}
for (const f of stats.recentFailures) {
  assert(!f.proxyUrl.includes('@') || f.proxyUrl.includes('***:***@'), `Failure proxy URL redacted: ${f.proxyUrl}`);
}

// ─── 15. Full Pipeline: buildFetchHeaders per Scraping Rule ───

console.log('\n── 15. Full Pipeline: buildFetchHeaders per Scraping Rule ───');

referrerChain.clearHistory();

const listHeaders = buildFetchHeaders({ uaRotation: true, delay: [1000, 2000] }, undefined, NOVEL_LIST_URL, 'novel');
assert(listHeaders['User-Agent'], 'List rule: has UA');
assert(listHeaders['Referer'], 'List rule: has Referer');
assert(listHeaders['Sec-Fetch-Site'], 'List rule: has Sec-Fetch-Site');
assert(listHeaders['Accept-Language'], 'List rule: has Accept-Language');
assert(listHeaders['Accept-Encoding'], 'List rule: has Accept-Encoding');

const bookHeaders = buildFetchHeaders({ uaRotation: true }, undefined, BOOK_URL, 'novel');
assert(bookHeaders['Referer'], 'Book rule: has Referer');

referrerChain.recordVisit(BOOK_URL);

const chapHeaders = buildFetchHeaders({ uaRotation: true }, undefined, CHAPTER_DIR_URL, 'novel');
assert(chapHeaders['Referer'], 'Chapters rule: has Referer');
assertEqual(chapHeaders['Sec-Fetch-Site'], 'same-origin', 'Chapters rule: same-origin after book visit');

const contentHeaders = buildFetchHeaders({ uaRotation: true, humanBehavior: true }, undefined, CONTENT_URL, 'novel');
assert(contentHeaders['Referer'], 'Content rule: has Referer');
assertEqual(contentHeaders['Sec-Fetch-Site'], 'same-origin', 'Content rule: same-origin after book visit');

// Cover download uses getRandomUA directly
const coverUa = getRandomUA();
assert(coverUa.length > 20, 'Cover download: getRandomUA returns valid UA');

// ─── 16. Header Order Consistency ───

console.log('\n── 16. Header Order Consistency ───');

// Use a fixed UA to eliminate DNT/Client Hints randomness
const fixedChromeUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const h1Keys = Object.keys(buildFetchHeaders({ uaRotation: true, dnt: false }, fixedChromeUa, TEST_URL, 'novel'));
const h2Keys = Object.keys(buildFetchHeaders({ uaRotation: true, dnt: false }, fixedChromeUa, TEST_URL, 'novel'));
assert(JSON.stringify(h1Keys) === JSON.stringify(h2Keys), 'Same domain + same UA → consistent header order');

const h3Keys = Object.keys(buildFetchHeaders({ uaRotation: true }, undefined, 'https://other-site.com/page', 'novel'));
assert(h3Keys.length > 10, 'Different domain also gets full header set');

// ─── 17. Stealth Fingerprint Consistency ───

console.log('\n── 17. Stealth Fingerprint Consistency ───');

const profile1 = generateFingerprintProfile('consistency-test');
const profile2 = generateFingerprintProfile('consistency-test');
assertEqual(profile1.userAgent, profile2.userAgent, 'Same seed → same UA');
assertEqual(profile1.webglRenderer, profile2.webglRenderer, 'Same seed → same WebGL renderer');
assertEqual(profile1.screenWidth, profile2.screenWidth, 'Same seed → same screen width');
assertEqual(profile1.timezone, profile2.timezone, 'Same seed → same timezone');

const profile3 = generateFingerprintProfile('different-seed');
assert(
  profile1.userAgent !== profile3.userAgent || profile1.webglRenderer !== profile3.webglRenderer,
  'Different seeds → different fingerprint'
);

// ─── 18. Stealth Script Size (60+ sections) ───

console.log('\n── 18. Stealth Script Size ───');

const fullScript = getStealthScript(chromeProfile);
const sectionCount = (fullScript.match(/Section \d+:/g) || []).length;
console.log(`  ℹ️  Stealth script contains ${sectionCount} named sections, ${fullScript.length} chars`);
assert(sectionCount >= 25, `Stealth sections >= 25 (got ${sectionCount})`);
// Script size validates comprehensiveness
assert(fullScript.length > 50000, `Stealth script substantial (got ${fullScript.length} chars)`);
assert(fullScript.length > 10000, `Stealth script substantial size (got ${fullScript.length} chars)`);

// ==================== Results ====================

console.log('\n═══════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════');

if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(f);
  }
}

process.exit(failed > 0 ? 1 : 0);
