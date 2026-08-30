/**
 * AI Rule Generator
 *
 * Fetches a page's HTML using the cheerio engine, then proxies the HTML
 * to the Next.js app's /api/scrape-rules/ai-analyze endpoint where
 * z-ai-web-dev-sdk is available for LLM-based rule generation.
 *
 * Exported handlers:
 *   - handleGenerateRule(url, siteType?)  → generate a full ScrapeRule from a URL
 *   - handlePreviewPage(url)              → fetch page HTML for frontend preview
 */

import { getEngine } from "./engines";
import * as cheerio from "cheerio";

// ==================== Types ====================

export interface GeneratedRuleResult {
  success: boolean;
  rule: {
    name: string;
    description: string;
    engine: string;
    listUrl: string;
    listSelector: { type: string; value: string };
    listPagination: { type: string; selector: string; maxPage: number };
    bookTitleSelector: { type: string; value: string };
    bookAuthorSelector: { type: string; value: string };
    bookDescriptionSelector: { type: string; value: string };
    bookCoverSelector: { type: string; value: string };
    bookStatusSelector: { type: string; value: string };
    chapterListSelector: { type: string; value: string };
    chapterTitleSelector: { type: string; value: string };
    chapterLinkSelector: { type: string; value: string };
    contentSelector: { type: string; value: string };
    contentTitleSelector: { type: string; value: string };
    antiCrawlConfig: {
      useJsRender: boolean;
      uaRotation: boolean;
      minDelay: number;
      maxDelay: number;
    };
    agentqlQueries?: {
      title?: string;
      author?: string;
      description?: string;
      chapters?: string;
      content?: string;
    };
    confidence: number;
    notes: string[];
    /** Rule version number (incremented on re-generation) */
    version?: number;
    /** ISO timestamp when this rule was generated */
    generatedAt?: string;
  } | null;
  error?: string;
}

// ==================== Rule Cache (LRU + TTL) ====================

const RULE_CACHE_MAX = 100;
const RULE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedRuleEntry {
  result: GeneratedRuleResult;
  cachedAt: number;
  domain: string;
}

/** LRU-ordered list of domains (most-recently-used at end) */
const ruleCacheLru: string[] = [];
const ruleCacheMap = new Map<string, CachedRuleEntry>();

/** Track version counters per domain */
const ruleVersionMap = new Map<string, number>();

/**
 * Get cached rules for a domain (if not expired).
 */
export function getCachedRules(domain: string): GeneratedRuleResult | null {
  const entry = ruleCacheMap.get(domain);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > RULE_CACHE_TTL_MS) {
    ruleCacheMap.delete(domain);
    const idx = ruleCacheLru.indexOf(domain);
    if (idx !== -1) ruleCacheLru.splice(idx, 1);
    return null;
  }
  // Touch LRU
  touchLru(domain);
  return entry.result;
}

/**
 * Clear the entire rule cache.
 */
export function clearRuleCache(): void {
  ruleCacheMap.clear();
  ruleCacheLru.length = 0;
  console.log("[AI Rule Gen] Cache cleared");
}

function touchLru(domain: string): void {
  const idx = ruleCacheLru.indexOf(domain);
  if (idx !== -1) ruleCacheLru.splice(idx, 1);
  ruleCacheLru.push(domain);
}

function evictLru(): void {
  while (ruleCacheLru.length >= RULE_CACHE_MAX) {
    const oldest = ruleCacheLru.shift();
    if (oldest) ruleCacheMap.delete(oldest);
  }
}

function setCachedRules(domain: string, result: GeneratedRuleResult): void {
  evictLru();
  ruleCacheMap.set(domain, { result, cachedAt: Date.now(), domain });
  touchLru(domain);
}

// ==================== Rule Validation ====================

/** Known field names referenced in scraping rules */
const KNOWN_FIELDS = [
  "title", "content", "author", "description", "cover", "status",
  "chapterList", "chapterTitle", "chapterLink", "listSelector", "pagination",
];

/** Minimal HTML used to test CSS selector syntax */
const MINIMAL_HTML = "<html><body><div><p><span><a><img><ul><li><h1><h2><h3></h3></h2></h1></li></ul></img></a></span></p></div></body></html>";

/**
 * Validate a CSS selector string by attempting to parse it with cheerio.
 * Returns true if the selector is syntactically valid.
 */
