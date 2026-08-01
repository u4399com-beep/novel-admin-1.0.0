import { getToken } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Diagnostic endpoint — helps identify why API auth fails.
 * Returns detailed auth state without requiring authentication.
 * REMOVE IN PRODUCTION or protect with IP whitelist.
 */
export async function GET(request: NextRequest) {
  const info: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    env: {
      NODE_ENV: process.env.NODE_ENV || 'not set',
      NEXTAUTH_URL: process.env.NEXTAUTH_URL || 'not set',
      NEXTAUTH_SECRET_SET: !!process.env.NEXTAUTH_SECRET,
      NEXTAUTH_SECRET_LENGTH: process.env.NEXTAUTH_SECRET?.length || 0,
      ADMIN_USERNAME_SET: !!process.env.ADMIN_USERNAME,
      ADMIN_PASSWORD_SET: !!process.env.ADMIN_PASSWORD,
      DATABASE_URL_SET: !!process.env.DATABASE_URL,
      DATABASE_URL_PREFIX: process.env.DATABASE_URL?.substring(0, 20) || 'not set',
    },
    cookies: {},
    headers: {
      cookie: (request.headers.get('cookie') || '').substring(0, 100) + '...',
      'x-real-ip': request.headers.get('x-real-ip') || 'not set',
      'x-forwarded-for': request.headers.get('x-forwarded-for') || 'not set',
      authorization: request.headers.get('authorization') ? 'set (redacted)' : 'not set',
    },
  };

  // Check session cookie names
  const cookieHeader = request.headers.get('cookie') || '';
  const hasNormalToken = cookieHeader.includes('next-auth.session-token');
  const hasSecureToken = cookieHeader.includes('__Secure-next-auth.session-token');
  info.cookies = {
    hasNormalSessionToken: hasNormalToken,
    hasSecureSessionToken: hasSecureToken,
    cookieHeaderLength: cookieHeader.length,
  };

  // Try to verify the token
  try {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    info.tokenResult = token ? 'valid' : 'null (no valid session)';
    if (token) {
      info.tokenPayload = {
        id: token.id,
        name: token.name,
        iat: token.iat,
        exp: token.exp,
        expRelative: token.exp ? `${Math.max(0, Number(token.exp) - Math.floor(Date.now() / 1000))}s remaining` : 'N/A',
      };
    }
  } catch (err) {
    info.tokenResult = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return NextResponse.json(info);
}
