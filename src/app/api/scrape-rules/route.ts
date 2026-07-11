import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, sanitizeField, safeJson } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";

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
        include: {
          _count: { select: { tasks: true } },
        },
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

    const validScrapeModes = ["incremental", "full"];
    const validEngines = ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser"];
    const validStorageModes = ["database", "file"];
    const validDedupModes = ["url", "title", "both"];

    const scrapeMode = validScrapeModes.includes(body.scrapeMode) ? body.scrapeMode : "incremental";
    const engine = validEngines.includes(body.engine) ? body.engine : "cheerio";
    const storageMode = validStorageModes.includes(body.storageMode) ? body.storageMode : "database";
    const dedupMode = validDedupModes.includes(body.dedupMode) ? body.dedupMode : "url";
    const threadCount = Math.min(Math.max(1, Number(body.threadCount) || 3), 20);
    const minDelay = Math.max(0, Number(body.minDelay) || 1000);
    const maxDelay = Math.max(minDelay, Number(body.maxDelay) || 3000);

    const rule = await db.scrapeRule.create({
      data: {
        name,
        description: sanitizeField(body.description, 2000) || null,
        enabled: body.enabled ?? true,

        // 列表页配置
        listUrl: sanitizeField(body.listUrl, 2000) || null,
        listSelector: body.listSelector ? JSON.stringify(body.listSelector) : null,
        listPagination: body.listPagination ? JSON.stringify(body.listPagination) : null,

        // 书籍信息页配置
        bookTitleSelector: sanitizeField(body.bookTitleSelector, 500) || null,
        bookAuthorSelector: sanitizeField(body.bookAuthorSelector, 500) || null,
        bookCategorySelector: sanitizeField(body.bookCategorySelector, 500) || null,
        bookKeywordsSelector: sanitizeField(body.bookKeywordsSelector, 500) || null,
        bookDescriptionSelector: sanitizeField(body.bookDescriptionSelector, 500) || null,
        bookCoverSelector: sanitizeField(body.bookCoverSelector, 500) || null,
        bookStatusSelector: sanitizeField(body.bookStatusSelector, 500) || null,

        // 章节目录页配置
        chapterListUrl: sanitizeField(body.chapterListUrl, 2000) || null,
        chapterListSelector: body.chapterListSelector ? JSON.stringify(body.chapterListSelector) : null,
        chapterTitleSelector: body.chapterTitleSelector ? JSON.stringify(body.chapterTitleSelector) : null,
        chapterLinkSelector: body.chapterLinkSelector ? JSON.stringify(body.chapterLinkSelector) : null,
        chapterPagination: body.chapterPagination ? JSON.stringify(body.chapterPagination) : null,

        // 章节内容页配置
        contentTitleSelector: body.contentTitleSelector ? JSON.stringify(body.contentTitleSelector) : null,
        contentSelector: body.contentSelector ? JSON.stringify(body.contentSelector) : null,
        contentPagination: body.contentPagination ? JSON.stringify(body.contentPagination) : null,

        // 反爬策略
        antiCrawlConfig: body.antiCrawlConfig ? JSON.stringify(body.antiCrawlConfig) : null,

        // 存储配置
        storageMode,
        filePath: sanitizeField(body.filePath, 2000) || null,
        coverSavePath: sanitizeField(body.coverSavePath, 2000) || null,

        // 采集策略
        scrapeMode,
        engine,
        threadCount,
        minDelay,
        maxDelay,
        enableShuffle: body.enableShuffle ?? false,
        dedupMode,

        // 内容清洗
        cleanConfig: body.cleanConfig ? JSON.stringify(body.cleanConfig) : null,

        // AgentQL & CloudBrowser config
        agentqlConfig: body.agentqlQueries ? body.agentqlQueries : null,
        cloudBrowserConfig: body.cloudBrowserUrl ? JSON.stringify({
          provider: body.cloudBrowserProvider || "browserless",
          apiUrl: body.cloudBrowserUrl,
        }) : null,
      },
      include: {
        _count: { select: { tasks: true } },
      },
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    console.error("Create scrape rule error:", error);
    return NextResponse.json({ error: "创建采集规则失败" }, { status: 500 });
  }
});