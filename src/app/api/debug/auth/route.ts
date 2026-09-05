import { getToken } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { apiError } from "@/lib/api-utils"

/**
 * Diagnostic endpoint — helps identify why API auth fails.
 * PROTECTED: requires authentication. Also blocked in production.
 */
export const GET = withAuth(async function GET(request: NextRequest) {
  // Block in production — no diagnostics needed
  if (process.env.NODE_ENV === 'production') {
    return apiError('Not available in production', 404);
  }

  const info: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    env: {
      NODE_ENV: process.env.NODE_ENV || 'not set',
      NEXTAUTH_URL: process.env.NEXTAUTH_URL ? 'set' : 'not set',
      NEXTAUTH_SECRET_SET: !!process.env.NEXTAUTH_SECRET,
      ADMIN_USERNAME_SET: !!process.env.ADMIN_USERNAME,
      ADMIN_PASSWORD_SET: !!process.env.ADMIN_PASSWORD,
      DATABASE_URL_SET: !!process.env.DATABASE_URL,
    },
    cookies: {},
    headers: {
      'x-real-ip': request.headers.get('x-real-ip') || 'not set',
      'x-forwarded-for': request.headers.get('x-forwarded-for') || 'not set',
      authorization: request.headers.get('authorization') ? 'set (redacted)' : 'not set',
    },
  };

  // Check session cookie names (no cookie content leak)
  const cookieHeader = request.headers.get('cookie') || '';
  const hasNormalToken = cookieHeader.includes('next-auth.session-token');
  const hasSecureToken = cookieHeader.includes('__Secure-next-auth.session-token');
  info.cookies = {
    hasNormalSessionToken: hasNormalToken,
    hasSecureSessionToken: hasSecureToken,
  };

  // Try to verify the token
  try {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    info.tokenResult = token ? 'valid' : 'null (no valid session)';
    if (token) {
      info.isExpired = token.exp ? Number(token.exp) < Math.floor(Date.now() / 1000) : true;
      info.isAdmin = !!token.isAdmin;
    }
  } catch (err) {
    info.tokenResult = 'error verifying token';
  }

  return NextResponse.json(info);
});
