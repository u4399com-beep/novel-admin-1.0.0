import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, safeJson, sanitizeField } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
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

function safeJsonStringify(value: unknown, fieldName: string, maxSize = 50000): string | null {
  if (value == null) return null;
  const str = JSON.stringify(value);
  if (str && str.length > maxSize) {
    throw new Error(`${fieldName}配置过大（最大${Math.floor(maxSize / 1024)}KB）`);
  }
  return str;
}
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
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { tasks: true } } },
      }),
      db.scrapeRule.count({ where }),
    ]);

    return NextResponse.json({
      rules,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("List scrape rules error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "获取采集规则列表失败", detail: msg }, { status: 500 });
  }
});

// POST /api/scrape-rules - Create a new scrape rule
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }

    const name = sanitizeField(body.name, 200);
    if (!name) {
      return NextResponse.json({ error: "规则名称不能为空" }, { status: 400 });
    }

    // Validate selectors and pagination
    const selErr = validateAllSelectors(body);
    if (selErr) return NextResponse.json({ error: selErr }, { status: 400 });
    const pagErr = validateAllPaginations(body);
    if (pagErr) return NextResponse.json({ error: pagErr }, { status: 400 });

    // Validate URL fields for SSRF
    try {
      if (body.listUrl) validateUrlField(body.listUrl, 'listUrl');
      if (body.chapterListUrl) validateUrlField(body.chapterListUrl, 'chapterListUrl');
      if (body.cloudBrowserUrl) validateUrlField(body.cloudBrowserUrl, 'Cloud Browser URL');
    } catch (e) {
      if (e instanceof ValidationError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    // Validate enum fields — reject invalid values instead of silently defaulting
    if (body.scrapeMode !== undefined && !VALID_SCRAPE_MODES.includes(body.scrapeMode)) {
      return NextResponse.json({ error: `采集模式只能是: ${VALID_SCRAPE_MODES.join(', ')}` }, { status: 400 });
    }
    if (body.engine !== undefined && !VALID_ENGINES.includes(body.engine)) {
      return NextResponse.json({ error: `采集引擎只能是: ${VALID_ENGINES.join(', ')}` }, { status: 400 });
    }
    if (body.storageMode !== undefined && !VALID_STORAGE_MODES.includes(body.storageMode)) {
      return NextResponse.json({ error: `存储模式只能是: ${VALID_STORAGE_MODES.join(', ')}` }, { status: 400 });
    }
    if (body.dedupMode !== undefined && !VALID_DEDUP_MODES.includes(body.dedupMode)) {
      return NextResponse.json({ error: `去重模式只能是: ${VALID_DEDUP_MODES.join(', ')}` }, { status: 400 });
    }

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: "enabled 必须是布尔值" }, { status: 400 });
    }
    if (body.enableShuffle !== undefined && typeof body.enableShuffle !== 'boolean') {
      return NextResponse.json({ error: "enableShuffle 必须是布尔值" }, { status: 400 });
    }

    const params = parseScrapeParams(body);

    const rule = await db.scrapeRule.create({
      data: {
        name,
        description: sanitizeField(body.description, 2000) || null,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,

        listUrl: sanitizeField(body.listUrl, 2000) || null,
        listSelector: safeJsonStringify(body.listSelector, 'listSelector'),
        listPagination: safeJsonStringify(body.listPagination, 'listPagination'),

        bookTitleSelector: sanitizeField(body.bookTitleSelector, 500) || null,
        bookAuthorSelector: sanitizeField(body.bookAuthorSelector, 500) || null,
        bookCategorySelector: sanitizeField(body.bookCategorySelector, 500) || null,
        bookKeywordsSelector: sanitizeField(body.bookKeywordsSelector, 500) || null,
        bookDescriptionSelector: sanitizeField(body.bookDescriptionSelector, 500) || null,
        bookCoverSelector: sanitizeField(body.bookCoverSelector, 500) || null,
        bookStatusSelector: sanitizeField(body.bookStatusSelector, 500) || null,

        chapterListUrl: sanitizeField(body.chapterListUrl, 2000) || null,
        chapterListSelector: safeJsonStringify(body.chapterListSelector, 'chapterListSelector'),
        chapterTitleSelector: safeJsonStringify(body.chapterTitleSelector, 'chapterTitleSelector'),
        chapterLinkSelector: safeJsonStringify(body.chapterLinkSelector, 'chapterLinkSelector'),
        chapterPagination: safeJsonStringify(body.chapterPagination, 'chapterPagination'),

        contentTitleSelector: safeJsonStringify(body.contentTitleSelector, 'contentTitleSelector'),
        contentSelector: safeJsonStringify(body.contentSelector, 'contentSelector'),
        contentPagination: safeJsonStringify(body.contentPagination, 'contentPagination'),

        antiCrawlConfig: safeJsonStringify(body.antiCrawlConfig, 'antiCrawlConfig'),

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

        cleanConfig: safeJsonStringify(body.cleanConfig, 'cleanConfig'),

        agentqlConfig: safeJsonStringify(
              typeof body.agentqlQueries === 'object' && body.agentqlQueries !== null
                ? body.agentqlQueries
                : null,
              'agentqlConfig'
            ),
        cloudBrowserConfig: buildCloudBrowserConfig(body.cloudBrowserUrl, body.cloudBrowserProvider),
      },
      include: { _count: { select: { tasks: true } } },
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    console.error("Create scrape rule error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "创建采集规则失败", detail: msg }, { status: 500 });
  }
});