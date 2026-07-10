import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

const RATE_LIMIT = 100; // requests per minute
const RATE_WINDOW = 60 * 1000; // 1 minute in ms
const ipStore = new Map<string, { count: number; resetTime: number }>();

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipStore) {
    if (now > entry.resetTime) {
      ipStore.delete(ip);
    }
  }
}, 5 * 60 * 1000);

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipStore.get(ip);
  if (!entry || now > entry.resetTime) {
    ipStore.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) {
    return false;
  }
  entry.count++;
  return true;
}

// Maximum request body size (1MB)
const MAX_BODY_SIZE = 1024 * 1024;

// Public paths that don't require authentication
const PUBLIC_PATHS = [
  '/api/auth',
  '/api/health',
  '/login',
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(p => pathname.startsWith(p));
}

// Allowed XTransformPort values (prevent internal port scanning via Caddy)
const ALLOWED_TRANSFORM_PORTS = ['3000', '3001', '3099', '3003', '4000'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ─── Block suspicious XTransformPort values ──────────────────────────
  const xPort = request.nextUrl.searchParams.get('XTransformPort');
  if (xPort && !ALLOWED_TRANSFORM_PORTS.includes(xPort)) {
    return NextResponse.json(
      { error: '非法的端口参数' },
      { status: 400 }
    );
  }

  // ─── Public paths: skip auth but still apply rate limiting ───────────
  if (isPublicPath(pathname)) {
    const response = NextResponse.next();
    response.headers.set('X-Request-ID', crypto.randomUUID());
    return response;
  }

  // ─── Authentication check via JWT token ──────────────────────────────
  // Use getToken which reads the session cookie and verifies the JWT
  // without making a database call (since we use JWT strategy)
  return getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })
    .then((token) => {
      if (!token) {
        // API routes: return 401 JSON
        if (pathname.startsWith('/api/')) {
          return NextResponse.json(
            { error: '未授权，请先登录' },
            { status: 401 }
          );
        }
        // Page routes: redirect to login
        const loginUrl = new URL('/login', request.url);
        loginUrl.searchParams.set('callbackUrl', pathname);
        return NextResponse.redirect(loginUrl);
      }

      // Authenticated: apply rate limiting and security headers
      const response = NextResponse.next();
      response.headers.set('X-Request-ID', crypto.randomUUID());

      // Rate limiting for API routes
      if (pathname.startsWith('/api/')) {
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
                   request.headers.get('x-real-ip') || 'unknown';

        if (!rateLimit(ip)) {
          return NextResponse.json(
            { error: '请求过于频繁，请稍后再试' },
            {
              status: 429,
              headers: {
                'Retry-After': '60',
                'X-RateLimit-Policy': '100;w=60',
              },
            }
          );
        }

        // Check Content-Length for POST/PUT/PATCH
        const method = request.method;
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
          if (contentLength > MAX_BODY_SIZE) {
            return NextResponse.json(
              { error: '请求体过大，最大允许1MB' },
              { status: 413 }
            );
          }
        }
      }

      return response;
    })
    .catch(() => {
      // Token verification failed: treat as unauthenticated
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { error: '认证失败，请重新登录' },
          { status: 401 }
        );
      }
      const loginUrl = new URL('/login', request.url);
      return NextResponse.redirect(loginUrl);
    });
}

export const config = {
  matcher: [
    // Match all paths except static files and _next
    '/((?!_next/static|_next/image|favicon.ico|covers/).*)',
  ],
};