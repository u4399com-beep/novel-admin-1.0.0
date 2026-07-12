import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, safeJson } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import {
  validateAllSelectors,
  validateAllPaginations,
  validateUrlField,
  validateSavePath,
  parseScrapeParams,
  ValidationError,
} from "@/lib/scrape-rule-validation";
import { sanitizeField } from "@/lib/api-utils";

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
    return NextResponse.json({ error: "获取采集规则列表失败" }, { status: 500 });
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

    const params = parseScrapeParams(body);

    const rule = await db.scrapeRule.create({
      data: {
        name,
        description: sanitizeField(body.description, 2000) || null,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,

        listUrl: sanitizeField(body.listUrl, 2000) || null,
        listSelector: body.listSelector ? JSON.stringify(body.listSelector) : null,
        listPagination: body.listPagination ? JSON.stringify(body.listPagination) : null,

        bookTitleSelector: sanitizeField(body.bookTitleSelector, 500) || null,
        bookAuthorSelector: sanitizeField(body.bookAuthorSelector, 500) || null,
        bookCategorySelector: sanitizeField(body.bookCategorySelector, 500) || null,
        bookKeywordsSelector: sanitizeField(body.bookKeywordsSelector, 500) || null,
        bookDescriptionSelector: sanitizeField(body.bookDescriptionSelector, 500) || null,
        bookCoverSelector: sanitizeField(body.bookCoverSelector, 500) || null,
        bookStatusSelector: sanitizeField(body.bookStatusSelector, 500) || null,

        chapterListUrl: sanitizeField(body.chapterListUrl, 2000) || null,
        chapterListSelector: body.chapterListSelector ? JSON.stringify(body.chapterListSelector) : null,
        chapterTitleSelector: body.chapterTitleSelector ? JSON.stringify(body.chapterTitleSelector) : null,
        chapterLinkSelector: body.chapterLinkSelector ? JSON.stringify(body.chapterLinkSelector) : null,
        chapterPagination: body.chapterPagination ? JSON.stringify(body.chapterPagination) : null,

        contentTitleSelector: body.contentTitleSelector ? JSON.stringify(body.contentTitleSelector) : null,
        contentSelector: body.contentSelector ? JSON.stringify(body.contentSelector) : null,
        contentPagination: body.contentPagination ? JSON.stringify(body.contentPagination) : null,

        antiCrawlConfig: body.antiCrawlConfig ? JSON.stringify(body.antiCrawlConfig) : null,

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

        cleanConfig: body.cleanConfig ? JSON.stringify(body.cleanConfig) : null,

        agentqlConfig: body.agentqlQueries
          ? JSON.stringify(
              typeof body.agentqlQueries === 'object' && body.agentqlQueries !== null
                ? body.agentqlQueries
                : {},
              (key, value) => typeof value === 'string' ? value.slice(0, 2000) : value
            )
          : null,
        cloudBrowserConfig: body.cloudBrowserUrl
          ? (() => {
              try {
                const parsed = new URL(body.cloudBrowserUrl);
                if (!['http:', 'https:'].includes(parsed.protocol)) return null;
              } catch { return null; }
              return JSON.stringify({
                provider: ['browserless', 'steel'].includes(body.cloudBrowserProvider) ? body.cloudBrowserProvider : 'browserless',
                apiUrl: String(body.cloudBrowserUrl).slice(0, 500),
              });
            })()
          : null,
      },
      include: { _count: { select: { tasks: true } } },
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    console.error("Create scrape rule error:", error);
    return NextResponse.json({ error: "创建采集规则失败" }, { status: 500 });
  }
});