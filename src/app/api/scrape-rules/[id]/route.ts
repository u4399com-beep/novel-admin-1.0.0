import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError, safeJsonStringify, apiError } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import {
  VALID_SCRAPE_MODES,
  VALID_ENGINES,
  VALID_STORAGE_MODES,
  VALID_DEDUP_MODES,
  MAX_THREAD,
  MIN_THREAD,
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
      return apiError("采集规则不存在", 404);
    }
    return NextResponse.json(rule);
  } catch (error) {
    console.error("Get scrape rule error:", error);
    return apiError("获取采集规则详情失败", 500);
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
      return apiError("请求数据格式错误", 400);
    }

    if (body.name !== undefined && !body.name?.trim()) {
      return apiError("规则名称不能为空", 400);
    }

    // Validate enums
    if (body.scrapeMode !== undefined && !VALID_SCRAPE_MODES.includes(body.scrapeMode)) {
      return apiError(`采集模式只能是: ${VALID_SCRAPE_MODES.join(", ")}`, 400);
    }
    if (body.engine !== undefined && !VALID_ENGINES.includes(body.engine)) {
      return apiError(`采集引擎只能是: ${VALID_ENGINES.join(", ")}`, 400);
    }
    if (body.storageMode !== undefined && !VALID_STORAGE_MODES.includes(body.storageMode)) {
      return apiError(`存储模式只能是: ${VALID_STORAGE_MODES.join(", ")}`, 400);
    }
    if (body.dedupMode !== undefined && !VALID_DEDUP_MODES.includes(body.dedupMode)) {
      return apiError(`去重模式只能是: ${VALID_DEDUP_MODES.join(", ")}`, 400);
    }
    if (body.threadCount !== undefined) {
      const tc = Math.floor(Number(body.threadCount) || 3);
      if (tc < MIN_THREAD || tc > MAX_THREAD) {
        return apiError(`线程数必须在${MIN_THREAD}-${MAX_THREAD}之间`, 400);
      }
    }

    // Validate selectors and pagination (only fields that are defined)
    const selErr = validateAllSelectors(body, true);
    if (selErr) return apiError(selErr, 400);
    const pagErr = validateAllPaginations(body, true);
    if (pagErr) return apiError(pagErr, 400);

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
        return apiError(e.message, 400);
      }
      throw e;
    }

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return apiError("enabled 必须是布尔值", 400);
    }
    if (body.enableShuffle !== undefined && typeof body.enableShuffle !== 'boolean') {
      return apiError("enableShuffle 必须是布尔值", 400);
    }
    if (body.antiCrawlLevel !== undefined) {
      const acl = Math.floor(Number(body.antiCrawlLevel));
      if (isNaN(acl) || acl < 1 || acl > 5) {
        return apiError("antiCrawlLevel 必须是 1-5 之间的整数", 400);
      }
    }

    // Validate delay constraints
    const minD = body.minDelay !== undefined ? Math.max(0, Math.floor(Number(body.minDelay) || 1000)) : undefined;
    const maxD = body.maxDelay !== undefined ? Math.max(0, Math.floor(Number(body.maxDelay) || 3000)) : undefined;
    if (minD !== undefined && maxD !== undefined && maxD < minD) {
      return apiError("最大延迟不能小于最小延迟", 400);
    }
    // Cross-validate: if only maxD is provided, ensure it >= existing minDelay
    if (minD === undefined && maxD !== undefined) {
      const existing = await db.scrapeRule.findUnique({ where: { id }, select: { minDelay: true } });
      if (existing && maxD < (existing.minDelay || 1000)) {
        return apiError(`最大延迟(${maxD}ms)不能小于当前最小延迟(${existing.minDelay || 1000}ms)`, 400);
      }
    }
    // Cross-validate: if only minD is provided, ensure it <= existing maxDelay
    if (maxD === undefined && minD !== undefined) {
      const existing = await db.scrapeRule.findUnique({ where: { id }, select: { maxDelay: true } });
      if (existing && minD > (existing.maxDelay || 3000)) {
        return apiError(`最小延迟(${minD}ms)不能大于当前最大延迟(${existing.maxDelay || 3000}ms)`, 400);
      }
    }

    // Build JSON fields — capture validation errors as 400
    let jsonFields: Record<string, string | null> = {};
    try {
      if (body.listSelector !== undefined) jsonFields.listSelector = safeJsonStringify(body.listSelector, 'listSelector');
      if (body.listPagination !== undefined) jsonFields.listPagination = safeJsonStringify(body.listPagination, 'listPagination');
      if (body.chapterListSelector !== undefined) jsonFields.chapterListSelector = safeJsonStringify(body.chapterListSelector, 'chapterListSelector');
      if (body.chapterTitleSelector !== undefined) jsonFields.chapterTitleSelector = safeJsonStringify(body.chapterTitleSelector, 'chapterTitleSelector');
      if (body.chapterLinkSelector !== undefined) jsonFields.chapterLinkSelector = safeJsonStringify(body.chapterLinkSelector, 'chapterLinkSelector');
      if (body.chapterPagination !== undefined) jsonFields.chapterPagination = safeJsonStringify(body.chapterPagination, 'chapterPagination');
      if (body.contentTitleSelector !== undefined) jsonFields.contentTitleSelector = safeJsonStringify(body.contentTitleSelector, 'contentTitleSelector');
      if (body.contentSelector !== undefined) jsonFields.contentSelector = safeJsonStringify(body.contentSelector, 'contentSelector');
      if (body.contentPagination !== undefined) jsonFields.contentPagination = safeJsonStringify(body.contentPagination, 'contentPagination');
      if (body.antiCrawlConfig !== undefined) jsonFields.antiCrawlConfig = safeJsonStringify(body.antiCrawlConfig, 'antiCrawlConfig');
      if (body.cleanConfig !== undefined) jsonFields.cleanConfig = safeJsonStringify(body.cleanConfig, 'cleanConfig');
      if (body.agentqlQueries !== undefined) {
        jsonFields.agentqlConfig = safeJsonStringify(
          typeof body.agentqlQueries === 'object' && body.agentqlQueries !== null
            ? body.agentqlQueries
            : null,
          'agentqlConfig'
        );
      }
    } catch (e) {
      if (e instanceof Error) {
        return apiError(e.message, 400);
      }
      throw e;
    }

    const rule = await db.scrapeRule.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: sanitizeField(body.name, 200) }),
        ...(body.description !== undefined && { description: sanitizeField(body.description, 2000) || null }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),

        ...(body.listUrl !== undefined && {
          listUrl: (() => {
            const val = sanitizeField(body.listUrl, 2000);
            return val || null;
          })(),
        }),
        ...(body.listSelector !== undefined && { listSelector: jsonFields.listSelector }),
        ...(body.listPagination !== undefined && { listPagination: jsonFields.listPagination }),

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
        ...(body.chapterListSelector !== undefined && { chapterListSelector: jsonFields.chapterListSelector }),
        ...(body.chapterTitleSelector !== undefined && { chapterTitleSelector: jsonFields.chapterTitleSelector }),
        ...(body.chapterLinkSelector !== undefined && { chapterLinkSelector: jsonFields.chapterLinkSelector }),
        ...(body.chapterPagination !== undefined && { chapterPagination: jsonFields.chapterPagination }),

        ...(body.contentTitleSelector !== undefined && { contentTitleSelector: jsonFields.contentTitleSelector }),
        ...(body.contentSelector !== undefined && { contentSelector: jsonFields.contentSelector }),
        ...(body.contentPagination !== undefined && { contentPagination: jsonFields.contentPagination }),

        ...(body.antiCrawlConfig !== undefined && { antiCrawlConfig: jsonFields.antiCrawlConfig }),
        ...(body.antiCrawlLevel !== undefined && { antiCrawlLevel: Math.min(5, Math.max(1, Math.floor(Number(body.antiCrawlLevel)))) }),

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

        ...(body.cleanConfig !== undefined && { cleanConfig: jsonFields.cleanConfig }),

        ...(body.agentqlQueries !== undefined && { agentqlConfig: jsonFields.agentqlConfig }),
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
      return apiError("采集规则不存在", 404);
    }
    return apiError("更新采集规则失败", 500);
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
      return apiError("采集规则不存在", 404);
    }
    // Prevent deleting rules with running tasks (cascade would cause silent data loss)
    // Use transaction to prevent TOCTOU race between count and delete
    const deleted = await db.$transaction(async (tx) => {
      const runningCount = await tx.scrapeTask.count({ where: { ruleId: id, status: 'running' } });
      if (runningCount > 0) {
        return { conflict: true, runningCount } as const;
      }
      await tx.scrapeRule.delete({ where: { id } });
      return { conflict: false } as const;
    });
    if (deleted.conflict) {
            return apiError(`无法删除：有 ${deleted.runningCount} 个任务正在运行，请先停止任务`, 409);
    }
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete scrape rule error:", error);
    if (isPrismaError(error, "P2025")) {
      return apiError("采集规则不存在", 404);
    }
    return apiError("删除采集规则失败", 500);
  }
});