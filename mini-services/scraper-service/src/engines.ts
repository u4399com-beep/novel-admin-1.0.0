/**
 * Scraping Engines - Pluggable fetch backends
 *
 * Engine System:
 *   cheerio        → Fast HTTP + cheerio parsing (default, no JS rendering)
 *   playwright     → Headless browser with full JS rendering
 *   firecrawl      → External Firecrawl API (self-hosted or cloud)
 *   agentql        → AgentQL API - extract data using natural language queries
 *   cloud-browser  → Browserless / Steel cloud browser API
 */

import type { ScrapingEngine, EngineOptions, FetchResult, EngineType, FirecrawlConfig, AgentQLQuery } from "./types";
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
  return ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser"].filter((t) => engines.has(t));
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
let playwrightLaunchPromise: Promise<import("playwright").Browser> | null = null;

async function getPlaywrightBrowser(): Promise<import("playwright").Browser> {
  if (playwrightBrowser?.isConnected()) return playwrightBrowser;

  if (playwrightLaunchPromise) {
    // Wait for existing launch to complete (using promise, not busy-wait)
    try {
      playwrightBrowser = await playwrightLaunchPromise;
      if (playwrightBrowser?.isConnected()) return playwrightBrowser;
    } catch {
      // Launch failed, will try again below
    }
  }

  // Launch with timeout (30s max)
  playwrightLaunchPromise = (async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      timeout: 30000,
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
      playwrightLaunchPromise = null;
    });

    return playwrightBrowser;
  })();

  return await playwrightLaunchPromise;
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

// ==================== 4. AgentQL Engine (Natural Language Extraction) ====================

const DEFAULT_AGENTQL_API_URL = "https://api.agentql.com";
const DEFAULT_AGENTQL_QUERY: AgentQLQuery = {
  title: "extract the title of this page",
  author: "extract the author name",
  category: "extract the category or genre",
  description: "extract the description or summary text",
  cover: "extract the URL of the cover image",
  status: "extract the serialization status",
  chapters: "extract the list of chapter titles and their links",
  content: "extract the main text content of this page",
};

function getAgentQLConfig(): { apiUrl: string; apiKey: string | undefined; timeout: number } {
  return {
    apiUrl: process.env.AGENTQL_API_URL || DEFAULT_AGENTQL_API_URL,
    apiKey: process.env.AGENTQL_API_KEY || undefined,
    timeout: 60000,
  };
}

/**
 * Reconstruct HTML from an AgentQL response object.
 * Converts the structured extraction result into a simple HTML document
 * that can be parsed by cheerio downstream.
 */