function isValidCssSelector(selector: string): boolean {
  if (!selector || selector.trim().length === 0) return false;
  try {
    const $ = cheerio.load(MINIMAL_HTML);
    $(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Basic XPath syntax validation.
 * Checks that the expression starts with / or //, has balanced brackets,
 * and uses valid function-like patterns.
 */
function isValidXPath(xpath: string): boolean {
  if (!xpath || xpath.trim().length === 0) return false;
  const trimmed = xpath.trim();
  // Must start with / or //
  if (!trimmed.startsWith("/")) return false;
  // Check balanced brackets
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth < 0) return false;
  }
  if (depth !== 0) return false;
  // Check balanced parentheses
  depth = 0;
  for (const ch of trimmed) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Validate a single selector object { type, value }.
 * Returns an error string or null if valid.
 */
function validateSelector(
  fieldName: string,
  selector: { type: string; value: string }
): string | null {
  if (!selector || !selector.value || selector.value.trim().length === 0) {
    return `Field '${fieldName}': empty selector value`;
  }
  if (selector.type === "css") {
    if (!isValidCssSelector(selector.value)) {
      return `Field '${fieldName}': invalid CSS selector '${selector.value}'`;
    }
  } else if (selector.type === "xpath") {
    if (!isValidXPath(selector.value)) {
      return `Field '${fieldName}': invalid XPath expression '${selector.value}'`;
    }
  }
  return null;
}

/**
 * Validate the entire generated rule set.
 * Returns an array of validation error strings (empty = valid).
 */
function validateRules(rule: NonNullable<GeneratedRuleResult["rule"]>): string[] {
  const errors: string[] = [];

  // Validate all selector fields
  const selectorFields: Array<
    [string, { type: string; value: string } | undefined]
  > = [
    ["listSelector", rule.listSelector],
    ["bookTitleSelector", rule.bookTitleSelector],
    ["bookAuthorSelector", rule.bookAuthorSelector],
    ["bookDescriptionSelector", rule.bookDescriptionSelector],
    ["bookCoverSelector", rule.bookCoverSelector],
    ["bookStatusSelector", rule.bookStatusSelector],
    ["chapterListSelector", rule.chapterListSelector],
    ["chapterTitleSelector", rule.chapterTitleSelector],
    ["chapterLinkSelector", rule.chapterLinkSelector],
    ["contentSelector", rule.contentSelector],
    ["contentTitleSelector", rule.contentTitleSelector],
  ];

  for (const [name, sel] of selectorFields) {
    if (sel && sel.value) {
      const err = validateSelector(name, sel);
      if (err) errors.push(err);
    }
  }

  // Validate pagination selector
  if (rule.listPagination?.selector) {
    if (!isValidCssSelector(rule.listPagination.selector)) {
      errors.push(
        `listPagination.selector: invalid CSS selector '${rule.listPagination.selector}'`
      );
    }
  }

  return errors;
}

// ==================== Structural Validation ====================

/**
 * Validate the structural integrity of an LLM-generated rule response.
 * Checks that required top-level fields exist with correct types.
 * Returns an error message string, or null if structurally valid.
 */
function validateRuleStructure(data: unknown): string | null {
  if (!data || typeof data !== 'object') return 'Response is not an object';
  const obj = data as Record<string, unknown>;

  if (typeof obj.success !== 'boolean') return 'Missing or invalid "success" boolean';
  if (obj.success === false) return null; // Failure responses are structurally valid

  const rule = obj.rule;
  if (!rule || typeof rule !== 'object') return 'Missing or invalid "rule" object';
  const r = rule as Record<string, unknown>;

  // Check required string fields
  const requiredStrings: string[] = ['name', 'engine', 'listUrl'];
  for (const field of requiredStrings) {
    if (typeof r[field] !== 'string' || !(r[field] as string).trim()) {
      return `Missing or empty required field: rule.${field}`;
    }
  }

  // Check required selector fields: each must be { type: string, value: string } with non-empty value
  const requiredSelectors: string[] = [
    'listSelector', 'bookTitleSelector', 'chapterListSelector',
    'chapterLinkSelector', 'contentSelector',
  ];
  for (const field of requiredSelectors) {
    const sel = r[field];
    if (!sel || typeof sel !== 'object') return `Missing selector: rule.${field}`;
    const s = sel as Record<string, unknown>;
    if (typeof s.value !== 'string' || !(s.value as string).trim()) {
      return `Empty selector value: rule.${field}.value`;
    }
  }

  // Check antiCrawlConfig exists and has expected shape
  const ac = r.antiCrawlConfig;
  if (!ac || typeof ac !== 'object') return 'Missing rule.antiCrawlConfig';
  const a = ac as Record<string, unknown>;
  if (typeof a.useJsRender !== 'boolean') return 'Invalid antiCrawlConfig.useJsRender';

  // Check confidence is a number
  if (typeof r.confidence !== 'number') return 'Invalid rule.confidence (expected number)';

  return null;
}

// ==================== Helpers ====================

const API_BASE = () => process.env.MAIN_APP_URL || "http://localhost:3000";
const AUTH_TOKEN = () => process.env.SCRAPER_SERVICE_TOKEN || "";

/**
 * Extract domain from a URL string.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Extract the <title> from raw HTML.
 */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  // Strip HTML tags inside title
  return match[1].replace(/<[^>]*>/g, "").trim();
}

// ==================== handlePreviewPage ====================

export async function handlePreviewPage(url: string): Promise<{
  success: boolean;
  url: string;
  finalUrl: string;
  title: string;
  html: string;
  truncated: boolean;
  error?: string;
}> {
  const engine = getEngine("cheerio");

  let fetchResult: { html: string; finalUrl: string; statusCode: number };
  try {
    fetchResult = await engine.fetch(url);
  } catch (err) {
    return {
      success: false,
      url,
      finalUrl: url,
      title: "",
      html: "",
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const { html, finalUrl, statusCode } = fetchResult;
  const title = extractTitle(html);
  const MAX_HTML = 50000;
  const truncated = html.length > MAX_HTML;
  const trimmedHtml = truncated ? html.substring(0, MAX_HTML) : html;

  return {
    success: statusCode >= 200 && statusCode < 400,
    url,
    finalUrl,
    title,
    html: trimmedHtml,
    truncated,
  };
}

// ==================== handleGenerateRule ====================

export async function handleGenerateRule(
  url: string,
  siteType?: string,
  /** @internal force bypass cache (used for retry) */
  _bypassCache?: boolean
): Promise<GeneratedRuleResult> {
  // 1. Check cache first (unless bypassed for retry)
  const domain = extractDomain(url);
  if (!_bypassCache) {
    const cached = getCachedRules(domain);
    if (cached) {
      console.log(`[AI Rule Gen] Cache hit for ${domain} (v${cached.rule?.version ?? '?'})`);
      return cached;
    }
  }

  // 2. Fetch page HTML using cheerio engine
  const engine = getEngine("cheerio");
  let fetchResult: { html: string; finalUrl: string; statusCode: number };
  try {
    fetchResult = await engine.fetch(url);
  } catch (err) {
    return {
      success: false,
      rule: null,
      error: `Failed to fetch page: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const { html, finalUrl, statusCode } = fetchResult;

  if (statusCode < 200 || statusCode >= 400) {
    return {
      success: false,
      rule: null,
      error: `Failed to fetch page: HTTP ${statusCode}`,
    };
  }

  // 3. Truncate HTML to ~15000 chars for LLM context
  const truncatedHtml = html.substring(0, 15000);

  // 4. Call Next.js AI analysis endpoint
  const apiBase = API_BASE();
  const authToken = AUTH_TOKEN();

  console.log(`[AI Rule Gen] Fetching HTML from ${finalUrl} (${html.length} chars, truncated to ${truncatedHtml.length})`);
  console.log(`[AI Rule Gen] Calling ${apiBase}/api/scrape-rules/ai-analyze ...`);

  const response = await fetch(`${apiBase}/api/scrape-rules/ai-analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({
      html: truncatedHtml,
      url: finalUrl,
      siteType,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error(`[AI Rule Gen] Next.js API error: ${response.status} - ${errorText}`);
    return {
      success: false,
      rule: null,
      error: `AI analysis service returned HTTP ${response.status}`,
    };
  }

  let result: GeneratedRuleResult;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      success: false,
      rule: null,
      error: `AI analysis service returned invalid JSON (HTTP ${response.status})`,
    };
  }

  // Validate structural integrity before casting
  const structErr = validateRuleStructure(parsed);
  if (structErr) {
    console.error(`[AI Rule Gen] Structural validation failed: ${structErr}`);
    return {
      success: false,
      rule: null,
      error: `AI response failed structural validation: ${structErr}`,
    };
  }

  result = parsed as GeneratedRuleResult;

  if (!result.success || !result.rule) {
    console.log(`[AI Rule Gen] Analysis returned unsuccessful. Success: ${result.success}`);
    return result;
  }

  // 5. Validate generated rules
  const validationErrors = validateRules(result.rule);
  if (validationErrors.length > 0) {
    console.warn(`[AI Rule Gen] Validation failed (${validationErrors.length} errors), retrying with feedback...`);
    console.warn(`[AI Rule Gen] Validation errors: ${validationErrors.join("; ")}`);

    // Retry once with validation error feedback
    const retryResponse = await fetch(`${apiBase}/api/scrape-rules/ai-analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        html: truncatedHtml,
        url: finalUrl,
        siteType,
        validationFeedback: validationErrors.join("\n"),
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (retryResponse.ok) {
      try {
        const retryResult = await retryResponse.json() as GeneratedRuleResult;
        if (retryResult.success && retryResult.rule) {
          const retryErrors = validateRules(retryResult.rule);
          if (retryErrors.length === 0) {
            console.log(`[AI Rule Gen] Retry succeeded with valid rules`);
            result = retryResult;
          } else {
            console.warn(`[AI Rule Gen] Retry also had validation errors: ${retryErrors.join("; ")}`);
          }
        }
      } catch {
        // Keep original result if retry fails
      }
    }
  }

  // 6. Apply versioning
  const prevVersion = ruleVersionMap.get(domain) || 0;
  const newVersion = prevVersion + 1;
  ruleVersionMap.set(domain, newVersion);
  const now = new Date().toISOString();
  result.rule.version = newVersion;
  result.rule.generatedAt = now;

  console.log(`[AI Rule Gen] Analysis complete. Success: ${result.success}, Confidence: ${result.rule.confidence}, Version: ${newVersion}`);

  // 7. Cache the result
  setCachedRules(domain, result);

  return result;
}