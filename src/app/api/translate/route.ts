import { NextRequest, NextResponse } from 'next/server';
import { safeJson, apiError } from '@/lib/api-utils';

// Simple in-memory rate limiter (public endpoint, no auth)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 100;
const RATE_WINDOW = 60_000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  // Periodic cleanup to prevent memory leaks
  if (rateLimitMap.size > 10000) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }
  return entry.count <= RATE_LIMIT;
}

interface TranslateRequestBody {
  text: string;
  source: string;
  target: string;
  format?: 'text' | 'html';
}

// POST /api/translate
export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',').pop()?.trim() ||
    'unknown';

  if (!checkRateLimit(ip)) {
    return apiError('请求过于频繁，请稍后再试', 429);
  }

  let body: TranslateRequestBody;
  try {
    body = await safeJson<TranslateRequestBody>(request);
  } catch {
    return apiError('请求数据格式错误', 400);
  }

  if (
    typeof body.text !== 'string' ||
    typeof body.source !== 'string' ||
    typeof body.target !== 'string'
  ) {
    return apiError('缺少必要参数: text, source, target', 400);
  }

  if (body.text.length === 0) {
    return apiError('翻译文本不能为空', 400);
  }

  if (body.text.length > 50000) {
    return apiError('文本过长，最大支持50000字符', 400);
  }

  if (!/^[a-z]{2,5}$/.test(body.source) || !/^[a-z]{2,5}$/.test(body.target)) {
    return apiError('语言代码格式不正确', 400);
  }

  const format: string = body.format === 'html' ? 'html' : 'text';

  try {
    const resp = await fetch('http://localhost:3032/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: body.text,
        source: body.source,
        target: body.target,
        format,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!resp.ok) {
      const status = resp.status;
      let errorMsg = `翻译服务返回错误 (${status})`;
      try {
        const errBody = (await resp.json()) as { error?: string };
        if (typeof errBody.error === 'string') {
          errorMsg = errBody.error;
        }
      } catch {
        // ignore parse errors
      }
      console.error(`[translate] Service returned ${status}`);
      return apiError(errorMsg, status >= 500 ? 502 : status);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return NextResponse.json(data);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return apiError('翻译服务超时，请稍后重试', 504);
    }
    console.error('[translate] Error:', error);
    return apiError('翻译服务暂时不可用', 502);
  }
}
