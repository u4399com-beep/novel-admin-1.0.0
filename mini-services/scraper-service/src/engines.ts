/**
 * Scraping Engines - Pluggable fetch backends
 *
 * Engine System:
 *   cheerio        → Fast HTTP + cheerio parsing (default, no JS rendering)
 *   playwright     → Headless browser with full JS rendering
 *   firecrawl      → External Firecrawl API (self-hosted or cloud)
 *   agentql        → AgentQL API - extract data using natural language queries
 *   cloud-browser  → Browserless / Steel cloud browser API
 *   scrapling      → Python anti-bot browser service
 *   obscura        → Stealth anti-fingerprint browser (enhanced Playwright)
 */

import type { ScrapingEngine, EngineOptions, FetchResult, EngineType, FirecrawlConfig, AgentQLQuery } from "./types";
import { isSafeUrl } from "./ssrf";
import { buildFetchHeaders, getRandomUA, retryWithBackoff, followRedirects } from "./utils";
import { getProfileForDomain, getStealthScript } from "./stealth";
import { proxyManager, getProxyDispatcher } from "./proxy-manager";
import { cookieJar } from "./cookie-jar";
import { rateLimiter } from "./rate-limiter";
import { sessionManager } from "./session-manager";
import { requestFingerprintMgr } from "./request-fingerprint";
import { detectCaptcha, type CaptchaDetection } from "./captcha-detector";
import { autoHandleCaptcha } from "./captcha-strategy";
import { antiCrawlAdvisor } from "./anti-crawl-advisor";

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

// ==================== Circuit Breaker ====================

type CircuitState = "closed" | "open" | "half-open";

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private _halfOpenInFlight = 0; // Track in-flight requests during half-open

  constructor(name: string, failureThreshold = 3, resetTimeout = 30000) {
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this._name = name;
  }

  private _name: string;

  async acquire(): Promise<void> {
    if (this.state === "open") {
      // Check if enough time has passed to transition to half-open
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = "half-open";
        this._halfOpenInFlight = 0;
      } else {
        throw new Error(`Service ${this._name} is temporarily unavailable (circuit breaker open)`);
      }
    }

    // In half-open state, only allow ONE request at a time as a probe
    if (this.state === "half-open") {
      if (this._halfOpenInFlight > 0) {
        throw new Error(`Service ${this._name} is in recovery (half-open, probe in flight)`);
      }
      this._halfOpenInFlight++;
    }
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this._halfOpenInFlight = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this._halfOpenInFlight = Math.max(0, this._halfOpenInFlight - 1);
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
    }
  }
}

// One circuit breaker per external engine type
const firecrawlBreaker = new CircuitBreaker("Firecrawl");
const agentqlBreaker = new CircuitBreaker("AgentQL");
const cloudBrowserBreaker = new CircuitBreaker("CloudBrowser");
const scraplingBreaker = new CircuitBreaker("Scrapling");

// ==================== Engine Registry ====================

const engines: Map<EngineType, ScrapingEngine> = new Map();

export function registerEngine(engine: ScrapingEngine): void {
  engines.set(engine.name, engine);
}

export function getEngine(type: EngineType): ScrapingEngine {
  const engine = engines.get(type);
  if (!engine) {
    console.warn(`[Engine] Requested engine "${type}" not registered, falling back to cheerio`);
    return engines.get("cheerio")!;
  }
  return engine;
}

export function getEngineNames(): EngineType[] {
  return ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser", "scrapling", "obscura"].filter((t) => engines.has(t));
}

// ==================== 1. Cheerio Engine (Enhanced HTTP) ====================

class CheerioEngine implements ScrapingEngine {
  readonly name: EngineType = "cheerio";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const headers = buildFetchHeaders(options?.antiCrawl, options?.userAgent, url, 'novel');
    const timeout = Math.max(5000, Math.min(options?.timeout || 30000, 300000));

    // Inject cookies from the cookie jar
    let targetDomain: string;
    try { targetDomain = new URL(url).hostname; } catch { targetDomain = ''; }
    if (targetDomain) {
      const jarCookieHeader = cookieJar.getCookieHeader(targetDomain, '/');
      if (jarCookieHeader) {
        // Merge with existing Cookie header or set new
        if (headers['Cookie']) {
          headers['Cookie'] = `${jarCookieHeader}; ${headers['Cookie']}`;
        } else {
          headers['Cookie'] = jarCookieHeader;
        }
      }
    }

    // Session-aware cookie injection
    const sessionInfo = sessionManager.getSessionForRequest(targetDomain);
    if (sessionInfo && sessionInfo.cookies && !headers['Cookie']) {
      headers['Cookie'] = sessionInfo.cookies;
    }
    if (sessionInfo && sessionInfo.userAgent && !headers['User-Agent']) {
      headers['User-Agent'] = sessionInfo.userAgent;
    }

