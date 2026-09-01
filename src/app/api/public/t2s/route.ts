import { NextRequest, NextResponse } from 'next/server';
import { withPublicRateLimit } from '@/lib/api-auth';
import { sanitizeField, safeJson } from '@/lib/api-utils';
import { convertTraditionalToSimplified, isProbablyTraditional } from '@/lib/t2s-converter';

/**
 * POST /api/public/t2s
 *
 * 将繁体中文文本转换为简体中文。
 * Body: { text: string } (max 10000 chars)
 * Response: { simplified: string, wasTraditional: boolean }
 */
export const POST = withPublicRateLimit({ capacity: 60, refillRate: 2 }, async (request: NextRequest) => {
  try {
    let body: { text?: unknown };
    try {
      body = await safeJson<{ text?: unknown }>(request);
    } catch {
      return NextResponse.json({ error: '请求数据格式错误' }, { status: 400 });
    }

    const raw = typeof body?.text === 'string' ? body.text : '';

    if (!raw) {
      return NextResponse.json({ error: 'text 字段不能为空' }, { status: 400 });
    }

    if (raw.length > 10000) {
      return NextResponse.json({ error: '文本长度不能超过 10000 字符' }, { status: 400 });
    }

    const text = sanitizeField(raw, 10000);
    const wasTraditional = isProbablyTraditional(text);
    const simplified = convertTraditionalToSimplified(text);

    return NextResponse.json({ simplified, wasTraditional });
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
});
