import { NextRequest, NextResponse } from 'next/server';
import { safeJson, apiError } from '@/lib/api-utils';

interface DetectRequestBody {
  text: string;
}

// POST /api/translate/detect
export async function POST(request: NextRequest) {
  let body: DetectRequestBody;
  try {
    body = await safeJson<DetectRequestBody>(request);
  } catch {
    return apiError('请求数据格式错误', 400);
  }

  if (typeof body.text !== 'string') {
    return apiError('缺少必要参数: text', 400);
  }

  if (body.text.length === 0) {
    return apiError('检测文本不能为空', 400);
  }

  if (body.text.length > 50000) {
    return apiError('文本过长，最大支持50000字符', 400);
  }

  try {
    const resp = await fetch('http://localhost:3032/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body.text }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const status = resp.status;
      let errorMsg = `语言检测服务返回错误 (${status})`;
      try {
        const errBody = (await resp.json()) as { error?: string };
        if (typeof errBody.error === 'string') {
          errorMsg = errBody.error;
        }
      } catch {
        // ignore parse errors
      }
      console.error(`[translate/detect] Service returned ${status}`);
      return apiError(errorMsg, status >= 500 ? 502 : status);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return NextResponse.json(data);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return apiError('语言检测服务超时，请稍后重试', 504);
    }
    console.error('[translate/detect] Error:', error);
    return apiError('语言检测服务暂时不可用', 502);
  }
}
