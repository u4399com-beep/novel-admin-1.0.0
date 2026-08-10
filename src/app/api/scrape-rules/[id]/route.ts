#!/usr/bin/env ts

import { db } from '@/lib/db';
import { safeJson, sanitizeField, isPrismaError, apiError, apiDeleted, safeJsonStringify } from '@/lib/api-utils';
import { NextResponse } from 'next/server';
import { invalidateCache } from '@/lib/cache';
import { withAuth } from '@/lib/api-auth';
import {
  VALID_SCRAPE_MODES, VALID_ENGINES, VALID_STORAGE_MODES, VALID_DEDUP_MODES, MAX_THREAD, MIN_THREAD, validateAllSelectors, validateAllPaginations, validateContentPagination, validateCleanConfig, validateSavePath, ValidationError, buildCloudBrowserConfig } from '@/lib/scrape-rule-validation';

// GET /api/scrape-rules/[id] - Get a single scrape rule
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rule = await db.scrapeRule.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { tasks: true } },
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
      body = await safeJson(request) as Record<string, unknown>;
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    const { name, description, identifier, preview, config, enabled } = body;

    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return apiError('规则名称不能为空', 400);
    }
    if (typeof identifier !== 'string' || !identifier.trim()) {
      return apiError('标识符不能为空', 400);
    }
    if (typeof identifier === 'string' && identifier.trim().length > MAX_IDENTIFIER_LENGTH) {
      return apiError(`标识符不能超过${MAX_IDENTIFIER_LENGTH}个字符`, 400);
    }
    if (description !== undefined && typeof description === 'string' && description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return apiError(`描述不能超过${MAX_DESCRIPTION_LENGTH}个字符`, 400);
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return apiError('enabled 必须是布尔值', 400);
    }

    // Validate enums
    if (body.scrapeMode !== undefined && !VALID_SCRAPE_MODES.includes(body.scrapeMode)) {
      return apiError(`采集模式只能是: ${VALID_SCRAPE_MODES.join(', ')}`, 400);
    }
    if (body.engine !== undefined && !VALID_ENGINES.includes(body.engine)) {
      return apiError(`采集引擎只能是: ${VALID_ENGINES.join(', ')}`, 400);
    }
    if (body.storageMode !== undefined && !VALID_STORAGE_MODES.includes(body.storageMode)) {
      return apiError(`存储模式只能是: ${VALID_STORAGE_MODES.join(', ')}`, 400);
    }
    if (body.dedupMode !== undefined && !VALID_DEDUP_MODES.includes(body.dedupMode)) {
      return apiError(`去重模式只能是: ${VALID_DEDUP_MODES.join(', ')}`, 400);
    }
    if (body.threadCount !== undefined) {
      const tc = Math.floor(Number(body.threadCount) || 3);
      if (tc < MIN_THREAD || tc > MAX_THREAD) {
        return apiError(`线程数必须在${MIN_THREAD}-${MAX_THREAD}之间`, 400);
      }
    }

    if (body.enableShuffle !== undefined && typeof body.enableShuffle !== 'boolean') {
      return apiError('enableShuffle 必须是布尔值', 400);
    }

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

    // Validate selectors, pagination, and cleanConfig
    const selErr = validateAllSelectors(body, true);
    if (selErr) return apiError(selErr, 400);
    const pagErr = validateAllPaginations(body, true);
    if (pagErr) return apiError(pagErr, 400);

    // Validate contentPagination with stricter maxPage limit
    if (body.contentPagination !== undefined) {
      const contentPagErr = validateContentPagination(body.contentPagination);
      if (contentPagErr) return apiError(contentPagErr, 400);
    }

    // Pre-validate cleanConfig
    let validatedCleanConfig: string | null | undefined;
    if (body.cleanConfig !== undefined) {
      try {
        validatedCleanConfig = validateCleanConfig(body.cleanConfig);
      } catch (e) {
        if (e instanceof ValidationError) return apiError(e.message, 400);
        throw e;
      }
    }

    // Validate delay constraints
    const minD = body.minDelay !== undefined ? Math.max(0, Math.floor(Number(body.minDelay) || 1000)) : undefined;
    const maxD = body.maxDelay !== undefined ? Math.max(0, Math.floor(Number(body.maxDelay) || 3000)) : undefined;
    if (minD !== undefined && maxD !== undefined && maxD < minD) {
      return apiError('最大延迟不能小于最小延迟', 400);
    }
    if (minD === undefined && maxD !== undefined) {
      const existing = await db.scrapeRule.findUnique({ where: { id }, select: { maxDelay: true } });
      if (existing && maxD < (existing.minDelay || 1000)) {
        return apiError(`最大延迟(${maxD}ms)不能小于当前最小延迟(${existing.minDelay || 1000}ms)`, 400);
      }
    }
    if (maxD === undefined && minD !== undefined) {
      const existing = await db.scrapeRule.findUnique({ where: { id }, select: { minDelay: true } });
      if (existing && minD > (existing.maxDelay || 3000)) {
        return apiError(`最小延迟(${minD}ms)不能大于当前最大延迟(${existing.maxDelay || 3000}ms)`, 400);
      }
    }

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return apiError('enabled 必须是布尔值', 400);
    }
    if (body.enableShuffle !== undefined && typeof body.enableShuffle !== 'boolean') {
      return apiError('enableShuffle 必须是布尔值', 400);
    }
    // antiCrawlLevel removed: field does not exist in Prisma schema
    // Accept and silently ignore to maintain backward compatibility with clients

    // Build JSON fields — capture validation errors as 400
    let jsonFields: Record<string, string | null> = {};
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
      // Chapter selectors
      if (body.chapterListSelector !== undefined) jsonFields.chapterListSelector = safeJsonStringify(body.chapterListSelector, 'chapterListSelector');
      if (body.chapterTitleSelector !== undefined) jsonFields.chapterTitleSelector = safeJsonStringify(body.chapterTitleSelector, 'chapterTitleSelector');
      if (body.chapterLinkSelector !== undefined) jsonFields.chapterLinkSelector = safeJsonStringify(body.chapterLinkSelector, 'chapterLinkSelector');
      if (body.chapterPagination !== undefined) jsonFields.chapterPagination = safeJsonStringify(body.chapterPagination, 'chapterPagination');
      if (body.contentTitleSelector !== undefined) jsonFields.contentTitleSelector = safeJsonStringify(body.contentTitleSelector, 'contentTitleSelector');
      if (body.contentSelector !== undefined) jsonFields.contentSelector = safeJsonStringify(body.contentSelector, 'contentSelector');
      if (body.contentPagination !== undefined) jsonFields.contentPagination = safeJsonStringify(body.contentPagination, 'contentPagination');
      if (body.antiCrawlConfig !== undefined) jsonFields.antiCrawlConfig = safeJsonStringify(body.antiCrawlConfig, 'antiCrawlConfig');
      // cleanConfig: use pre-validated value if available
      if (body.cleanConfig !== undefined) jsonFields.cleanConfig = validatedCleanConfig ?? safeJsonStringify(body.cleanConfig, 'cleanConfig');
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
        ...(body.name !== undefined && { name: sanitizeField(body.name, 200) },
        ...(body.description !== undefined && { description: sanitizeField(body.description, 2000) || null },
        ...(body.enabled !== undefined && { enabled: body.enabled }),

        ...(body.listUrl !== undefined && {
          listUrl: (() => {
            const val = sanitizeField(body.listUrl, 2000);
            return val || null;
          })(),
        }),
        ...(body.listSelector !== undefined && { listSelector: jsonFields.listSelector }),
        ...(body.listPagination !== undefined && { listPagination: jsonFields.listPagination }),
      },
    });

    return NextResponse.json(rule);
  } catch (error: unknown) {
    if (error instanceof NotFoundError) {
      return apiError(error.message, 404);
    }
    console.error('Update scrape rule error:', error);
    if (isPrismaError(error, 