    // Proxy support: select best proxy for this domain
    const domainProxy = targetDomain ? proxyManager.getDomainProxy(targetDomain) : null;
    const proxy = domainProxy || (options?.proxy ? proxyManager.getProxy(targetDomain) : null);
    const dispatcher = proxy ? getProxyDispatcher(proxy.url) : null;

    // Request fingerprint tracking
    const fp = requestFingerprintMgr.create({
      domain: targetDomain,
      engine: 'cheerio',
      sessionId: sessionInfo?.sessionId,
      proxyUrl: proxy?.url,
      userAgent: headers['User-Agent'] || '',
    });

    // Human behavior delay (randomized jitter before fetch)
    if (options?.antiCrawl?.humanBehavior) {
      const jitter = 200 + Math.random() * 300;
      await new Promise(r => setTimeout(r, jitter));
    }

    return retryWithBackoff(
      async () => {
        // Per-domain rate limiting
        if (targetDomain) {
          const RATE_WAIT_TIMEOUT = 30_000;
          const waitStart = Date.now();
          while (true) {
            const rateCheck = rateLimiter.acquire(targetDomain);
            if (rateCheck.allowed) break;
            if (Date.now() - waitStart > RATE_WAIT_TIMEOUT) {
              throw new Error(`Rate limit wait timeout for ${targetDomain} (${rateCheck.waitMs}ms wait)`);
            }
            await new Promise(r => setTimeout(r, Math.min(rateCheck.waitMs, 2000)));
          }
        }

        const startTime = Date.now();
        let remainingTimeout = timeout;
        let statusCode = 0;
        try {
        const { response, finalUrl } = await followRedirects(url, {
          maxRedirects: 5,
          onRedirect: () => {
            // Deduct elapsed time from remaining timeout on each hop
            const elapsed = Date.now() - startTime;
            remainingTimeout = Math.max(5000, timeout - elapsed); // min 5s per redirect
          },
          makeRequest: (fetchUrl) => {
            // Inject jar cookies for each redirect hop too
            const reqHeaders = { ...headers };
            try {
              const hopDomain = new URL(fetchUrl).hostname;
              const hopCookieHeader = cookieJar.getCookieHeader(hopDomain, '/');
              if (hopCookieHeader) {
                reqHeaders['Cookie'] = reqHeaders['Cookie']
                  ? `${hopCookieHeader}; ${reqHeaders['Cookie']}`
                  : hopCookieHeader;
              }
            } catch { /* invalid URL, skip */ }
            return fetch(fetchUrl, {
              headers: reqHeaders,
              redirect: "manual",
              signal: AbortSignal.timeout(remainingTimeout),
              // @ts-expect-error - Bun supports dispatcher option
              dispatcher: dispatcher || undefined,
            });
          },
        });

        statusCode = response.status;

        if (!response.ok) {
          // Track proxy failure on error status codes
          if (proxy) proxyManager.recordFailure(proxy.url, `HTTP ${response.status}: ${response.statusText} for ${url}`);
          throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
        }

        // Store cookies from response
        if (targetDomain) {
          const setCookieHeaders = response.headers.getSetCookie?.() || [];
          if (setCookieHeaders.length > 0) {
            cookieJar.store(targetDomain, setCookieHeaders);
          }
        }

        // Verify Content-Type is text-based
        const contentType = response.headers.get("content-type") || "";
        if (contentType && !contentType.includes("text") && !contentType.includes("html") && !contentType.includes("json") && !contentType.includes("xml")) {
          throw new Error(`Unexpected Content-Type "${contentType}" for ${url} - expected text/html`);
        }

        // Check Content-Length header first to avoid OOM on large responses
        const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
        if (contentLength > MAX_RESPONSE_SIZE) {
          throw new Error(`Response Content-Length ${contentLength} exceeds 10MB limit`);
        }

        const html = (await response.text()).replace(/^\uFEFF/, "");
        if (html.length > MAX_RESPONSE_SIZE) {
          throw new Error(`Response body too large: ${html.length} bytes (max 10MB)`);
        }

        // CAPTCHA detection on response content
        if (targetDomain && html) {
          const captchaResult = detectCaptcha(html, finalUrl, statusCode);
          if (captchaResult.detected && captchaResult.confidence > 0.5) {
            console.warn(`[Cheerio] CAPTCHA detected on ${targetDomain}: type=${captchaResult.type}, confidence=${captchaResult.confidence}`);
            try {
              antiCrawlAdvisor.recordDetection(targetDomain, 'captcha', `CAPTCHA ${captchaResult.type}, confidence ${Math.round(captchaResult.confidence * 100)}%`);
            } catch { /* non-critical */ }
            // Record proxy failure on CAPTCHA
            if (proxy) proxyManager.recordFailure(proxy.url, `CAPTCHA ${captchaResult.type} detected`);
            throw new Error(`CAPTCHA detected (${captchaResult.type}, ${Math.round(captchaResult.confidence * 100)}%) on ${targetDomain}`);
          }
        }

        // Record proxy success
        if (proxy) {
          proxyManager.recordSuccess(proxy.url, Date.now() - startTime);
        }

        // Record rate limit result
        if (targetDomain) {
          rateLimiter.recordResult(targetDomain, true, statusCode);
        }

        // Complete request fingerprint tracking
        requestFingerprintMgr.complete(fp.requestId, true, statusCode);

        return { html, finalUrl, statusCode: response.status };
        } catch (err) {
          // Record rate limit result on failure (always record, even when statusCode is 0)
          if (targetDomain) {
            rateLimiter.recordResult(targetDomain, false, statusCode > 0 ? statusCode : undefined);
          }
          // Complete request fingerprint tracking (failure)
          requestFingerprintMgr.complete(fp.requestId, false, statusCode);
          throw err;
        }
      },
      {
        maxRetries: options?.antiCrawl?.retries ?? 3,
        baseDelay: 1000,
        maxDelay: 15000,
        onRetry: proxy ? (_attempt, err) => {
          proxyManager.recordFailure(proxy.url, err.message);
        } : undefined,
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
    browser.on("disconnected", () => {
      console.log("[Playwright] Browser disconnected");
      playwrightBrowser = null;
      playwrightLaunchPromise = null;
    });

    return browser;
  })();

