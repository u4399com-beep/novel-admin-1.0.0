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
  };
  error?: string;
}

// ==================== Helpers ====================

const API_BASE = () => process.env.MAIN_APP_URL || "http://localhost:3000";
const AUTH_TOKEN = () => process.env.SCRAPER_SERVICE_TOKEN || "";

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
  siteType?: string
): Promise<GeneratedRuleResult> {
  // 1. Fetch page HTML using cheerio engine
  const engine = getEngine("cheerio");
  const { html, finalUrl, statusCode } = await engine.fetch(url);

  if (statusCode < 200 || statusCode >= 400) {
    return {
      success: false,
      rule: null as unknown as GeneratedRuleResult["rule"],
      error: `Failed to fetch page: HTTP ${statusCode}`,
    };
  }

  // 2. Truncate HTML to ~15000 chars for LLM context
  const truncatedHtml = html.substring(0, 15000);

  // 3. Call Next.js AI analysis endpoint
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
      rule: null as unknown as GeneratedRuleResult["rule"],
      error: `AI analysis service returned HTTP ${response.status}: ${errorText.substring(0, 500)}`,
    };
  }

  const result = await response.json() as GeneratedRuleResult;
  console.log(`[AI Rule Gen] Analysis complete. Success: ${result.success}, Confidence: ${result.rule?.confidence}`);
  return result;
}