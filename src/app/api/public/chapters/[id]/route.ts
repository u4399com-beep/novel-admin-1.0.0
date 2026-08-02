import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { withPublicRateLimit } from "@/lib/api-auth";

// ─── Simple IP-based rate limiter ──────────────────────────────────
const _rateStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 120;
const RATE_WINDOW = 60_000;

function publicRateLimit(request: NextRequest): boolean {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  const entry = _rateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateStore.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) return false;
  return true;
}

if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of _rateStore) {
      if (now > val.resetAt) _rateStore.delete(key);
    }
  }, 60_000);
}

/**
 * Public chapter content API — no auth required.
 * Returns full chapter (id, title, content, wordCount) with parent novel info.
 */
export const GET = withPublicRateLimit(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!publicRateLimit(request)) {
    return NextResponse.json({ error: '请求过于频繁，请稍后再试' }, { status: 429 });
  }

  try {
    const { id } = await params;
    const chapter = await db.chapter.findUnique({
      where: { id },
      include: {
        novel: { select: { id: true, title: true } },
      },
    });

    if (!chapter) {
      return NextResponse.json({ error: "章节不存在" }, { status: 404 });
    }

    return NextResponse.json({
      id: chapter.id,
      title: chapter.title,
      content: chapter.content,
      wordCount: chapter.wordCount,
      sortOrder: chapter.sortOrder,
      novel: chapter.novel,
    });
  } catch (error) {
    console.error("Public chapter content API error:", error);
    return NextResponse.json({ error: '获取章节内容失败' }, { status: 500 });
  }
});
