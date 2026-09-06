import { db } from '@/lib/db';
import { safeJson, sanitizeField, isPrismaError, apiError, apiDeleted, safeJsonStringify } from '@/lib/api-utils';
import { NextResponse, NextRequest } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { getOrFail, NotFoundError } from '@/lib/crud-helpers';
import {
  VALID_SCRAPE_MODES, VALID_ENGINES, VALID_STORAGE_MODES, VALID_DEDUP_MODES,
  MAX_THREAD, MIN_THREAD, MAX_DELAY,
  validateAllSelectors, validateAllPaginations, validateContentPagination,
  validateCleanConfig, validateSavePath, validateUrlField,
  ValidationError, buildCloudBrowserConfig,
} from '@/lib/scrape-rule-validation';

// GET /api/scrape-rules/[id] - Get a single scrape rule
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rule = await db.scrapeRule.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { tasks: true } } },
    });
    return NextResponse.json(rule);
  } catch (error) {
    if (isPrismaError(error, 'P2025')) {
      return apiError('采集规则不存在', 404);
    }
    console.error('Get scrape rule error:', error);
    return apiError('获取采集规则详情失败', 500);
  }
});

// PUT /api/scrape-rules/[id] - Update a scrape rule
export const PUT = withAuth(async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.scrapeRule, { id }, '采集规则不存在');

    let body: Record<string, unknown>;
    try {
      body = (await safeJson(request)) as Record<string, unknown>;
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    // --- Basic field validation ---
    if (body.name !== undefined) {
      const val = sanitizeField(body.name, 200);
      if (!val) return apiError('规则名称不能为空', 400);
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return apiError('enabled 必须是布尔值', 400);
    }
    if (body.enableShuffle !== undefined && typeof body.enableShuffle !== 'boolean') {
      return apiError('enableShuffle 必须是布尔值', 400);
    }

    // --- Enum validation ---
    if (body.scrapeMode !== undefined && !(VALID_SCRAPE_MODES as readonly string[]).includes(body.scrapeMode as string)) {
      return apiError(`采集模式只能是: ${VALID_SCRAPE_MODES.join(', ')}`, 400);
    }
    if (body.engine !== undefined && !(VALID_ENGINES as readonly string[]).includes(body.engine as string)) {
      return apiError(`采集引擎只能是: ${VALID_ENGINES.join(', ')}`, 400);
    }
    if (body.storageMode !== undefined && !(VALID_STORAGE_MODES as readonly string[]).includes(body.storageMode as string)) {
      return apiError(`存储模式只能是: ${VALID_STORAGE_MODES.join(', ')}`, 400);
    }
    if (body.dedupMode !== undefined && !(VALID_DEDUP_MODES as readonly string[]).includes(body.dedupMode as string)) {
      return apiError(`去重模式只能是: ${VALID_DEDUP_MODES.join(', ')}`, 400);
    }

    // --- Numeric validation ---
    const tc = body.threadCount !== undefined ? Math.floor(Number(body.threadCount) || 3) : undefined;
    if (tc !== undefined && (tc < MIN_THREAD || tc > MAX_THREAD)) {
      return apiError(`线程数必须在${MIN_THREAD}-${MAX_THREAD}之间`, 400);
    }
    const minD = body.minDelay !== undefined ? Math.max(0, Math.floor(Number(body.minDelay) || 1000)) : undefined;
    const maxD = body.maxDelay !== undefined ? Math.min(MAX_DELAY, Math.max(0, Math.floor(Number(body.maxDelay) || 3000))) : undefined;
    if (minD !== undefined && maxD !== undefined && maxD < minD) {
      return apiError('最大延迟不能小于最小延迟', 400);
    }

    // --- URL validation (SSRF) ---
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
      if (e instanceof ValidationError) return apiError(e.message, 400);
      throw e;
    }

    // --- Selector validation ---
    const selErr = validateAllSelectors(body, true);
    if (selErr) return apiError(selErr, 400);

    // --- Pagination validation (list + chapter only; content has its own validator) ---
    const pagErr = validateAllPaginations(body, true);
    if (pagErr) return apiError(pagErr, 400);

    // --- Content pagination validation (stricter maxPage limit: 20) ---
    if (body.contentPagination !== undefined) {
      const contentPagErr = validateContentPagination(body.contentPagination);
      if (contentPagErr) return apiError(contentPagErr, 400);
    }

    // --- CleanConfig validation ---
    let validatedCleanConfig: string | null | undefined;
    if (body.cleanConfig !== undefined) {
      try {
        validatedCleanConfig = validateCleanConfig(body.cleanConfig);
      } catch (e) {
        if (e instanceof ValidationError) return apiError(e.message, 400);
        throw e;
      }
    }

    // --- Build JSON fields ---
    const jsonFields: Record<string, string | null | undefined> = {};
    try {
      if (body.listSelector !== undefined) jsonFields.listSelector = safeJsonStringify(body.listSelector, 'listSelector');
      if (body.listPagination !== undefined) jsonFields.listPagination = safeJsonStringify(body.listPagination, 'listPagination');
      if (body.bookTitleSelector !== undefined) jsonFields.bookTitleSelector = safeJsonStringify(body.bookTitleSelector, 'bookTitleSelector');
      if (body.bookAuthorSelector !== undefined) jsonFields.bookAuthorSelector = safeJsonStringify(body.bookAuthorSelector, 'bookAuthorSelector');
      if (body.bookCategorySelector !== undefined) jsonFields.bookCategorySelector = safeJsonStringify(body.bookCategorySelector, 'bookCategorySelector');
      if (body.bookKeywordsSelector !== undefined) jsonFields.bookKeywordsSelector = safeJsonStringify(body.bookKeywordsSelector, 'bookKeywordsSelector');
      if (body.bookDescriptionSelector !== undefined) jsonFields.bookDescriptionSelector = safeJsonStringify(body.bookDescriptionSelector, 'bookDescriptionSelector');
      if (body.bookCoverSelector !== undefined) jsonFields.bookCoverSelector = safeJsonStringify(body.bookCoverSelector, 'bookCoverSelector');
      if (body.bookStatusSelector !== undefined) jsonFields.bookStatusSelector = safeJsonStringify(body.bookStatusSelector, 'bookStatusSelector');
      if (body.chapterListSelector !== undefined) jsonFields.chapterListSelector = safeJsonStringify(body.chapterListSelector, 'chapterListSelector');
      if (body.chapterTitleSelector !== undefined) jsonFields.chapterTitleSelector = safeJsonStringify(body.chapterTitleSelector, 'chapterTitleSelector');
      if (body.chapterLinkSelector !== undefined) jsonFields.chapterLinkSelector = safeJsonStringify(body.chapterLinkSelector, 'chapterLinkSelector');
      if (body.chapterPagination !== undefined) jsonFields.chapterPagination = safeJsonStringify(body.chapterPagination, 'chapterPagination');
      if (body.contentTitleSelector !== undefined) jsonFields.contentTitleSelector = safeJsonStringify(body.contentTitleSelector, 'contentTitleSelector');
      if (body.contentSelector !== undefined) jsonFields.contentSelector = safeJsonStringify(body.contentSelector, 'contentSelector');
      if (body.contentPagination !== undefined) jsonFields.contentPagination = safeJsonStringify(body.contentPagination, 'contentPagination');
      if (body.antiCrawlConfig !== undefined) jsonFields.antiCrawlConfig = safeJsonStringify(body.antiCrawlConfig, 'antiCrawlConfig');
      if (body.cleanConfig !== undefined) jsonFields.cleanConfig = validatedCleanConfig ?? safeJsonStringify(body.cleanConfig, 'cleanConfig');
      if (body.agentqlQueries !== undefined) {
        jsonFields.agentqlConfig = safeJsonStringify(
          typeof body.agentqlQueries === 'object' && body.agentqlQueries !== null
            ? body.agentqlQueries
            : null,
          'agentqlConfig',
        );
      }
    } catch (e) {
      if (e instanceof Error) return apiError(e.message, 400);
      throw e;
    }

    // --- Build update data with ALL validated fields ---
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = sanitizeField(body.name, 200);
    if (body.description !== undefined) data.description = sanitizeField(body.description, 2000) || null;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.listUrl !== undefined) data.listUrl = sanitizeField(body.listUrl, 2000) || null;
    if (body.chapterListUrl !== undefined) data.chapterListUrl = sanitizeField(body.chapterListUrl, 2000) || null;
    if (body.scrapeMode !== undefined) data.scrapeMode = body.scrapeMode;
    if (body.engine !== undefined) data.engine = body.engine;
    if (body.storageMode !== undefined) data.storageMode = body.storageMode;
    if (body.threadCount !== undefined) data.threadCount = tc;
    if (minD !== undefined) data.minDelay = minD;
    if (maxD !== undefined) data.maxDelay = maxD;
    if (body.enableShuffle !== undefined) data.enableShuffle = body.enableShuffle;
    if (body.dedupMode !== undefined) data.dedupMode = body.dedupMode;
    // Validate save paths (path traversal check) — must return 400, not 500
    if (body.filePath !== undefined || body.coverSavePath !== undefined) {
      try {
        if (body.filePath !== undefined) data.filePath = validateSavePath(body.filePath);
        if (body.coverSavePath !== undefined) data.coverSavePath = validateSavePath(body.coverSavePath);
      } catch (e) {
        if (e instanceof ValidationError) return apiError(e.message, 400);
        throw e;
      }
    }
    // JSON fields
    for (const [key, val] of Object.entries(jsonFields)) {
      data[key] = val;
    }
    // Cloud browser config
    if (body.cloudBrowserUrl !== undefined || body.cloudBrowserProvider !== undefined) {
      data.cloudBrowserConfig = buildCloudBrowserConfig(body.cloudBrowserUrl, body.cloudBrowserProvider);
    }

    const rule = await db.scrapeRule.update({
      where: { id },
      data,
      include: { _count: { select: { tasks: true } } },
    });

    return NextResponse.json(rule);
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error('Update scrape rule error:', error);
    if (isPrismaError(error, 'P2025')) {
      return apiError('采集规则不存在', 404);
    }
    return apiError('更新采集规则失败', 500);
  }
});

// DELETE /api/scrape-rules/[id] - Delete a scrape rule
export const DELETE = withAuth(async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await getOrFail(db.scrapeRule, { id }, '采集规则不存在');
    await db.scrapeRule.delete({ where: { id } });
    return apiDeleted();
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error('Delete scrape rule error:', error);
    if (isPrismaError(error, 'P2025')) {
      return apiError('采集规则不存在', 404);
    }
    return apiError('删除采集规则失败', 500);
  }
});
