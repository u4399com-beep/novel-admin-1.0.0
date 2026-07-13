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

// Login rate limiting (per-IP, for /api/auth/* paths)
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

export function middleware(request: NextRequest) {
  const xPort = request.nextUrl.searchParams.get('XTransformPort');
  if (xPort && !ALLOWED_TRANSFORM_PORTS.includes(xPort)) {
    return NextResponse.json({ error: '非法的端口参数' }, { status: 400 });
  }

  // Per-IP login rate limiting for auth endpoints
  if (request.nextUrl.pathname.startsWith('/api/auth/')) {
    // Security: Caddy gateway ALWAYS sets x-real-ip. A missing header means
    // the request bypassed the gateway (direct access attempt). Reject with 400
    // instead of falling back to a shared 'unknown' bucket, which would either
    // allow unlimited requests from attackers who strip the header or block all
    // legitimate users behind misconfigured proxies in a single bucket.
    const ip = request.headers.get('x-real-ip');
    if (!ip) {
      return NextResponse.json({ error: '无法识别客户端地址' }, { status: 400 });
    }
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

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|covers/).*)',
  ],
};