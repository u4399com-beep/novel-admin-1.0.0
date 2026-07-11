/**
 * Utilities - UA rotation, URL resolution, security, delay, retry
 */

import type { AntiCrawl } from "./types";

// ==================== User-Agent Rotation ====================

const USER_AGENTS: string[] = [
  // Chrome Desktop (Windows)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  // Chrome Desktop (macOS)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  // Safari (macOS)
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  // Firefox
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  // Edge
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  // Mobile
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  // Linux Desktop
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  // Opera
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
];

export function getRandomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export function getDesktopUA(): string {
  const desktop = USER_AGENTS.filter(ua =>
    !ua.includes("Mobile") && !ua.includes("iPhone") && !ua.includes("iPad") && !ua.includes("Android")
  );
  return desktop[Math.floor(Math.random() * desktop.length)];
}

// ==================== URL Resolution ====================

export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

// ==================== Delay ====================

export function randomDelay(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== Retry with Exponential Backoff ====================

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  factor?: number;
  jitter?: boolean;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  factor: 2,
  jitter: true,
  retryableStatuses: [408, 429, 500, 502, 503, 504],
};

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  const factor = opts.factor || 2;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt >= opts.maxRetries) break;

      // Check if error is retryable
      const statusMatch = lastError.message.match(/HTTP (\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 0;
      if (opts.retryableStatuses && !opts.retryableStatuses.includes(status)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff + jitter
      let delay = Math.min(opts.baseDelay * Math.pow(factor, attempt), opts.maxDelay);
      if (opts.jitter) {
        delay = delay * (0.5 + Math.random() * 0.5);
      }

      console.log(`  [Retry] Attempt ${attempt + 1}/${opts.maxRetries} failed: ${lastError.message}. Retrying in ${Math.round(delay)}ms...`);
      opts.onRetry?.(attempt + 1, lastError);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error("Retry failed");
}

// ==================== SSRF Protection ====================

export function isSafeTargetUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();

    // Block private/reserved IPs and localhost
    if (
      hostname === "localhost" ||
      hostname === "localhost.localdomain" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "::ffff:127.0.0.1" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
      hostname.startsWith("169.254.") ||
      hostname.startsWith("127.")
    ) {
      return false;
    }

    // Block octal IP representations
    if (/^0[0-7]+\./.test(hostname)) return false;
    // Block decimal IP representations
    if (/^\d{8,}$/.test(hostname)) return false;
    // Block IPv6 loopback / mapped variants
    if (hostname.startsWith("::ffff:") || hostname.startsWith("[::ffff:")) return false;

    // Block IPv6 private/reserved ranges
    if (hostname.startsWith("fd")) return false;           // IPv6 ULA (Unique Local Address)
    if (hostname.startsWith("fe80:")) return false;       // IPv6 link-local
    if (hostname.startsWith("ff")) return false;           // IPv6 multicast

    // Block IPv4 multicast
    if (hostname.startsWith("224.")) return false;

    // Block DNS tunneling services
    const DNS_TUNNEL_SUFFIXES = ['.nip.io', '.sslip.io', '.dns.army', '.dnsdojo.net', '.xip.io', '.localtest.me', '.vcap.me', '.lvh.me', '.fuf.me', '.encr.app'];
    if (DNS_TUNNEL_SUFFIXES.some(s => hostname.endsWith(s))) return false;

    return true;
  } catch {
    return false;
  }
}

// ==================== Path Traversal Protection ====================

export function isSafeSavePath(savePath: string): boolean {
  if (!savePath.startsWith("/")) return false;
  if (savePath.includes("..")) return false;
  if (!savePath.endsWith(".webp")) return false;
  const normalized = savePath.replace(/\/+/g, "/");
  const allowedPrefix = "/app/public/covers/";
  if (!normalized.startsWith(allowedPrefix)) return false;
  return true;
}

// ==================== Anti-Crawl Helpers ====================

export function buildFetchHeaders(
  antiCrawl?: AntiCrawl,
  customUA?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
  };

  if (antiCrawl?.uaRotation || customUA) {
    headers["User-Agent"] = customUA || getRandomUA();
  } else {
    headers["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }

  if (antiCrawl?.cookies && antiCrawl.cookies.length > 0) {
    headers["Cookie"] = antiCrawl.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  return headers;
}

// ==================== JSON Helpers ====================

export function parseJsonField<T>(field: string | null, fallback: T): T {
  if (!field) return fallback;
  try {
    return JSON.parse(field) as T;
  } catch {
    return fallback;
  }
}

// ==================== Status Mapping ====================

export function mapNovelStatus(rawStatus: string): string {
  const lower = rawStatus.trim();
  if (lower.includes("完") || lower.includes("结局") || lower.includes("end") || lower === "completed") {
    return "completed";
  }
  if (lower.includes("断") || lower.includes("暂停") || lower.includes("hiatus")) {
    return "hiatus";
  }
  return "ongoing";
}

// ==================== Generate CUID ====================

export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return timestamp + random;
}