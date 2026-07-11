/**
 * Scraping Engines - Pluggable fetch backends
 *
 * Engine System:
 *   cheerio   → Fast HTTP + cheerio parsing (default, no JS rendering)
 *   playwright → Headless browser with full JS rendering
 *   firecrawl  → External Firecrawl API (self-hosted or cloud)
 */

import type { ScrapingEngine, EngineOptions, FetchResult, EngineType, FirecrawlConfig } from "./types";
import { isSafeTargetUrl, buildFetchHeaders, getRandomUA, retryWithBackoff } from "./utils";

// ==================== Engine Registry ====================

const engines: Map<EngineType, ScrapingEngine> = new Map();

export function registerEngine(engine: ScrapingEngine): void {
  engines.set(engine.name, engine);
}

export function getEngine(type: EngineType): ScrapingEngine {
  const engine = engines.get(type) || engines.get("cheerio")!;
  return engine;
}

export function getEngineNames(): EngineType[] {
  return ["cheerio", "playwright", "firecrawl"].filter((t) => engines.has(t));
}

// ==================== 1. Cheerio Engine (Enhanced HTTP) ====================

class CheerioEngine implements ScrapingEngine {
  readonly name: EngineType = "cheerio";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeTargetUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const headers = buildFetchHeaders(options?.antiCrawl, options?.userAgent);
    const timeout = options?.timeout || 30000;

    const proxyUrl = options?.proxy || options?.antiCrawl?.proxy;

    return retryWithBackoff(
      async () => {
        const fetchOptions: RequestInit = {
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(timeout),
        };

        // Proxy support via Bun's undici-compatible fetch
        if (proxyUrl && typeof Bun !== "undefined") {
          // Bun supports proxy via environment variable approach
          // We set it temporarily for this request
        }

        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
        }

        const html = await response.text();
        const finalUrl = response.url || url;

        return { html, finalUrl, statusCode: response.status };
      },
      {
        maxRetries: options?.antiCrawl?.retries || 3,
        baseDelay: 1000,
        maxDelay: 15000,
      }
    );
  }
}

// ==================== 2. Playwright Engine (JS Rendering) ====================

let playwrightBrowser: import("playwright").Browser | null = null;
let playwrightLaunching = false;

async function getPlaywrightBrowser(): Promise<import("playwright").Browser> {
  if (playwrightBrowser?.isConnected()) return playwrightBrowser;

  if (playwrightLaunching) {
    // Wait for existing launch to complete
    while (playwrightLaunching) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (playwrightBrowser?.isConnected()) return playwrightBrowser;
  }

  playwrightLaunching = true;
  try {
    const { chromium } = await import("playwright");
    playwrightBrowser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    console.log("[Playwright] Browser launched successfully");

    // Handle browser close
    playwrightBrowser.on("disconnected", () => {
      console.log("[Playwright] Browser disconnected");
      playwrightBrowser = null;
    });

    return playwrightBrowser;
  } finally {
    playwrightLaunching = false;
  }
}

class PlaywrightEngine implements ScrapingEngine {
  readonly name: EngineType = "playwright";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeTargetUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = options?.timeout || 45000;
    const userAgent = options?.userAgent || (options?.antiCrawl?.uaRotation ? getRandomUA() : undefined);
    const cookies = options?.cookies || options?.antiCrawl?.cookies;

    return retryWithBackoff(
      async () => {
        const browser = await getPlaywrightBrowser();
        const context = await browser.newContext({
          userAgent,
          ...(cookies?.length ? {
            extraHTTPHeaders: {
              Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
            },
          } : {}),
        });

        try {
          const page = await context.newPage();

          // Set extra headers
          await page.setExtraHTTPHeaders({
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          });

          // Navigate with timeout
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout,
          });

          if (!response) {
            throw new Error(`No response from ${url}`);
          }

          // Wait for network idle (give JS time to render content)
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {
            // networkidle timeout is acceptable, DOM content is enough
          });

          const html = await page.content();
          const finalUrl = page.url();

          return {
            html,
            finalUrl,
            statusCode: response.status(),
          };
        } finally {
          await context.close().catch(() => {});
        }
      },
      {
        maxRetries: options?.antiCrawl?.retries || 2,
        baseDelay: 2000,
        maxDelay: 20000,
      }
    );
  }

  async close(): Promise<void> {
    if (playwrightBrowser?.isConnected()) {
      await playwrightBrowser.close().catch(() => {});
      playwrightBrowser = null;
      console.log("[Playwright] Browser closed");
    }
  }
}

// ==================== 3. Firecrawl Engine (External API) ====================

const DEFAULT_FIRECRAWL_CONFIG: FirecrawlConfig = {
  apiUrl: process.env.FIRECRAWL_API_URL || "http://localhost:3002",
  apiKey: process.env.FIRECRAWL_API_KEY || undefined,
  timeout: 60000,
};

function getFirecrawlConfig(): FirecrawlConfig {
  return DEFAULT_FIRECRAWL_CONFIG;
}

class FirecrawlEngine implements ScrapingEngine {
  readonly name: EngineType = "firecrawl";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeTargetUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getFirecrawlConfig();
    const timeout = options?.timeout || config.timeout || 60000;

    return retryWithBackoff(
      async () => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.apiKey) {
          headers["Authorization"] = `Bearer ${config.apiKey}`;
        }

        const response = await fetch(`${config.apiUrl}/v1/scrape`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            url,
            formats: ["html", "markdown"],
            onlyMainContent: true,
          }),
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(`Firecrawl API error: HTTP ${response.status} - ${errorBody}`);
        }

        const data = await response.json() as {
          success?: boolean;
          html?: string;
          markdown?: string;
          error?: string;
        };

        if (!data.success && data.error) {
          throw new Error(`Firecrawl error: ${data.error}`);
        }

        // Firecrawl returns cleaned HTML (main content only)
        // Reconstruct a full HTML for cheerio to parse
        const html = data.html || `<html><body>${data.markdown || ""}</body></html>`;

        return {
          html,
          finalUrl: url,
          statusCode: response.status,
        };
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
      }
    );
  }
}

// ==================== Smart Engine Selector ====================

/**
 * Determine the best engine for a given request.
 * Logic:
 *   - If engine explicitly specified, use it
 *   - If antiCrawl.useJsRender is true, use playwright
 *   - If Firecrawl is configured and available, could use it
 *   - Default to cheerio (fastest)
 */
export function selectEngine(
  requestedEngine?: EngineType,
  antiCrawl?: { useJsRender?: boolean }
): EngineType {
  if (requestedEngine) return requestedEngine;
  if (antiCrawl?.useJsRender) return "playwright";
  return "cheerio";
}

// ==================== Initialize All Engines ====================

export function initEngines(): void {
  // Register engines
  registerEngine(new CheerioEngine());
  registerEngine(new PlaywrightEngine());
  registerEngine(new FirecrawlEngine());

  console.log(`[Engines] Available: ${getEngineNames().join(", ")}`);

  // Pre-warm Playwright browser in background (non-blocking)
  if (engines.has("playwright")) {
    getPlaywrightBrowser().catch((err) => {
      console.warn(`[Playwright] Pre-warm failed (will retry on first use): ${err}`);
    });
  }
}

// ==================== Cleanup ====================

export async function closeAllEngines(): Promise<void> {
  // Close Playwright
  if (engines.has("playwright")) {
    const pwEngine = engines.get("playwright");
    if (pwEngine?.close) await pwEngine.close();
  }
  engines.clear();
  console.log("[Engines] All engines closed");
}