import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, safeJson, sanitizeField, safeJsonStringify, apiError, apiSuccess } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import { requireFields } from "@/lib/crud-helpers";
import {
  validateAllSelectors,
  validateAllPaginations,
  validateUrlField,
  validateSavePath,
  parseScrapeParams,
  ValidationError,
  VALID_SCRAPE_MODES,
  VALID_ENGINES,
  VALID_STORAGE_MODES,
  VALID_DEDUP_MODES,
  buildCloudBrowserConfig,
} from "@/lib/scrape-rule-validation";


// GET /api/scrape-rules - List all scrape rules with pagination and search
export const GET = withAuth(async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { page, pageSize, skip } = parsePagination(searchParams);
    const search = sanitizeField(searchParams.get("search"), 200);

    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { description: { contains: search } },
      ];
    }

    const [rules, total] = await Promise.all([
      db.scrapeRule.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { updatedAt: 'desc' },
        include: {
          _count: { select: { tasks: true } },
          tasks: {
            select: { startedAt: true },
            take: 1,
            orderBy: { startedAt: 'desc' },
          },
        },
      }),
      db.scrapeRule.count({ where }),
    ]);

    // Extract lastRunAt from the latest task and remove tasks array
    const rulesWithLastRun = rules.map((rule) => {
      const { tasks, ...rest } = rule;
      return {
        ...rest,
        lastRunAt: tasks[0]?.startedAt?.toISOString() ?? null,
      };
    });

    return NextResponse.json({
      rules: rulesWithLastRun,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("List scrape rules error:", error);
    return apiError("获取采集规则列表失败");
  }
});

