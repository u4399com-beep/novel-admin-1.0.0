import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════
// Timing-safe string comparison
// ═══════════════════════════════════════════════════════════════════

export function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf-8');
  const bBuf = Buffer.from(b, 'utf-8');
  const maxLen = Math.max(aBuf.length, bBuf.length);
  const paddedA = Buffer.alloc(maxLen, 0);
  const paddedB = Buffer.alloc(maxLen, 0);
  aBuf.copy(paddedA);
  bBuf.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB);
}

// ═══════════════════════════════════════════════════════════════════
// Rate Limiter (Token Bucket) - runs in Node.js API route context
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// Client IP Helper
// ═══════════════════════════════════════════════════════════════════

export function getClientIp(request: NextRequest): string {
  // Prioritize X-Real-IP (set by Caddy, cannot be spoofed by client)
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  // Fallback to rightmost X-Forwarded-For (Caddy appends the real client IP)
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',');
    const candidate = parts[parts.length - 1]?.trim();
    if (candidate) return candidate;
  }
  // Fallback: Docker direct port access or dev environment without proxy.
  // Use 'direct' as a shared bucket — acceptable for single-admin systems.
  return 'direct';
}

// ═══════════════════════════════════════════════════════════════════
// API Route Auth + Rate Limit Wrapper
// ═══════════════════════════════════════════════════════════════════

/**
 * Type for API route handlers. Uses `unknown[]` for forward compatibility;
 * the actual request/params are destructured inside each handler.
 */
export type ApiHandler = (...args: any[]) => Promise<NextResponse<unknown>>;

/**
 * Wrap an API route handler with authentication and rate limiting.
 *
 * IMPORTANT: All user-supplied string fields MUST be passed through
 * `sanitizeField()` (from @/lib/api-utils) before database writes.
 * This removes Unicode control characters, zero-width chars, and BOM.
 * Do NOT rely solely on this wrapper for input sanitization.
 *
 * Usage in route.ts:
 *   export const GET = withAuth(async (req) => { ... });
 *   export const POST = withAuth(async (req) => { ... });
 */
export function withAuth(handler: ApiHandler): ApiHandler {
  return async (...args: unknown[]) => {
    const request = args[0] as NextRequest;
    // 1. Request ID (generated early for both auth paths)
    const requestId = crypto.randomUUID();

    // 2. Content-Length check for write methods (applies to ALL callers)
    const method = request.method;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
      if (contentLength > 1024 * 1024) { // 1MB
        return NextResponse.json({ error: '请求体过大，最大允许1MB' }, { status: 413 });
      }
    }

    // 3. Authentication
    // Accept either NextAuth JWT session token or service Bearer token
    let authToken;
    try {
      authToken = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    } catch (err) {
      // JWT verification failed (e.g. malformed token, secret mismatch)
      console.error(`[${requestId}] getToken error:`, err);
    }

    if (!authToken) {
      // Check for service-to-service Bearer token (used by scraper-service etc.)
      const bearer = request.headers.get('authorization');
      const serviceSecret = process.env.SCRAPER_SERVICE_TOKEN;
      if (bearer && serviceSecret && timingSafeEqual(bearer, `Bearer ${serviceSecret}`)) {
        // Service token authenticated — rate limit with separate namespace
        const serviceIp = getClientIp(request);
        const serviceRl = rateLimit(`svc:${serviceIp}`);
        if (!serviceRl.allowed) {
          return NextResponse.json(
            { error: '请求过于频繁，请稍后再试' },
            { status: 429, headers: { 'Retry-After': String(serviceRl.retryAfter) } }
          );
        }
        try {
          const response = await handler(...(args as any[]));
          response.headers.set('X-Request-ID', requestId);
          response.headers.set('X-RateLimit-Remaining', String(serviceRl.remaining));
          return response;
        } catch (error) {
          console.error(`[service][${requestId}] API error:`, error);
          return NextResponse.json(
            { error: '服务器内部错误' },
            { status: 500, headers: { 'X-Request-ID': requestId } }
          );
        }
      }

      // Unauthenticated — return 401
      const rl = rateLimit(getClientIp(request));
      return NextResponse.json(
        { error: '未授权，请先登录' },
        { status: 401, headers: { 'X-Request-ID': requestId, 'X-RateLimit-Remaining': String(rl.remaining) } }
      );
    }

    // 4. Rate limiting (auth already verified above)
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
        { status: 500, headers: { 'X-Request-ID': requestId } }
      );
    }
  };
}