  return await playwrightLaunchPromise;
}

class PlaywrightEngine implements ScrapingEngine {
  readonly name: EngineType = "playwright";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = Math.max(5000, Math.min(options?.timeout || 45000, 300000));
    const userAgent = options?.userAgent || (options?.antiCrawl?.uaRotation ? getRandomUA() : undefined);
    const cookies = options?.cookies || options?.antiCrawl?.cookies;

    // Get domain for cookie jar integration
    let pwDomain: string;
    try { pwDomain = new URL(url).hostname; } catch { pwDomain = ''; }

    return retryWithBackoff(
      async () => {
        // Per-domain rate limiting
        if (pwDomain) {
          const RATE_WAIT_TIMEOUT = 30_000;
          const waitStart = Date.now();
          while (true) {
            const rateCheck = rateLimiter.acquire(pwDomain);
            if (rateCheck.allowed) break;
            if (Date.now() - waitStart > RATE_WAIT_TIMEOUT) {
              throw new Error(`Rate limit wait timeout for ${pwDomain} (${rateCheck.waitMs}ms wait)`);
            }
            await new Promise(r => setTimeout(r, Math.min(rateCheck.waitMs, 2000)));
          }
        }

        const browser = await getPlaywrightBrowser();
        const context = await browser.newContext({ userAgent });

        // Add cookies from jar + user-provided cookies
        const jarCookies = pwDomain ? cookieJar.getPlaywrightCookies(pwDomain) : [];
        const allCookies = [
          ...jarCookies,
          ...(cookies?.length ? cookies.filter((c) => c.name && c.value).map((c) => ({
            name: c.name.replace(/[\r\n\t\x00-\x1f]/g, ""),
            value: c.value.replace(/[\r\n\t\x00-\x1f]/g, ""),
            domain: pwDomain,
            path: "/",
          })) : []),
        ];
        if (allCookies.length > 0) {
          await context.addCookies(allCookies);
        }

        try {
          const page = await context.newPage();

          // Apply stealth injection if anti-crawl options suggest it
          let pwDomainForStealth: string;
          try { pwDomainForStealth = new URL(url).hostname; } catch { pwDomainForStealth = ''; }
          if (pwDomainForStealth && (options?.antiCrawl?.uaRotation || options?.antiCrawl?.humanBehavior)) {
            const profile = getProfileForDomain(pwDomainForStealth);
            await page.addInitScript(getStealthScript(profile));
          }

          // Intercept all requests to block unsafe redirect targets and non-HTTP protocols
          await context.route('**/*', (route) => {
            const routeUrl = route.request().url();
            const resourceType = route.request().resourceType();
            // Block ALL non-http/https navigations and fetches
            if (!routeUrl.startsWith('http://') && !routeUrl.startsWith('https://')) {
              if (['document', 'xhr', 'fetch'].includes(resourceType)) {
                route.abort();
                return;
              }
            }
            // Block navigation, XHR, and fetch requests to unsafe targets
            if (['document', 'xhr', 'fetch'].includes(resourceType) && !isSafeUrl(routeUrl)) {
              route.abort();
              return;
            }
            route.continue();
          });

          // Set extra headers with enhanced anti-crawl header generation
          const enhancedHeaders = buildFetchHeaders(options?.antiCrawl, userAgent, url, 'novel');
          await page.setExtraHTTPHeaders(enhancedHeaders);

          // Navigate with timeout
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout,
          });

          if (!response) {
            throw new Error(`No response from ${url}`);
          }

          const responseStatus = response.status();

          // Wait for network idle (give JS time to render content)
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {
            // networkidle timeout is acceptable, DOM content is enough
          });

