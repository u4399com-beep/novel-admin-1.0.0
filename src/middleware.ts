import { NextRequest, NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────
// Minimal Middleware - Edge Runtime Compatible
// Handles: XTransformPort blocking + Login per-IP rate limiting
// Auth & rate limiting for API routes handled by withAuth() wrapper
// ─────────────────────────────────────────────────────────────

// XTransformPort whitelist — Caddy also enforces this, but defense-in-depth
const ALLOWED_TRANSFORM_PORTS = ['3000', '3001', '3003', '4000'];
// Note: 3099 (scraper-service) is intentionally NOT in this list.
// Scraper-service is accessed only from Next.js backend (server-to-server),
// never proxied through the public gateway.

// Login rate limiting (per-IP, for /api/auth/signin/* POST paths)
const LOGIN_MAX_1M = 5;         // 5 attempts per minute per IP
const LOGIN_MAX_15M = 15;       // 15 attempts per 15 minutes per IP
const loginStore = new Map<string, { c1m: number; r1m: number; c15m: number; r15m: number }>();

function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();

  // Lazy cleanup: remove expired entries on each check
  if (loginStore.size > 1000) {
    const toDelete: string[] = [];
    loginStore.forEach((entry, key) => {
      if (now > entry.r15m) toDelete.push(key);
    });
    toDelete.forEach((key) => loginStore.delete(key));
  }

  let entry = loginStore.get(ip);
  if (!entry || now > entry.r15m) {
    entry = { c1m: 0, r1m: now + 60000, c15m: 0, r15m: now + 15 * 60000 };
    loginStore.set(ip, entry);
  }
  if (now > entry.r1m) {
    entry.c1m = 0;
    entry.r1m = now + 60000;
  }
  if (entry.c15m >= LOGIN_MAX_15M) {
    return { allowed: false, retryAfter: Math.ceil((entry.r15m - now) / 1000) };
  }
  if (entry.c1m >= LOGIN_MAX_1M) {
    return { allowed: false, retryAfter: Math.ceil((entry.r1m - now) / 1000) };
  }
  entry.c1m++;
  entry.c15m++;
  return { allowed: true, retryAfter: 0 };
}

// Paths that require rate limiting (login attempts only).
// /api/auth/csrf (GET) is intentionally excluded — it's a public read-only
// endpoint used by NextAuth clients and Docker health checks. Blocking it
// would cause container health checks to fail (curl without x-real-ip header).
const RATE_LIMITED_AUTH_PATHS = ['/api/auth/signin/', '/api/auth/callback/'];

export function middleware(request: NextRequest) {
  const xPort = request.nextUrl.searchParams.get('XTransformPort');
  if (xPort && !ALLOWED_TRANSFORM_PORTS.includes(xPort)) {
    return NextResponse.json({ error: '非法的端口参数' }, { status: 400 });
  }

  const pathname = request.nextUrl.pathname;

  // Per-IP login rate limiting — only for actual login POST requests
  if (RATE_LIMITED_AUTH_PATHS.some(p => pathname.startsWith(p)) && request.method === 'POST') {
    // Security: Caddy gateway sets x-real-ip (not spoofable). When absent (direct access),
    // use rightmost X-Forwarded-For entry (appended by Caddy), not the leftmost (client-supplied).
    const ip = request.headers.get('x-real-ip')
      || request.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
      || 'direct';
    const rl = checkLoginRateLimit(ip);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `登录尝试过于频繁，请${rl.retryAfter}秒后再试` },
        {
          status: 429,
          headers: {
            'Retry-After': String(rl.retryAfter),
            'Content-Type': 'application/json',
          },
        }
      );
    }
  }

  // NOTE: Rate limiting for /api/public/* is handled at the route level via
  // `withPublicRateLimit`. We do NOT rate-limit here to avoid double-counting.

  // ─── Structured Request Logging ──────────────────────────────────
  // Add request ID header for API routes in development for debugging
  if (pathname.startsWith('/api/')) {
    const response = NextResponse.next();
    // Generate request ID for all API routes (production too, for tracing)
    if (!request.headers.get('X-Request-ID')) {
      response.headers.set('X-Request-ID', crypto.randomUUID());
    }
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|covers/).*)',
  ],
};
