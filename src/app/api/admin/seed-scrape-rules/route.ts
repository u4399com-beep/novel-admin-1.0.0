import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson, sanitizeField, safeJsonStringify, apiError, apiSuccess } from '@/lib/api-utils';
import { parseScrapeParams, validateSavePath, buildCloudBrowserConfig } from '@/lib/scrape-rule-validation';

/**
 * POST /api/admin/seed-scrape-rules
 *
 * Accepts an array of scrape rule objects and upserts them using name as key.
 * Uses batched operations to avoid N+1 query pattern.
 */
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body: { rules?: Record<string, unknown>[] };
    try {
      body = await safeJson<{ rules?: Record<string, unknown>[] }>(request);
    } catch {
      return apiError('请求数据格式错误', 400);
    }

    if (!Array.isArray(body.rules) || body.rules.length === 0) {
      return apiError('rules 必须是非空数组', 400);
    }

    if (body.rules.length > 50) {
      return apiError('单次最多导入50条规则', 400);
    }

    // Batch: fetch all existing rules by name in a single query
    const rawNames = body.rules.map(r => typeof r.name === 'string' ? r.name.trim() : '').filter(Boolean);
    const existingRules = rawNames.length > 0
      ? await db.scrapeRule.findMany({
          where: { name: { in: rawNames } },
          select: { id: true, name: true },
        })
      : [];
    const existingByName = new Map(existingRules.map(r => [r.name, r.id]));

    const results: { id: string; name: string; action: 'created' | 'updated' }[] = [];
    let created = 0;
    let updated = 0;

    // Process each rule
    for (const raw of body.rules) {
      if (!raw.name || typeof raw.name !== 'string') continue;
      const name = sanitizeField(raw.name, 200);
      const listUrl = raw.listUrl ? sanitizeField(raw.listUrl, 2000) : null;

      const params = parseScrapeParams(raw as Record<string, unknown>);

      const data = {
        name,
        description: sanitizeField(raw.description, 2000) || null,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,

        listUrl,
        listSelector: safeJsonStringify(raw.listSelector, 'listSelector') ?? null,
        listPagination: safeJsonStringify(raw.listPagination, 'listPagination') ?? null,

        bookTitleSelector: safeJsonStringify(raw.bookTitleSelector, 'bookTitleSelector') ?? null,
        bookAuthorSelector: safeJsonStringify(raw.bookAuthorSelector, 'bookAuthorSelector') ?? null,
        bookCategorySelector: safeJsonStringify(raw.bookCategorySelector, 'bookCategorySelector') ?? null,
        bookKeywordsSelector: safeJsonStringify(raw.bookKeywordsSelector, 'bookKeywordsSelector') ?? null,
        bookDescriptionSelector: safeJsonStringify(raw.bookDescriptionSelector, 'bookDescriptionSelector') ?? null,
        bookCoverSelector: safeJsonStringify(raw.bookCoverSelector, 'bookCoverSelector') ?? null,
        bookStatusSelector: safeJsonStringify(raw.bookStatusSelector, 'bookStatusSelector') ?? null,

        chapterListUrl: sanitizeField(raw.chapterListUrl, 2000) || null,
        chapterListSelector: safeJsonStringify(raw.chapterListSelector, 'chapterListSelector') ?? null,
        chapterTitleSelector: safeJsonStringify(raw.chapterTitleSelector, 'chapterTitleSelector') ?? null,
        chapterLinkSelector: safeJsonStringify(raw.chapterLinkSelector, 'chapterLinkSelector') ?? null,
        chapterPagination: safeJsonStringify(raw.chapterPagination, 'chapterPagination') ?? null,

        contentTitleSelector: safeJsonStringify(raw.contentTitleSelector, 'contentTitleSelector') ?? null,
        contentSelector: safeJsonStringify(raw.contentSelector, 'contentSelector') ?? null,
        contentPagination: safeJsonStringify(raw.contentPagination, 'contentPagination') ?? null,

        antiCrawlConfig: safeJsonStringify(raw.antiCrawlConfig, 'antiCrawlConfig') ?? null,

        storageMode: params.storageMode,
        filePath: (() => { try { return validateSavePath(raw.filePath); } catch { return null; } })(),
        coverSavePath: (() => { try { return validateSavePath(raw.coverSavePath); } catch { return null; } })(),

        scrapeMode: params.scrapeMode,
        engine: params.engine,
        threadCount: params.threadCount,
        minDelay: params.minDelay,
        maxDelay: params.maxDelay,
        enableShuffle: raw.enableShuffle ?? false,
        dedupMode: params.dedupMode,

        cleanConfig: safeJsonStringify(raw.cleanConfig, 'cleanConfig') ?? null,
        agentqlConfig: safeJsonStringify(raw.agentqlConfig, 'agentqlConfig') ?? null,
        cloudBrowserConfig: buildCloudBrowserConfig(raw.cloudBrowserUrl, raw.cloudBrowserProvider),
      };

      const existingId = existingByName.get(name);

      if (existingId) {
        await db.scrapeRule.update({ where: { id: existingId }, data });
        results.push({ id: existingId, name, action: 'updated' });
        updated++;
      } else {
        const rule = await db.scrapeRule.create({ data });
        results.push({ id: rule.id, name, action: 'created' });
        created++;
      }
    }

    return apiSuccess({ results, created, updated, total: results.length });
  } catch (error) {
    console.error('Seed scrape rules error:', error);
    return apiError('种子规则导入失败');
  }
});
