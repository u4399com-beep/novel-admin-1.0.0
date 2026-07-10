import { NextRequest, NextResponse } from 'next/server';

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

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Security headers
  response.headers.set('X-Request-ID', crypto.randomUUID());

  // Rate limiting for API routes only
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
               request.headers.get('x-real-ip') || 'unknown';

    if (!rateLimit(ip)) {
      return NextResponse.json(
        { error: '请求过于频繁，请稍后再试' },
        {
          status: 429,
          headers: {
            'Retry-After': '60',
            'X-RateLimit-Policy': `100;w=60`,
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
}

export const config = {
  matcher: '/api/:path*',
};