          const html = await page.content();
          if (html.length > MAX_RESPONSE_SIZE) {
            throw new Error(`Playwright page content too large: ${html.length} bytes (max 10MB)`);
          }
          const finalUrl = page.url();

          // Store cookies back to jar after navigation
          if (pwDomain) {
            try {
              const browserCookies = await context.cookies();
              if (browserCookies.length > 0) {
                // Convert Playwright cookies to set-cookie-like format for jar
                const setCookieHeaders = browserCookies.map(c => {
                  let header = `${c.name}=${c.value}`;
                  if (c.domain) header += `; Domain=${c.domain}`;
                  if (c.path) header += `; Path=${c.path}`;
                  if (c.httpOnly) header += '; HttpOnly';
                  if (c.secure) header += '; Secure';
                  if (c.expires > 0) header += `; Expires=${new Date(c.expires * 1000).toUTCString()}`;
                  return header;
                });
                cookieJar.store(pwDomain, setCookieHeaders);
              }
            } catch { /* ignore cookie extraction errors */ }
          }

          // Record rate limit result
          if (pwDomain) {
            rateLimiter.recordResult(pwDomain, responseStatus >= 200 && responseStatus < 400, responseStatus);
          }

          return {
            html,
            finalUrl,
            statusCode: responseStatus,
          };
        } catch (err) {
          // Record rate limit result on failure
          if (pwDomain) {
            const errStatus = err instanceof Error ? parseInt(err.message.match(/HTTP (\d+)/)?.[1] || '0', 10) : 0;
            rateLimiter.recordResult(pwDomain, false, errStatus || undefined);
          }
          throw err;
        } finally {
          await Promise.race([
            context.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 5000))
          ]).catch(() => {});
        }
      },
      {
        maxRetries: options?.antiCrawl?.retries ?? 2,
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
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getFirecrawlConfig();
    const timeout = Math.max(5000, Math.min(options?.timeout || config.timeout || 60000, 300000));

    return retryWithBackoff(
      async () => {
        await firecrawlBreaker.acquire(); // Check on each retry attempt
        try {
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

        let data;
        try {
          data = await response.json();
        } catch {
          throw new Error(`[Firecrawl] Invalid JSON response from Firecrawl API (HTTP ${response.status})`);
        }
        data = data as {
          success?: boolean;
          html?: string;
          markdown?: string;
          error?: string;
        };

        if (data.html && data.html.length > MAX_RESPONSE_SIZE) {
          throw new Error(`Firecrawl HTML too large: ${data.html.length} bytes`);
        }

        if (!data.success && data.error) {
          throw new Error(`Firecrawl error: ${data.error}`);
        }

        // Firecrawl returns cleaned HTML (main content only)
        // Reconstruct a full HTML for cheerio to parse
        const html = data.html || `<html><body>${data.markdown || ""}</body></html>`;

        firecrawlBreaker.recordSuccess();

        return {
          html,
          finalUrl: url,
          statusCode: response.status,
        };
        } catch (err) {
          firecrawlBreaker.recordFailure();
          throw err;
        }
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
      }
    );
  }
}

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
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getAgentQLConfig();
    const timeout = Math.max(5000, Math.min(options?.timeout || config.timeout || 60000, 300000));

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
        await agentqlBreaker.acquire(); // Check on each retry attempt
        try {
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

        let data;
        try {
          data = await response.json();
        } catch {
          throw new Error(`[AgentQL] Invalid JSON response from AgentQL API (HTTP ${response.status})`);
        }
        data = data as {
          data?: Record<string, unknown>;
          error?: string;
        };

        // Check response data size
        const dataJsonSize = JSON.stringify(data.data || {});
        if (dataJsonSize.length > MAX_RESPONSE_SIZE) {
          throw new Error(`AgentQL response too large`);
        }

        if (data.error) {
          throw new Error(`AgentQL error: ${data.error}`);
        }

        // Reconstruct HTML from AgentQL structured response
        const extractedData = data.data || {};
        const html = reconstructHtmlFromAgentQL(extractedData);

        agentqlBreaker.recordSuccess();

        return {
          html,
          finalUrl: url,
          statusCode: response.status,
        };
        } catch (err) {
          agentqlBreaker.recordFailure();
          throw err;
        }
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
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const config = getCloudBrowserConfig();
    const timeout = Math.max(5000, Math.min(options?.timeout || config.timeout || 60000, 300000));

    return retryWithBackoff(
      async () => {
        await cloudBrowserBreaker.acquire(); // Check on each retry attempt
        try {
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

          let data;
          try {
            data = await response.json();
          } catch {
            throw new Error(`[CloudBrowser/Steel] Invalid JSON response from Steel API (HTTP ${response.status})`);
          }
          data = data as {
            html?: string;
            status?: number;
            error?: string;
          };

          if (data.html && data.html.length > MAX_RESPONSE_SIZE) {
            throw new Error(`Steel API HTML too large: ${data.html.length} bytes`);
          }

          if (data.error) {
            throw new Error(`Steel error: ${data.error}`);
          }

          html = data.html || "";
          statusCode = data.status || response.status;
        } else {
          // Browserless API: POST /content
          // API key passed via Authorization header (not URL query param) to prevent leakage
          const browserlessHeaders: Record<string, string> = { "Content-Type": "application/json" };
          if (config.apiKey) {
            browserlessHeaders["Authorization"] = `Basic ${Buffer.from(`token:${config.apiKey}`).toString("base64")}`;
          }

          response = await fetch(`${config.apiUrl}/content`, {
            method: "POST",
            headers: browserlessHeaders,
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

          let data;
          try {
            data = await response.json();
          } catch {
            throw new Error(`[CloudBrowser/Browserless] Invalid JSON response from Browserless API (HTTP ${response.status})`);
          }
          data = data as {
            html?: string;
            data?: Array<{ html?: string; results?: Array<{ html?: string }> }>;
            error?: string;
          };

          if (data.html && data.html.length > MAX_RESPONSE_SIZE) {
            throw new Error(`Browserless response too large: ${data.html.length} bytes`);
          }

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

        cloudBrowserBreaker.recordSuccess();

        return {
          html,
          finalUrl: url,
          statusCode,
        };
        } catch (err) {
          cloudBrowserBreaker.recordFailure();
          throw err;
        }
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
      }
    );
  }
}

