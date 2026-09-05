import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import crypto from 'crypto';
import { NotFoundError } from './crud-helpers';

// ═══════════════════════════════════════════════════════════════════
// TESTING ONLY: Set to true to bypass authentication (no login required)
// MUST be false in production. Only true in development mode (NODE_ENV=development).
// Changed from !== 'production' to === 'development' to prevent bypass
// in staging, test, preview, and other non-production environments.
const BYPASS_AUTH = process.env.NODE_ENV === 'development' && process.env.BYPASS_AUTH === 'true';
let _bypassAuthWarned = false;
if (BYPASS_AUTH && !_bypassAuthWarned) {
  _bypassAuthWarned = true;
  console.warn('[AUTH] BYPASS_AUTH is enabled — authentication bypassed. Only use in local development!');
}
// ═══════════════════════════════════════════════════════════════════

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

export function rateLimit(ip: string, opts?: { capacity?: number; refillRate?: number }): { allowed: boolean; remaining: number; retryAfter: number } {
  const now = Date.now();
  lazyCleanup();

  const cap = opts?.capacity ?? BUCKET_CAPACITY;
  const refill = opts?.refillRate ?? REFILL_RATE;

  if (!ipStore.has(ip) && ipStore.size >= MAX_ENTRIES) {
    return { allowed: false, remaining: 0, retryAfter: 60 };
  }

  let entry = ipStore.get(ip);
  if (!entry) {
    entry = { tokens: cap, lastRefill: now };
    ipStore.set(ip, entry);
  } else {
    const elapsed = (now - entry.lastRefill) / 1000;
    entry.tokens = Math.min(cap, entry.tokens + elapsed * refill);
    entry.lastRefill = now;
  }

  if (entry.tokens < 1) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((1 - entry.tokens) / refill) };
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
 * Type for API route handlers. Uses `any[]` intentionally:
 * handlers receive typed params (NextRequest, {params}) which must be
 * assignable from the rest-spread `...args`. `unknown[]` would break
 * that assignability since `unknown` is not assignable to `NextRequest`.
 */
export type ApiHandler = (...args: any[]) => Promise<NextResponse<unknown>>;

export interface WithAuthOptions {
  /** Max request body size in bytes for write methods (default: 1MB). Set higher for upload routes. */
  maxBodySize?: number;
}

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
 *
 *   // For file upload routes:
 *   export const POST = withAuth({ maxBodySize: 50 * 1024 * 1024 }, async (req) => { ... });
 */
export function withAuth(handlerOrOpts: ApiHandler | WithAuthOptions, maybeHandler?: ApiHandler): ApiHandler {
  const opts: WithAuthOptions = typeof handlerOrOpts === 'function' ? {} : handlerOrOpts;
  const handler: ApiHandler = typeof handlerOrOpts === 'function' ? handlerOrOpts : maybeHandler!;

  return async (...args: unknown[]) => {
    const request = args[0] as NextRequest;
    // 1. Request ID (generated early for both auth paths)
    const requestId = crypto.randomUUID();

    // 2. Content-Length check for write methods (applies to ALL callers)
    const method = request.method;
    const maxBody = opts.maxBodySize ?? (1024 * 1024); // default 1MB
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
      if (contentLength > maxBody) {
        const maxMB = Math.round(maxBody / (1024 * 1024));
        return NextResponse.json({ error: `请求体过大，最大允许${maxMB}MB` }, { status: 413 });
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
          const response = await handler(...args);
          if (response instanceof NextResponse) {
            response.headers.set('X-Request-ID', requestId);
            response.headers.set('X-RateLimit-Remaining', String(serviceRl.remaining));
          }
          return response;
        } catch (error) {
          // Check for NotFoundError from crud-helpers
          if (error instanceof NotFoundError) {
            return NextResponse.json(
              { error: error.message },
              { status: error.status, headers: { 'X-Request-ID': requestId } }
            );
          }
          console.error(`[service][${requestId}] API error:`, error);
          return NextResponse.json(
            { error: '服务器内部错误' },
            { status: 500, headers: { 'X-Request-ID': requestId } }
          );
        }
      }

      // Unauthenticated — bypass in testing mode, otherwise return 401
      if (BYPASS_AUTH) {
        console.warn(`[${new Date().toISOString()}] [AUTH BYPASS] Unauthenticated request to ${request.method} ${request.nextUrl.pathname} — allowed (testing mode)`);
      } else {
        const rl = rateLimit(getClientIp(request));
        return NextResponse.json(
          { error: '未授权，请先登录' },
          { status: 401, headers: { 'X-Request-ID': requestId, 'X-RateLimit-Remaining': String(rl.remaining) } }
        );
      }
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
      const response = await handler(...args);
      if (response instanceof NextResponse) {
        response.headers.set('X-Request-ID', requestId);
        response.headers.set('X-RateLimit-Remaining', String(rl.remaining));
      }
      return response;
    } catch (error) {
      // Check for NotFoundError from crud-helpers
      if (error instanceof NotFoundError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status, headers: { 'X-Request-ID': requestId } }
        );
      }
      console.error(`[${requestId}] API error:`, error);
      const detail = process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined;
      return NextResponse.json(
        { error: '服务器内部错误', ...(detail !== undefined ? { detail } : {}) },
        { status: 500, headers: { 'X-Request-ID': requestId } }
      );
    }
  };
}

// ═══════════════════════════════════════════════════════════════════
// Public Rate Limit Wrapper (no auth required)
// ═══════════════════════════════════════════════════════════════════

export interface PublicRateLimitOptions {
  /** Burst capacity (default: 60 for GET, 10 for POST) */
  capacity?: number;
  /** Tokens per second (default: 1) */
  refillRate?: number;
}

/**
 * Rate-limit wrapper for public endpoints (no authentication).
 * Uses a separate IP namespace ('pub:' prefix) to avoid collisions with admin routes.
 *
 * Usage:
 *   export const POST = withPublicRateLimit({ capacity: 10, refillRate: 0.2 }, async (req) => { ... });
 *   export const GET  = withPublicRateLimit(async (req) => { ... });
 */
export function withPublicRateLimit(optsOrHandler: PublicRateLimitOptions | ApiHandler, maybeHandler?: ApiHandler): ApiHandler {
  const opts: PublicRateLimitOptions = typeof optsOrHandler === 'function' ? {} : optsOrHandler;
  const handler: ApiHandler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler!;

  const isPost = opts.capacity !== undefined || opts.refillRate !== undefined;
  const capacity = opts.capacity ?? (isPost ? 10 : 60);
  const refillRate = opts.refillRate ?? 1;

  return async (...args: unknown[]) => {
    const request = args[0] as NextRequest;
    const ip = `pub:${getClientIp(request)}`;
    const rl = rateLimit(ip, { capacity, refillRate });

    if (!rl.allowed) {
      return NextResponse.json(
        { error: '请求过于频繁，请稍后再试' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rl.retryAfter),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    try {
      const response = await handler(...args);
      if (response instanceof NextResponse) {
        response.headers.set('X-RateLimit-Remaining', String(rl.remaining));
      }
      return response;
    } catch (error) {
      // Check for NotFoundError from crud-helpers
      if (error instanceof NotFoundError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      console.error('Public API error:', error);
      return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
    }
  };
}
