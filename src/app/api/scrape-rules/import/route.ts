import { db } from '@/lib/db';
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import { safeJson, sanitizeField, safeJsonStringify, apiError, apiSuccess } from '@/lib/api-utils';
import { parseScrapeParams, validateSavePath, validateUrlField, buildCloudBrowserConfig, validateCleanConfig } from '@/lib/scrape-rule-validation';

/**
 * POST /api/scrape-rules/import
 *
 * Accepts { rules: [...] } array of rule objects.
 * For each rule, upserts by name using Prisma upsert (atomic, avoids TOCTOU).
 * Returns per-rule results including errors/warnings.
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

    const results: Array<{
      name: string;
      action: 'created' | 'updated' | 'skipped';
      id?: string;
      errors?: string[];
    }> = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of body.rules) {
      // Validate name
      if (!raw.name || typeof raw.name !== 'string' || !raw.name.trim()) {
        results.push({ name: String(raw.name || '未命名'), action: 'skipped', errors: ['名称无效'] });
        skipped++;
        continue;
      }

      const name = sanitizeField(raw.name, 200);
      const ruleErrors: string[] = [];

      // Validate URL fields for SSRF
      try {
        if (raw.listUrl) validateUrlField(raw.listUrl, 'listUrl');
      } catch (e) { ruleErrors.push(e instanceof Error ? e.message : String(e)); }

      try {
        if (raw.chapterListUrl) validateUrlField(raw.chapterListUrl, 'chapterListUrl');
      } catch (e) { ruleErrors.push(e instanceof Error ? e.message : String(e)); }

      // Skip rules with critical validation errors
      if (ruleErrors.length > 0) {
        results.push({ name, action: 'skipped', errors: ruleErrors });
        skipped++;
        continue;
      }

      const listUrl = raw.listUrl ? sanitizeField(raw.listUrl, 2000) : null;
      const params = parseScrapeParams(raw as Record<string, unknown>);

      const data = {
        name,
        description: sanitizeField(raw.description, 2000) || null,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,

        listUrl,
        listSelector: safeJsonStringify(raw.listSelector, 'listSelector'),
        listPagination: safeJsonStringify(raw.listPagination, 'listPagination'),

        bookTitleSelector: safeJsonStringify(raw.bookTitleSelector, 'bookTitleSelector'),
        bookAuthorSelector: safeJsonStringify(raw.bookAuthorSelector, 'bookAuthorSelector'),
        bookCategorySelector: safeJsonStringify(raw.bookCategorySelector, 'bookCategorySelector'),
        bookKeywordsSelector: safeJsonStringify(raw.bookKeywordsSelector, 'bookKeywordsSelector'),
        bookDescriptionSelector: safeJsonStringify(raw.bookDescriptionSelector, 'bookDescriptionSelector'),
        bookCoverSelector: safeJsonStringify(raw.bookCoverSelector, 'bookCoverSelector'),
        bookStatusSelector: safeJsonStringify(raw.bookStatusSelector, 'bookStatusSelector'),

        chapterListUrl: sanitizeField(raw.chapterListUrl, 2000) || null,
        chapterListSelector: safeJsonStringify(raw.chapterListSelector, 'chapterListSelector'),
        chapterTitleSelector: safeJsonStringify(raw.chapterTitleSelector, 'chapterTitleSelector'),
        chapterLinkSelector: safeJsonStringify(raw.chapterLinkSelector, 'chapterLinkSelector'),
        chapterPagination: safeJsonStringify(raw.chapterPagination, 'chapterPagination'),

        contentTitleSelector: safeJsonStringify(raw.contentTitleSelector, 'contentTitleSelector'),
        contentSelector: safeJsonStringify(raw.contentSelector, 'contentSelector'),
        contentPagination: safeJsonStringify(raw.contentPagination, 'contentPagination'),

        antiCrawlConfig: safeJsonStringify(raw.antiCrawlConfig, 'antiCrawlConfig'),

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

        cleanConfig: (() => {
          try { return validateCleanConfig(raw.cleanConfig); }
          catch { return safeJsonStringify(raw.cleanConfig, 'cleanConfig'); }
        })(),
        agentqlConfig: safeJsonStringify(raw.agentqlConfig, 'agentqlConfig'),
        cloudBrowserConfig: buildCloudBrowserConfig(raw.cloudBrowserUrl, raw.cloudBrowserProvider),
      };

      // Use upsert to avoid TOCTOU race condition
      try {
        const rule = await db.scrapeRule.upsert({
          where: { name },
          update: data,
          create: data,
        });
        const isCreated = rule.createdAt.getTime() === rule.updatedAt.getTime();
        if (isCreated) {
          created++;
          results.push({ id: rule.id, name, action: 'created' });
        } else {
          updated++;
          results.push({ id: rule.id, name, action: 'updated' });
        }
      } catch (err) {
        // Prisma unique constraint error
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
          skipped++;
          results.push({ name, action: 'skipped', errors: ['规则名称已存在（并发冲突）'] });
        } else {
          throw err;
        }
      }
    }

    return apiSuccess({ results, created, updated, skipped, total: results.length });
  } catch (error) {
    console.error('Import scrape rules error:', error);
    return apiError('导入采集规则失败');
  }
});