// POST /api/scrape-rules - Create a new scrape rule
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return apiError("请求数据格式错误", 400);
    }

    const check = requireFields(body, ['name']);
    if (!check.valid) return check.response;

    const name = sanitizeField(body.name, 200);

    // Validate selectors, pagination, and content pagination
    const selErr = validateAllSelectors(body);
    if (selErr) return apiError(selErr, 400);
    const pagErr = validateAllPaginations(body);
    if (pagErr) return apiError(pagErr, 400);

    // Validate contentPagination with stricter maxPage limit
    try {
      const contentPagErr = validateContentPagination(body.contentPagination);
      if (contentPagErr) return apiError(contentPagErr, 400);
    } catch (e) {
      if (e instanceof ValidationError) {
        return apiError(e.message, 400);
      }
      throw e;
    }

    // Validate cleanConfig
    let validatedCleanConfig: string | null = null;
    try {
      validatedCleanConfig = validateCleanConfig(body.cleanConfig);
    } catch (e) {
      if (e instanceof ValidationError) {
        return apiError(e.message, 400);
      }
      throw e;
    }

    // Validate URL fields for SSRF
    try {
      if (body.listUrl) validateUrlField(body.listUrl, 'listUrl');
      if (body.chapterListUrl) validateUrlField(body.chapterListUrl, 'chapterListUrl');
      if (body.cloudBrowserUrl) validateUrlField(body.cloudBrowserUrl, 'Cloud Browser URL');
    } catch (e) {
      if (e instanceof ValidationError) {
        return apiError(e.message, 400);
      }
      throw e;
    }

    // Validate enum fields — reject invalid values instead of silently defaulting
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

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return apiError("enabled 必须是布尔值", 400);
    }
    if (body.enableShuffle !== undefined && typeof body.enableShuffle !== 'boolean') {
      return apiError("enableShuffle 必须是布尔值", 400);
    }

    const params = parseScrapeParams(body);

    // Build JSON fields — capture validation errors separately
    let jsonFields: Record<string, string | null>;
    try {
      jsonFields = {
        listSelector: safeJsonStringify(body.listSelector, 'listSelector'),
        listPagination: safeJsonStringify(body.listPagination, 'listPagination'),
        // Book info selectors (JSON serialized, same as other selectors)
        bookTitleSelector: safeJsonStringify(body.bookTitleSelector, 'bookTitleSelector'),
        bookAuthorSelector: safeJsonStringify(body.bookAuthorSelector, 'bookAuthorSelector'),
        bookCategorySelector: safeJsonStringify(body.bookCategorySelector, 'bookCategorySelector'),
        bookKeywordsSelector: safeJsonStringify(body.bookKeywordsSelector, 'bookKeywordsSelector'),
        bookDescriptionSelector: safeJsonStringify(body.bookDescriptionSelector, 'bookDescriptionSelector'),
        bookCoverSelector: safeJsonStringify(body.bookCoverSelector, 'bookCoverSelector'),
        bookStatusSelector: safeJsonStringify(body.bookStatusSelector, 'bookStatusSelector'),
        // Chapter selectors
        chapterListSelector: safeJsonStringify(body.chapterListSelector, 'chapterListSelector'),
        chapterTitleSelector: safeJsonStringify(body.chapterTitleSelector, 'chapterTitleSelector'),
        chapterLinkSelector: safeJsonStringify(body.chapterLinkSelector, 'chapterLinkSelector'),
        chapterPagination: safeJsonStringify(body.chapterPagination, 'chapterPagination'),
        // Content selectors
        contentTitleSelector: safeJsonStringify(body.contentTitleSelector, 'contentTitleSelector'),
        contentSelector: safeJsonStringify(body.contentSelector, 'contentSelector'),
        contentPagination: safeJsonStringify(body.contentPagination, 'contentPagination'),
        // Configs
        antiCrawlConfig: safeJsonStringify(body.antiCrawlConfig, 'antiCrawlConfig'),
        // cleanConfig is already validated and normalized above
        cleanConfig: validatedCleanConfig ?? safeJsonStringify(body.cleanConfig, 'cleanConfig'),
        agentqlConfig: safeJsonStringify(
          typeof body.agentqlQueries === 'object' && body.agentqlQueries !== null
            ? body.agentqlQueries
            : null,
          'agentqlConfig'
        ),
      };
    } catch (e) {
      if (e instanceof Error) {
        return apiError(e.message, 400);
      }
      throw e;
    }

    const rule = await db.scrapeRule.create({
      data: {
        name,
        description: sanitizeField(body.description, 2000) || null,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,

        listUrl: sanitizeField(body.listUrl, 2000) || null,
        listSelector: jsonFields.listSelector,
        listPagination: jsonFields.listPagination,

        bookTitleSelector: jsonFields.bookTitleSelector,
        bookAuthorSelector: jsonFields.bookAuthorSelector,
        bookCategorySelector: jsonFields.bookCategorySelector,
        bookKeywordsSelector: jsonFields.bookKeywordsSelector,
        bookDescriptionSelector: jsonFields.bookDescriptionSelector,
        bookCoverSelector: jsonFields.bookCoverSelector,
        bookStatusSelector: jsonFields.bookStatusSelector,

        chapterListUrl: sanitizeField(body.chapterListUrl, 2000) || null,
        chapterListSelector: jsonFields.chapterListSelector,
        chapterTitleSelector: jsonFields.chapterTitleSelector,
        chapterLinkSelector: jsonFields.chapterLinkSelector,
        chapterPagination: jsonFields.chapterPagination,

        contentTitleSelector: jsonFields.contentTitleSelector,
        contentSelector: jsonFields.contentSelector,
        contentPagination: jsonFields.contentPagination,

        antiCrawlConfig: jsonFields.antiCrawlConfig,

        storageMode: params.storageMode,
        filePath: validateSavePath(body.filePath),
        coverSavePath: validateSavePath(body.coverSavePath),

        scrapeMode: params.scrapeMode,
        engine: params.engine,
        threadCount: params.threadCount,
        minDelay: params.minDelay,
        maxDelay: params.maxDelay,
        enableShuffle: body.enableShuffle ?? false,
        dedupMode: params.dedupMode,

        cleanConfig: jsonFields.cleanConfig,
        agentqlConfig: jsonFields.agentqlConfig,
        cloudBrowserConfig: buildCloudBrowserConfig(body.cloudBrowserUrl, body.cloudBrowserProvider),
      },
      include: { _count: { select: { tasks: true } } },
    });

    return apiSuccess(rule, 201);
  } catch (error) {
    console.error("Create scrape rule error:", error);
    return apiError("创建采集规则失败", 500);
  }
});