// ==================== 6. Scrapling Engine (Python anti-bot) ====================

const SCRAPLING_SERVICE_URL = process.env.SCRAPLING_SERVICE_URL || "http://127.0.0.1:3031";

class ScraplingEngine implements ScrapingEngine {
  readonly name: EngineType = "scrapling";

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = Math.max(10000, Math.min(options?.timeout || 30000, 120000));

    return retryWithBackoff(
      async () => {
        // Check circuit breaker BEFORE making request (prevents requests when service is down)
        await scraplingBreaker.acquire();
        try {
          const response = await fetch(`${SCRAPLING_SERVICE_URL}/fetch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url,
              timeout,
              stealth: true,
            }),
            signal: AbortSignal.timeout(timeout + 10000),
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`Scrapling service error: HTTP ${response.status} - ${errorBody}`);
          }

          let data: { html?: string; final_url?: string; status_code?: number; error?: string };
          try {
            data = await response.json();
          } catch {
            throw new Error(`Scrapling service returned invalid JSON`);
          }

          if (data.error) {
            throw new Error(`Scrapling error: ${data.error}`);
          }

          const html = data.html || "";
          if (html.length > MAX_RESPONSE_SIZE) {
            throw new Error(`Scrapling HTML too large: ${html.length} bytes`);
          }

          scraplingBreaker.recordSuccess();

          return {
            html,
            finalUrl: data.final_url || url,
            statusCode: data.status_code || 200,
          };
        } catch (scraplingErr) {
          scraplingBreaker.recordFailure();
          throw scraplingErr;
        }
      },
      {
        maxRetries: 2,
        baseDelay: 3000,
        maxDelay: 30000,
      }
    ).catch((err) => {
      // Failure already recorded per-attempt in inner catch above
      throw err;
    });
  }
}

// ==================== 7. Obscura Engine (Stealth Anti-Fingerprint Browser) ====================

/**
 * Obscura Engine — a stealth headless browser that applies comprehensive
 * anti-fingerprinting injections via Playwright's `page.addInitScript()`.
 *
 * Key differences from PlaywrightEngine:
 *   - Per-domain consistent fingerprint profiles (WebGL, screen, UA, etc.)
 *   - Full stealth injection: navigator, chrome object, WebGL, canvas noise,
 *     AudioContext noise, screen props, WebRTC leak prevention, timezone,
 *     permission API, iframe propagation
 *   - Resource blocking (images, fonts, media) for speed
 *   - Enhanced browser launch args for reduced detectability
 */

class ObscuraEngine implements ScrapingEngine {
  readonly name: EngineType = "obscura";

  private browser: import("playwright").Browser | null = null;
  private launchPromise: Promise<import("playwright").Browser> | null = null;

  private async getBrowser(): Promise<import("playwright").Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (this.launchPromise) {
      try {
        this.browser = await this.launchPromise;
        if (this.browser?.isConnected()) return this.browser;
      } catch {
        // Launch failed, retry below
      }
    }

    this.launchPromise = (async () => {
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
          // Obscura-specific: reduce automation surface area
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor,TranslateUI",
          "--disable-hang-monitor",
          "--disable-prompt-on-repost",
          "--disable-client-side-phishing-detection",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-domain-reliability",
          "--disable-ipc-flooding-protection",
          "--disable-notifications",
          "--disable-popup-blocking",
          "--disable-print-preview",
          "--disable-reading-mode",
          "--disable-renderer-throttling",
          "--disable-sync",
          "--disable-translate",
          "--metrics-recording-only",
          "--no-pings",
          "--password-store=basic",
          "--use-mock-keychain",
          "--disable-infobars",
          "--window-size=1920,1080",
          // Fingerprint-consistent locale
          "--lang=zh-CN",
        ],
      });
      console.log("[Obscura] Stealth browser launched successfully");

      browser.on("disconnected", () => {
        console.log("[Obscura] Browser disconnected");
        this.browser = null;
        this.launchPromise = null;
      });

      return browser;
    })();

    return await this.launchPromise;
  }

  async fetch(url: string, options?: EngineOptions): Promise<FetchResult> {
    if (!isSafeUrl(url)) {
      throw new Error(`Blocked: target URL is not allowed (${url})`);
    }

    const timeout = Math.max(10000, Math.min(options?.timeout || 60000, 300000));
    const cookies = options?.cookies || options?.antiCrawl?.cookies;

    // Extract domain for per-domain fingerprint caching
    let domain: string;
    try { domain = new URL(url).hostname; } catch { throw new Error(`Invalid URL: ${url}`); }

    // Get or create a consistent fingerprint profile for this domain
    const profile = getProfileForDomain(domain);
    const stealthScript = getStealthScript(profile);

    return retryWithBackoff(
      async () => {
        // Per-domain rate limiting
        const RATE_WAIT_TIMEOUT = 30_000;
        const waitStart = Date.now();
        while (true) {
          const rateCheck = rateLimiter.acquire(domain);
          if (rateCheck.allowed) break;
          if (Date.now() - waitStart > RATE_WAIT_TIMEOUT) {
            throw new Error(`Rate limit wait timeout for ${domain} (${rateCheck.waitMs}ms wait)`);
          }
          await new Promise(r => setTimeout(r, Math.min(rateCheck.waitMs, 2000)));
        }

        // Select proxy for this domain
        const domainProxy = domain ? proxyManager.getDomainProxy(domain) : null;
        const proxy = domainProxy || (options?.proxy ? proxyManager.getProxy(domain) : null);

        // Request fingerprint tracking (created before fetch)
        const fp = requestFingerprintMgr.create({
          domain,
          engine: 'obscura',
          sessionId: undefined,
          proxyUrl: proxy?.url,
          userAgent: profile.userAgent,
        });

        const browser = await this.getBrowser();

        // Build context options with optional proxy
        const contextOptions: Record<string, unknown> = {
          userAgent: profile.userAgent,
          viewport: {
            width: profile.screenWidth,
            height: profile.screenHeight,
            deviceScaleFactor: profile.pixelRatio,
          },
          locale: "zh-CN",
          timezoneId: profile.timezone,
          screen: {
            width: profile.screenWidth,
            height: profile.screenHeight,
          },
          bypassCSP: true,
          javaScriptEnabled: true,
          ignoreHTTPSErrors: true,
          serviceWorkers: "block",
          extraHTTPHeaders: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
          },
        };

        // Add proxy configuration if available
        if (proxy) {
          contextOptions.proxy = { server: proxy.url };
          if (process.env.DEBUG === 'true') {
            console.log(`[Obscura] Using proxy ${proxy.url} for ${domain}`);
          }
        }

        const context = await browser.newContext(contextOptions);

        // Add cookies from jar + user-provided cookies
        const jarCookies = cookieJar.getPlaywrightCookies(domain);
        const obscuraCookies = [
          ...jarCookies,
          ...(cookies?.length ? cookies.filter((c) => c.name && c.value).map((c) => ({
            name: c.name.replace(/[\r\n\t\x00-\x1f]/g, ""),
            value: c.value.replace(/[\r\n\t\x00-\x1f]/g, ""),
            domain,
            path: "/",
          })) : []),
        ];
        if (obscuraCookies.length > 0) {
          await context.addCookies(obscuraCookies);
        }

        try {
          const page = await context.newPage();

          // ---- CRITICAL: Inject stealth script BEFORE any navigation ----
          await page.addInitScript(stealthScript);

          // Block resources by type + SSRF protection (single unified route handler)
          await page.route("**/*", (route) => {
            const resourceType = route.request().resourceType();
            const routeUrl = route.request().url();

            // Block images, fonts, media, stylesheets for speed
            if (["image", "font", "media", "stylesheet"].includes(resourceType)) {
              route.abort();
              return;
            }

            // SSRF protection: block non-HTTP/HTTPS navigations and unsafe targets
            if (!routeUrl.startsWith("http://") && !routeUrl.startsWith("https://")) {
              if (["document", "xhr", "fetch"].includes(resourceType)) {
                route.abort();
                return;
              }
            }
            if (["document", "xhr", "fetch"].includes(resourceType) && !isSafeUrl(routeUrl)) {
              route.abort();
              return;
            }

            route.continue();
          });

          // Navigate with stealth
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout,
          });

          if (!response) {
            throw new Error(`No response from ${url}`);
          }

          // Wait for network idle (give JS time to render content)
          await page
            .waitForLoadState("networkidle", { timeout: 10000 })
          .catch(() => {
            // networkidle timeout is acceptable, DOM content is enough
          });

          // ---- Human behavior simulation or simple scroll fallback ----
          if (options?.antiCrawl?.humanBehavior) {
            try {
              // 1. Human-like mouse movement: natural curve from (100,200) to (500,400)
              const startX = 100, startY = 200;
              const endX = 500, endY = 400;
              const steps = 15 + Math.floor(Math.random() * 10);
              let currentX = startX, currentY = startY;
              for (let i = 0; i < steps; i++) {
                const t = i / steps;
                currentX = startX + (endX - startX) * t + (Math.random() - 0.5) * 30;
                currentY = startY + (endY - startY) * t + (Math.random() - 0.5) * 20;
                await page.mouse.move(currentX, currentY);
                await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
              }

              // 2. Random idle micro-movements (hand tremor between actions)
              for (let j = 0; j < 1 + Math.floor(Math.random() * 2); j++) {
                await page.mouse.move(
                  currentX + (Math.random() - 0.5) * 10,
                  currentY + (Math.random() - 0.5) * 10
                );
                currentX += (Math.random() - 0.5) * 10;
                currentY += (Math.random() - 0.5) * 10;
                await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
              }

              // 3. Occasional content interaction (30% chance to hover a link)
              if (Math.random() < 0.3) {
                try {
                  const links = await page.$$("a[href]");
                  if (links.length > 0) {
                    const randomLink = links[Math.floor(Math.random() * links.length)];
                    const box = await randomLink.boundingBox();
                    if (box) {
                      const hoverX = box.x + box.width * (0.3 + Math.random() * 0.4);
                      const hoverY = box.y + box.height / 2;
                      // Move to link in a few small steps
                      const linkSteps = 5 + Math.floor(Math.random() * 5);
                      for (let k = 0; k < linkSteps; k++) {
                        const lt = k / linkSteps;
                        await page.mouse.move(
                          currentX + (hoverX - currentX) * lt + (Math.random() - 0.5) * 8,
                          currentY + (hoverY - currentY) * lt + (Math.random() - 0.5) * 8
                        );
                        await new Promise((r) => setTimeout(r, 10 + Math.random() * 25));
                      }
                      currentX = hoverX;
                      currentY = hoverY;
                      // Pause as if reading link text
                      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
                    }
                  }
                } catch { /* link hover failure is non-critical */ }
              }

              // 4. Gradual multi-step page scroll (replaces simple scroll-to-bottom)
              const pageHeight = await page.evaluate(() => document.body.scrollHeight || 10000);
              const segments = 3 + Math.floor(Math.random() * 3); // 3-5 segments
              const scrollStep = Math.floor(pageHeight / segments);
              for (let s = 1; s <= segments; s++) {
                // Calculate target with slight overshoot then correction
                const overshoot = (Math.random() - 0.5) * 40;
                let targetY = scrollStep * s + overshoot;
                // Final segment targets near the bottom
                if (s === segments) {
                  targetY = pageHeight - 200 + (Math.random() - 0.5) * 100;
                }
                targetY = Math.max(0, targetY);

                await page.evaluate((y) => {
                  window.scrollTo({ top: y, behavior: "smooth" });
                }, targetY);

                // Scroll travel pause
                await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));

                // Simulate reading pause at each stop
                const readPause = 500 + Math.random() * 1500;
                await new Promise((r) => setTimeout(r, readPause));

                // Micro-movements during reading pause
                await page.mouse.move(
                  currentX + (Math.random() - 0.5) * 12,
                  currentY + (Math.random() - 0.5) * 12
                );
                currentX += (Math.random() - 0.5) * 12;
                currentY += (Math.random() - 0.5) * 12;
              }

              // 5. Random delay before extraction (simulates settling to read)
              await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
            } catch {
              // Human behavior simulation failure is non-critical; fall through to extraction
              console.log("[Obscura] Human behavior simulation failed, continuing with extraction");
            }
          } else {
            // Simple scroll-to-bottom fallback (original behavior)
            await page.evaluate(() => {
              window.scrollTo(0, document.body.scrollHeight);
            }).catch(() => {});

            // Brief wait for any lazy-load triggers
            await new Promise((resolve) => setTimeout(resolve, 800));
          }

          const html = await page.content();
          if (html.length > MAX_RESPONSE_SIZE) {
            throw new Error(
              `Obscura page content too large: ${html.length} bytes (max 10MB)`
            );
          }
          const finalUrl = page.url();

          // Store cookies back to jar after navigation
          try {
            const browserCookies = await context.cookies();
            if (browserCookies.length > 0) {
              const setCookieHeaders = browserCookies.map(c => {
                let header = `${c.name}=${c.value}`;
                if (c.domain) header += `; Domain=${c.domain}`;
                if (c.path) header += `; Path=${c.path}`;
                if (c.httpOnly) header += '; HttpOnly';
                if (c.secure) header += '; Secure';
                if (c.expires > 0) header += `; Expires=${new Date(c.expires * 1000).toUTCString()}`;
                return header;
              });
              cookieJar.store(domain, setCookieHeaders);
            }
          } catch { /* ignore cookie extraction errors */ }

          if (process.env.DEBUG === 'true') {
            console.log(
              `[Obscura] Fetched ${finalUrl} (${html.length} bytes, status ${response.status()}, profile: ${profile.seed.slice(0, 12)}...)`
            );
          }

          // CAPTCHA detection on fetched content
          let captchaDetection: CaptchaDetection | null = null;
          const obscuraStatus = response.status();
          if (obscuraStatus === 403 || obscuraStatus === 503 || html.includes('captcha') || html.includes('challenge')) {
            captchaDetection = detectCaptcha(html, finalUrl, obscuraStatus);
            if (captchaDetection.detected && captchaDetection.confidence > 0.5) {
              console.warn(`[Obscura] CAPTCHA detected on ${domain}: type=${captchaDetection.type}, confidence=${captchaDetection.confidence}`);
              // Notify anti-crawl advisor (fire-and-forget)
              try {
                antiCrawlAdvisor.recordDetection(domain, 'captcha', `CAPTCHA ${captchaDetection.type} detected, confidence ${Math.round(captchaDetection.confidence * 100)}%`);
              } catch { /* non-critical */ }
              // Record as failure for rate limiter (triggers penalty)
              // IMPORTANT: Do NOT record result here - the catch block below handles it.
              // Recording here AND in catch would cause double penalty.
              throw new Error(`CAPTCHA detected (${captchaDetection.type}, ${Math.round(captchaDetection.confidence * 100)}%) on ${domain}`);
            }
          }

          // Record rate limit result (only if not throwing CAPTCHA above)
          rateLimiter.recordResult(domain, obscuraStatus >= 200 && obscuraStatus < 400, obscuraStatus);

          // Track request fingerprint
          requestFingerprintMgr.complete(fp.requestId, true, obscuraStatus);

          return {
            html,
            finalUrl,
            statusCode: obscuraStatus,
            captcha: captchaDetection?.detected ? captchaDetection : undefined,
          };
        } catch (err) {
          // Record rate limit result on failure (covers both CAPTCHA and non-CAPTCHA errors)
          // This is the ONLY place recordResult is called for failures, ensuring no double-recording
          if (err instanceof Error && err.message.startsWith('CAPTCHA detected')) {
            rateLimiter.recordResult(domain, false, obscuraStatus);
          } else {
            const errStatus = err instanceof Error ? parseInt(err.message.match(/HTTP (\\d+)/)?.[1] || '0', 10) : 0;
            rateLimiter.recordResult(domain, false, errStatus || undefined);
          }
          // Track request fingerprint (failure)
          requestFingerprintMgr.complete(fp.requestId, false, 0);
          throw err;
        } finally {
          await Promise.race([
            context.close(),
            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
          ]).catch(() => {});
        }
      },
      {
        maxRetries: options?.antiCrawl?.retries ?? 2,
        baseDelay: 2000,
        maxDelay: 20000,
      }
    );
  }

  async close(): Promise<void> {
    if (this.browser?.isConnected()) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.launchPromise = null;
      console.log("[Obscura] Stealth browser closed");
    }
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
  antiCrawl?: {
    useJsRender?: boolean;
    cloudBrowser?: boolean;
    humanBehavior?: boolean;
    uaRotation?: boolean;
    cookies?: Array<{ name: string; value: string }>;
    proxy?: string;
  }
): EngineType {
  const VALID_ENGINES: EngineType[] = ['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser', 'scrapling', 'obscura'];
  if (requestedEngine) {
    if (VALID_ENGINES.includes(requestedEngine)) return requestedEngine;
    console.warn(`[selectEngine] Unknown engine '${requestedEngine}', falling back to auto-selection`);
  }
  if (antiCrawl?.cloudBrowser) return "cloud-browser";
  // If human behavior simulation is requested, must use obscura (has stealth + human sim)
  if (antiCrawl?.humanBehavior) return "obscura";
  // If proxy is set with UA rotation, obscura provides best anti-detection
  if (antiCrawl?.proxy && antiCrawl?.uaRotation) return "obscura";
  // JS rendering requested
  if (antiCrawl?.useJsRender) return "playwright";
  // If only UA rotation without JS rendering, cheerio is fine
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
  registerEngine(new ScraplingEngine());
  registerEngine(new ObscuraEngine());

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
  // Close Obscura (has its own separate browser instance)
  if (engines.has("obscura")) {
    const obsEngine = engines.get("obscura");
    if (obsEngine?.close) await obsEngine.close();
  }
  engines.clear();
  console.log("[Engines] All engines closed");
}