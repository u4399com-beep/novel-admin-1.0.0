import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { withPublicRateLimit } from '@/lib/api-auth';

// GET /api/translate/languages
export const GET = withPublicRateLimit({ capacity: 30, refillRate: 1 }, async function GET() {
  try {
    const resp = await fetch('/languages?XTransformPort=3032', {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const status = resp.status;
      console.error(`[translate/languages] Service returned ${status}`);
      return apiError(`语言列表服务返回错误 (${status})`, status >= 500 ? 502 : status);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return NextResponse.json(data);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return apiError('语言列表服务超时，请稍后重试', 504);
    }
    console.error('[translate/languages] Error:', error);
    return apiError('语言列表服务暂时不可用', 502);
  }
});
