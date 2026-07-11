import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════════
// Rate Limiter (Token Bucket) - runs in Node.js API route context
// ═══════════════════════════════════════════════════════════════════════════════

const BUCKET_CAPACITY = 30;
const REFILL_RATE = 2;              // tokens per second
const MAX_ENTRIES = 10000;
const ENTRY_TTL = 120 * 1000;

const ipStore = new Map<string, { tokens: number; lastRefill: number }>();

let lastCleanup = 0;
// Lazy cleanup when >80% capacity, throttled to max once per 10s
function lazyCleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < 10_000) return;
  if (ipStore.size < MAX_ENTRIES * 0.8) return;
  lastCleanup = now;
  for (const [ip, entry] of ipStore) {
    if (now - entry.lastRefill > ENTRY_TTL) ipStore.delete(ip);
  }
}

function rateLimit(ip: string): { allowed: boolean; remaining: number; retryAfter: number } {
  const now = Date.now();
  lazyCleanup();

  if (!ipStore.has(ip) && ipStore.size >= MAX_ENTRIES) {
    return { allowed: false, remaining: 0, retryAfter: 60 };
  }

  let entry = ipStore.get(ip);
  if (!entry) {
    entry = { tokens: BUCKET_CAPACITY, lastRefill: now };
    ipStore.set(ip, entry);
  } else {
    const elapsed = (now - entry.lastRefill) / 1000;
    entry.tokens = Math.min(BUCKET_CAPACITY, entry.tokens + elapsed * REFILL_RATE);
    entry.lastRefill = now;
  }

  if (entry.tokens < 1) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((1 - entry.tokens) / REFILL_RATE) };
  }

  entry.tokens -= 1;
  return { allowed: true, remaining: Math.floor(entry.tokens), retryAfter: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Login Brute-Force Protection
// ═══════════════════════════════════════════════════════════════════════════════

interface LoginRateEntry {
  count1m: number;
  reset1m: number;
  count15m: number;
  reset15m: number;
}

const loginIpStore = new Map<string, LoginRateEntry>();
const LOGIN_MAX_1M = 5;
const LOGIN_MAX_15M = 15;
const LOGIN_WINDOW_1M = 60 * 1000;
const LOGIN_WINDOW_15M = 15 * 60 * 1000;
const MAX_LOGIN_ENTRIES = 5000;

let lastLoginCleanup = 0;

export function loginRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();

  if (loginIpStore.size > MAX_LOGIN_ENTRIES * 0.8 && now - lastLoginCleanup >= 10_000) {
    lastLoginCleanup = now;
    for (const [key, entry] of loginIpStore) {
      if (now > entry.reset15m) loginIpStore.delete(key);
    }
  }

  let entry = loginIpStore.get(ip);
  if (!entry || now > entry.reset15m) {
    entry = { count1m: 0, reset1m: now + LOGIN_WINDOW_1M, count15m: 0, reset15m: now + LOGIN_WINDOW_15M };
    loginIpStore.set(ip, entry);
  }

  if (now > entry.reset1m) {
    entry.count1m = 0;
    entry.reset1m = now + LOGIN_WINDOW_1M;
  }

  if (entry.count15m >= LOGIN_MAX_15M) {
    return { allowed: false, retryAfter: Math.ceil((entry.reset15m - now) / 1000) };
  }
  if (entry.count1m >= LOGIN_MAX_1M) {
    return { allowed: false, retryAfter: Math.ceil((entry.reset1m - now) / 1000) };
  }

  entry.count1m++;
  entry.count15m++;
  return { allowed: true, retryAfter: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// API Route Auth + Rate Limit Wrapper
// ═══════════════════════════════════════════════════════════════════════════════

export type ApiHandler = (...args: any[]) => Promise<NextResponse<any>>;

/**
 * Wrap an API route handler with authentication and rate limiting.
 * Usage in route.ts:
 *   export const GET = withAuth(async (req) => { ... });
 *   export const POST = withAuth(async (req) => { ... });
 */
export function withAuth(handler: ApiHandler): ApiHandler {
  return async (...args: unknown[]) => {
    const request = args[0] as NextRequest;
    // 1. Authentication
    // Accept either NextAuth JWT session token or service Bearer token
    const authToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    if (!authToken) {
      // Check for service-to-service Bearer token (used by scraper-service etc.)
      // IMPORTANT: No fallback to NEXTAUTH_SECRET - must use independent token
      const bearer = request.headers.get('authorization');
      const serviceSecret = process.env.SCRAPER_SERVICE_TOKEN;
      if (!bearer || !serviceSecret || bearer !== `Bearer ${serviceSecret}`) {
        return NextResponse.json({ error: '未授权，请先登录' }, { status: 401 });
      }
      // Service token authenticated — also rate limit service calls
      const serviceIp = getClientIp(request);
      const serviceRl = rateLimit(serviceIp);
      if (!serviceRl.allowed) {
        return NextResponse.json(
          { error: '请求过于频繁，请稍后再试' },
          { status: 429, headers: { 'Retry-After': String(serviceRl.retryAfter) } }
        );
      }
      try {
        const response = await handler(...(args as any[]));
        return response;
      } catch (error) {
        console.error(`[service] API error:`, error);
        return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
      }
    }

    // 2. Content-Length check for write methods
    const method = request.method;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
      if (contentLength > 1024 * 1024) { // 1MB
        return NextResponse.json({ error: '请求体过大，最大允许1MB' }, { status: 413 });
      }
    }

    // 3. Rate limiting (use secure IP detection)
    const ip = getClientIp(request);
    const rl = rateLimit(ip);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: '请求过于频繁，请稍后再试' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rl.retryAfter),
            'X-RateLimit-Policy': '120;w=60;burst=30',
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    // 4. Request ID
    const requestId = crypto.randomUUID();

    // 5. Execute handler
    try {
      const response = await handler(...(args as any[]));
      response.headers.set('X-Request-ID', requestId);
      response.headers.set('X-RateLimit-Remaining', String(rl.remaining));
      return response;
    } catch (error) {
      console.error(`[${requestId}] API error:`, error);
      return NextResponse.json(
        { error: '服务器内部错误' },
        {
          status: 500,
          headers: { 'X-Request-ID': requestId },
        }
      );
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Client IP Helper
// ═══════════════════════════════════════════════════════════════════════════════

export function getClientIp(request: NextRequest): string {
  // Prioritize X-Real-IP (set by Caddy, cannot be spoofed by client)
  // X-Forwarded-For can be forged by clients and should not be trusted alone
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  // Fallback to rightmost X-Forwarded-For (Caddy appends the real client IP)
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',');
    return (parts[parts.length - 1]?.trim()) || 'unknown';
  }
  return 'unknown';
}