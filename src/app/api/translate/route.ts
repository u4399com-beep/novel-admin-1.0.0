import { NextRequest, NextResponse } from 'next/server';
import { safeJson, apiError } from '@/lib/api-utils';
import { withPublicRateLimit } from '@/lib/api-auth';

interface TranslateRequestBody {
  text: string;
  source: string;
  target: string;
  format?: 'text' | 'html';
}

// POST /api/translate
export const POST = withPublicRateLimit({ capacity: 30, refillRate: 0.5 }, async function POST(request: NextRequest) {

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
    const translateServiceUrl = process.env.TRANSLATE_SERVICE_URL || 'http://localhost:3032';
    const resp = await fetch(`${translateServiceUrl}/translate`, {
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
});
