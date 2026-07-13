import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import {
  VALID_SCRAPE_MODES,
  VALID_ENGINES,
  VALID_STORAGE_MODES,
  VALID_DEDUP_MODES,
  MAX_THREAD,
  MIN_THREAD,
  MAX_DELAY,
  validateAllSelectors,
  validateAllPaginations,
  validateUrlField,
  validateSavePath,
  ValidationError,
  buildCloudBrowserConfig,
} from "@/lib/scrape-rule-validation";
import { NextRequest, NextResponse } from "next/server";

// GET /api/scrape-rules/[id] - Get a single scrape rule
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rule = await db.scrapeRule.findUnique({
      where: { id },
      include: { _count: { select: { tasks: true } } },
    });
    if (!rule) {
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }
    return NextResponse.json(rule);
  } catch (error) {
    console.error("Get scrape rule error:", error);
    return NextResponse.json({ error: "获取采集规则详情失败" }, { status: 500 });
  }
});

// PUT /api/scrape-rules/[id] - Update a scrape rule
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }

    if (body.name !== undefined && !body.name?.trim()) {
      return NextResponse.json({ error: "规则名称不能为空" }, { status: 400 });
    }

    // Validate enums
    if (body.scrapeMode !== undefined && !VALID_SCRAPE_MODES.includes(body.scrapeMode)) {
      return NextResponse.json({ error: `采集模式只能是: ${VALID_SCRAPE_MODES.join(", ")}` }, { status: 400 });
    }
    if (body.engine !== undefined && !VALID_ENGINES.includes(body.engine)) {
      return NextResponse.json({ error: `采集引擎只能是: ${VALID_ENGINES.join(", ")}` }, { status: 400 });
    }
    if (body.storageMode !== undefined && !VALID_STORAGE_MODES.includes(body.storageMode)) {
      return NextResponse.json({ error: `存储模式只能是: ${VALID_STORAGE_MODES.join(", ")}` }, { status: 400 });
    }
    if (body.dedupMode !== undefined && !VALID_DEDUP_MODES.includes(body.dedupMode)) {
      return NextResponse.json({ error: `去重模式只能是: ${VALID_DEDUP_MODES.join(", ")}` }, { status: 400 });
    }
    if (body.threadCount !== undefined) {
      const tc = Math.floor(Number(body.threadCount) || 3);
      if (tc < MIN_THREAD || tc > MAX_THREAD) {
        return NextResponse.json({ error: `线程数必须在${MIN_THREAD}-${MAX_THREAD}之间` }, { status: 400 });
      }
    }

    // Validate selectors and pagination (only fields that are defined)
    const selErr = validateAllSelectors(body, true);
    if (selErr) return NextResponse.json({ error: selErr }, { status: 400 });
    const pagErr = validateAllPaginations(body, true);
    if (pagErr) return NextResponse.json({ error: pagErr }, { status: 400 });

    // Validate URL fields for SSRF — **reject** on failure instead of silently skipping
    try {
      if (body.listUrl !== undefined) {
        const val = sanitizeField(body.listUrl, 2000);
        if (val) validateUrlField(val, 'listUrl');
      }
      if (body.chapterListUrl !== undefined) {
        const val = sanitizeField(body.chapterListUrl, 2000);
        if (val) validateUrlField(val, 'chapterListUrl');
      }
      if (body.cloudBrowserUrl !== undefined) {
        const val = sanitizeField(body.cloudBrowserUrl, 2000);
        if (val) validateUrlField(val, 'Cloud Browser URL');
      }
    } catch (e) {
      if (e instanceof ValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    if (body.enableShuffle !== undefined && typeof body.enableShuffle !== 'boolean') {
      return NextResponse.json({ error: "enableShuffle 必须是布尔值" }, { status: 400 });
    }

    // Validate delay constraints
    const minD = body.minDelay !== undefined ? Math.max(0, Math.floor(Number(body.minDelay) || 1000)) : undefined;
    const maxD = body.maxDelay !== undefined ? Math.max(0, Math.floor(Number(body.maxDelay) || 3000)) : undefined;
    if (minD !== undefined && maxD !== undefined && maxD < minD) {
      return NextResponse.json({ error: "最大延迟不能小于最小延迟" }, { status: 400 });
    }

    const rule = await db.scrapeRule.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: sanitizeField(body.name, 200) }),
        ...(body.description !== undefined && { description: sanitizeField(body.description, 2000) || null }),
        ...(body.enabled !== undefined && { enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined }),

        ...(body.listUrl !== undefined && {
          listUrl: (() => {
            const val = sanitizeField(body.listUrl, 2000);
            return val || null;
          })(),
        }),
        ...(body.listSelector !== undefined && {
          listSelector: body.listSelector ? JSON.stringify(body.listSelector) : null,
        }),
        ...(body.listPagination !== undefined && {
          listPagination: body.listPagination ? JSON.stringify(body.listPagination) : null,
        }),

        ...(body.bookTitleSelector !== undefined && { bookTitleSelector: sanitizeField(body.bookTitleSelector, 500) || null }),
        ...(body.bookAuthorSelector !== undefined && { bookAuthorSelector: sanitizeField(body.bookAuthorSelector, 500) || null }),
        ...(body.bookCategorySelector !== undefined && { bookCategorySelector: sanitizeField(body.bookCategorySelector, 500) || null }),
        ...(body.bookKeywordsSelector !== undefined && { bookKeywordsSelector: sanitizeField(body.bookKeywordsSelector, 500) || null }),
        ...(body.bookDescriptionSelector !== undefined && { bookDescriptionSelector: sanitizeField(body.bookDescriptionSelector, 500) || null }),
        ...(body.bookCoverSelector !== undefined && { bookCoverSelector: sanitizeField(body.bookCoverSelector, 500) || null }),
        ...(body.bookStatusSelector !== undefined && { bookStatusSelector: sanitizeField(body.bookStatusSelector, 500) || null }),

        ...(body.chapterListUrl !== undefined && {
          chapterListUrl: (() => {
            const val = sanitizeField(body.chapterListUrl, 2000);
            return val || null;
          })(),
        }),
        ...(body.chapterListSelector !== undefined && {
          chapterListSelector: body.chapterListSelector ? JSON.stringify(body.chapterListSelector) : null,
        }),
        ...(body.chapterTitleSelector !== undefined && {
          chapterTitleSelector: body.chapterTitleSelector ? JSON.stringify(body.chapterTitleSelector) : null,
        }),
        ...(body.chapterLinkSelector !== undefined && {
          chapterLinkSelector: body.chapterLinkSelector ? JSON.stringify(body.chapterLinkSelector) : null,
        }),
        ...(body.chapterPagination !== undefined && {
          chapterPagination: body.chapterPagination ? JSON.stringify(body.chapterPagination) : null,
        }),

        ...(body.contentTitleSelector !== undefined && {
          contentTitleSelector: body.contentTitleSelector ? JSON.stringify(body.contentTitleSelector) : null,
        }),
        ...(body.contentSelector !== undefined && {
          contentSelector: body.contentSelector ? JSON.stringify(body.contentSelector) : null,
        }),
        ...(body.contentPagination !== undefined && {
          contentPagination: body.contentPagination ? JSON.stringify(body.contentPagination) : null,
        }),

        ...(body.antiCrawlConfig !== undefined && {
          antiCrawlConfig: body.antiCrawlConfig ? JSON.stringify(body.antiCrawlConfig) : null,
        }),

        ...(body.storageMode !== undefined && { storageMode: body.storageMode }),
        ...(body.filePath !== undefined && { filePath: validateSavePath(body.filePath) }),
        ...(body.coverSavePath !== undefined && { coverSavePath: validateSavePath(body.coverSavePath) }),

        ...(body.scrapeMode !== undefined && { scrapeMode: body.scrapeMode }),
        ...(body.engine !== undefined && { engine: body.engine }),
        ...(body.threadCount !== undefined && {
          threadCount: Math.min(Math.max(MIN_THREAD, Math.floor(Number(body.threadCount) || 3)), MAX_THREAD),
        }),
        ...(body.minDelay !== undefined && {
          minDelay: Math.max(0, Math.floor(Number(body.minDelay) || 1000)),
        }),
        ...(body.maxDelay !== undefined && {
          maxDelay: Math.max(0, Math.floor(Number(body.maxDelay) || 3000)),
        }),
        ...(body.enableShuffle !== undefined && { enableShuffle: body.enableShuffle }),
        ...(body.dedupMode !== undefined && { dedupMode: body.dedupMode }),

        ...(body.cleanConfig !== undefined && {
          cleanConfig: body.cleanConfig ? JSON.stringify(body.cleanConfig) : null,
        }),

        ...(body.agentqlQueries !== undefined && {
          agentqlConfig: body.agentqlQueries
            ? JSON.stringify(
                typeof body.agentqlQueries === 'object' && body.agentqlQueries !== null
                  ? body.agentqlQueries
                  : {},
                (key, value) => typeof value === 'string' ? value.slice(0, 2000) : value
              )
            : null,
        }),
        ...(body.cloudBrowserUrl !== undefined && {
          cloudBrowserConfig: buildCloudBrowserConfig(body.cloudBrowserUrl, body.cloudBrowserProvider),
        }),
      },
      include: { _count: { select: { tasks: true } } },
    });

    return NextResponse.json(rule);
  } catch (error: unknown) {
    console.error("Update scrape rule error:", error);
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "更新采集规则失败" }, { status: 500 });
  }
});

// DELETE /api/scrape-rules/[id] - Delete a scrape rule
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.scrapeRule.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }
    // Prevent deleting rules with running tasks (cascade would cause silent data loss)
    const runningCount = await db.scrapeTask.count({ where: { ruleId: id, status: "running" } });
    if (runningCount > 0) {
      return NextResponse.json(
        { error: `无法删除：有 ${runningCount} 个任务正在运行，请先停止任务` },
        { status: 409 }
      );
    }
    await db.scrapeRule.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete scrape rule error:", error);
    if (isPrismaError(error, "P2025")) {
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "删除采集规则失败" }, { status: 500 });
  }
});