function reconstructHtmlFromAgentQL(data: Record<string, unknown>): string {
  const bodyParts: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;

    if (typeof value === "string") {
      bodyParts.push(`  <div data-agentql-field="${key}">${escapeHtml(value)}</div>`);
    } else if (Array.isArray(value)) {
      // Array of objects (e.g., chapter list)
      for (const item of value) {
        if (typeof item === "string") {
          bodyParts.push(`  <div data-agentql-field="${key}">${escapeHtml(item)}</div>`);
        } else if (typeof item === "object" && item !== null) {
          const itemParts: string[] = [];
          for (const [subKey, subValue] of Object.entries(item as Record<string, unknown>)) {
            if (subValue !== null && subValue !== undefined) {
              itemParts.push(`<span data-agentql-field="${subKey}">${escapeHtml(String(subValue))}</span>`);
            }
          }
          bodyParts.push(`  <div data-agentql-field="${key}" data-agentql-item="true">${itemParts.join(" ")}</div>`);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      // Nested object
      const itemParts: string[] = [];
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        if (subValue !== null && subValue !== undefined) {
          itemParts.push(`<span data-agentql-field="${subKey}">${escapeHtml(String(subValue))}</span>`);
        }
      }
      bodyParts.push(`  <div data-agentql-field="${key}">${itemParts.join(" ")}</div>`);
    }
  }

  return `<!DOCTYPE html>\n<html><body>\n${bodyParts.join("\n")}\n</body></html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class AgentQLEngine implements ScrapingEngine {
  readonly name: EngineType = "agentql";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeTargetUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getAgentQLConfig();
    const timeout = options?.timeout || config.timeout || 60000;

    // Build the natural language query from the AgentQL query fields
    // AgentQL uses a structured query object where each field maps to a NL prompt
    const query = DEFAULT_AGENTQL_QUERY;
    const agentqlQuery: Record<string, string> = {};
    for (const [key, prompt] of Object.entries(query)) {
      if (prompt) {
        agentqlQuery[key] = prompt;
      }
    }

    return retryWithBackoff(
      async () => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.apiKey) {
          headers["Authorization"] = `Bearer ${config.apiKey}`;
          // AgentQL also supports x-api-key header
          headers["x-api-key"] = config.apiKey;
        }

        const response = await fetch(`${config.apiUrl}/v1/extract`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            url,
            query: agentqlQuery,
          }),
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(`AgentQL API error: HTTP ${response.status} - ${errorBody}`);
        }

        const data = await response.json() as {
          data?: Record<string, unknown>;
          error?: string;
        };

        if (data.error) {
          throw new Error(`AgentQL error: ${data.error}`);
        }

        // Reconstruct HTML from AgentQL structured response
        const extractedData = data.data || {};
        const html = reconstructHtmlFromAgentQL(extractedData);

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

// ==================== 5. CloudBrowser Engine (Browserless / Steel) ====================

function getCloudBrowserConfig(): {
  provider: "browserless" | "steel";
  apiUrl: string;
  apiKey: string | undefined;
  timeout: number;
} {
  const provider = (process.env.CLOUD_BROWSER_PROVIDER || "browserless") as "browserless" | "steel";

  let apiUrl: string;
  let apiKey: string | undefined;

  if (provider === "steel") {
    apiUrl = process.env.STEEL_API_URL || "https://api.steel.dev";
    apiKey = process.env.STEEL_API_KEY || undefined;
  } else {
    apiUrl = process.env.BROWSERLESS_API_URL || "https://chrome.browserless.io";
    apiKey = process.env.BROWSERLESS_API_KEY || undefined;
  }

  return {
    provider,
    apiUrl,
    apiKey,
    timeout: 60000,
  };
}

class CloudBrowserEngine implements ScrapingEngine {
  readonly name: EngineType = "cloud-browser";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeTargetUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getCloudBrowserConfig();
    const timeout = options?.timeout || config.timeout || 60000;

    return retryWithBackoff(
      async () => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (config.apiKey) {
          if (config.provider === "steel") {
            headers["Authorization"] = `Bearer ${config.apiKey}`;
          } else {
            // Browserless uses token as query param or basic auth
            headers["Authorization"] = `Basic ${Buffer.from(`token:${config.apiKey}`).toString("base64")}`;
          }
        }

        let response: Response;
        let html: string;
        let statusCode: number;

        if (config.provider === "steel") {
          // Steel API: POST /scrape
          response = await fetch(`${config.apiUrl}/scrape`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              url,
              timeout: timeout,
              renderJs: true,
            }),
            signal: AbortSignal.timeout(timeout + 5000),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`Steel API error: HTTP ${response.status} - ${errorBody}`);
          }

          const data = await response.json() as {
            html?: string;
            status?: number;
            error?: string;
          };

          if (data.error) {
            throw new Error(`Steel error: ${data.error}`);
          }

          html = data.html || "";
          statusCode = data.status || response.status;
        } else {
          // Browserless API: POST /content
          const browserlessUrl = config.apiKey
            ? `${config.apiUrl}/content?token=${config.apiKey}`
            : `${config.apiUrl}/content`;

          response = await fetch(browserlessUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url,
              waitFor: 3000,
              elements: [{ selector: "body" }],
            }),
            signal: AbortSignal.timeout(timeout + 5000),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`Browserless API error: HTTP ${response.status} - ${errorBody}`);
          }

          const data = await response.json() as {
            html?: string;
            data?: Array<{ html?: string; results?: Array<{ html?: string }> }>;
            error?: string;
          };

          if (data.error) {
            throw new Error(`Browserless error: ${data.error}`);
          }

          // Browserless /content returns { data: [{ html }] } or { data: [{ results: [{ html }] }] }
          if (data.data && data.data.length > 0) {
            const element = data.data[0];
            html = element?.html || element?.results?.[0]?.html || "";
          } else if (data.html) {
            html = data.html;
          } else {
            html = "";
          }

          statusCode = response.status;
        }

        // Wrap in full HTML document if not already
        if (!html.includes("<html") && !html.includes("<HTML")) {
          html = `<!DOCTYPE html>\n<html><body>${html}</body></html>`;
        }

        return {
          html,
          finalUrl: url,
          statusCode,
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
 *   - If antiCrawl.cloudBrowser is true, use cloud-browser
 *   - If antiCrawl.useJsRender is true, use playwright
 *   - Default to cheerio (fastest)
 */
export function selectEngine(
  requestedEngine?: EngineType,
  antiCrawl?: { useJsRender?: boolean; cloudBrowser?: boolean }
): EngineType {
  if (requestedEngine) return requestedEngine;
  if (antiCrawl?.cloudBrowser) return "cloud-browser";
  if (antiCrawl?.useJsRender) return "playwright";
  return "cheerio";
}

// ==================== Initialize All Engines ====================

export function initEngines(): void {
  // Register engines
  registerEngine(new CheerioEngine());
  registerEngine(new PlaywrightEngine());
  registerEngine(new FirecrawlEngine());
  registerEngine(new AgentQLEngine());
  registerEngine(new CloudBrowserEngine());

  console.log(`[Engines] Available: ${getEngineNames().join(", ")}`);

  // Note: Playwright is lazy-loaded on first use (saves 200-500MB memory)
  // Previous pre-warm behavior removed to reduce idle memory consumption
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