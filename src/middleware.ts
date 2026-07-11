import { NextRequest, NextResponse } from 'next/server';

// ═══════════════════════════════════════════════════════════════════════════════
// Minimal Middleware - Edge Runtime Compatible
// Only handles XTransformPort blocking (no Node.js APIs needed)
// Auth & rate limiting are handled by withAuth() wrapper in API routes
// ═══════════════════════════════════════════════════════════════════════════════

const ALLOWED_TRANSFORM_PORTS = ['3000', '3001', '3099', '3003', '4000'];

export function middleware(request: NextRequest) {
  const xPort = request.nextUrl.searchParams.get('XTransformPort');
  if (xPort && !ALLOWED_TRANSFORM_PORTS.includes(xPort)) {
    return NextResponse.json({ error: '非法的端口参数' }, { status: 400 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|covers/).*)',
  ],
};