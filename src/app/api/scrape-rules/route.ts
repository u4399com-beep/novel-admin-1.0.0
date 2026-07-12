import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { parsePagination, sanitizeField, safeJson } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import { isSafeUrl } from "@/lib/sanitize";

const VALID_SELECTOR_TYPES = ["css", "xpath", "regex"] as const;
const VALID_PAGINATION_TYPES = ["next", "page"] as const;
const MAX_SELECTOR_VALUE_LENGTH = 500;
const MAX_PAGINATION_SELECTOR_LENGTH = 500;
const MAX_PAGINATION_MAX_PAGE = 10000;

type SelectorField = "listSelector" | "chapterListSelector" | "chapterTitleSelector" | "chapterLinkSelector" | "contentTitleSelector" | "contentSelector";
type PaginationField = "listPagination" | "chapterPagination" | "contentPagination";

function validateSelector(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value) || value === null) {
    return `${fieldName}格式错误，必须是包含type和value的对象`;
  }
  const obj = value as Record<string, unknown>;
  if (!VALID_SELECTOR_TYPES.includes(obj.type as typeof VALID_SELECTOR_TYPES[number])) {
    return `${fieldName}的type必须是: ${VALID_SELECTOR_TYPES.join(", ")}`;
  }
  if (typeof obj.value !== "string") {
    return `${fieldName}的value必须是字符串`;
  }
  if (obj.value.length > MAX_SELECTOR_VALUE_LENGTH) {
    return `${fieldName}的value不能超过${MAX_SELECTOR_VALUE_LENGTH}个字符`;
  }
  return null;
}

/** Validate save path: must start with /app/public/ and contain no path traversal */
function validateSavePath(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const val = sanitizeField(value, 500);
  if (val && (!val.startsWith('/app/public/') || val.includes('..'))) return null;
  return val;
}

function validatePagination(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value) || value === null) {
    return `${fieldName}格式错误，必须是包含type和selector的对象`;
  }
  const obj = value as Record<string, unknown>;
  if (!VALID_PAGINATION_TYPES.includes(obj.type as typeof VALID_PAGINATION_TYPES[number])) {
    return `${fieldName}的type必须是: ${VALID_PAGINATION_TYPES.join(", ")}`;
  }
  if (typeof obj.selector !== "string") {
    return `${fieldName}的selector必须是字符串`;
  }
  if (obj.selector.length > MAX_PAGINATION_SELECTOR_LENGTH) {
    return `${fieldName}的selector不能超过${MAX_PAGINATION_SELECTOR_LENGTH}个字符`;
  }
  if (obj.maxPage !== undefined) {
    const maxPage = Number(obj.maxPage);
    if (!Number.isFinite(maxPage) || maxPage < 1 || maxPage > MAX_PAGINATION_MAX_PAGE) {
      return `${fieldName}的maxPage必须在1-${MAX_PAGINATION_MAX_PAGE}之间`;
    }
  }
  return null;
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

    // Validate selector fields
    const selectorFields: Array<{ key: string; name: string }> = [
      { key: "listSelector", name: "列表选择器" },
      { key: "chapterListSelector", name: "章节列表选择器" },
      { key: "chapterTitleSelector", name: "章节标题选择器" },
      { key: "chapterLinkSelector", name: "章节链接选择器" },
      { key: "contentTitleSelector", name: "内容标题选择器" },
      { key: "contentSelector", name: "内容选择器" },
    ];
    for (const { key, name } of selectorFields) {
      const err = validateSelector(body[key], name);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }

    // Validate pagination fields
    const paginationFields: Array<{ key: string; name: string }> = [
      { key: "listPagination", name: "列表分页" },
      { key: "chapterPagination", name: "章节分页" },
      { key: "contentPagination", name: "内容分页" },
    ];
    for (const { key, name } of paginationFields) {
      const err = validatePagination(body[key], name);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
    }

    // Validate cloudBrowserUrl for SSRF before DB write
    if (body.cloudBrowserUrl && !isSafeUrl(String(body.cloudBrowserUrl))) {
      return NextResponse.json({ error: 'Cloud Browser URL 不允许访问内网或私有地址' }, { status: 400 });
    }

    const rule = await db.scrapeRule.create({
      data: {
        name,
        description: sanitizeField(body.description, 2000) || null,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,

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
        filePath: validateSavePath(body.filePath),
        coverSavePath: validateSavePath(body.coverSavePath),

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

        // AgentQL config — validate and stringify for String? DB field
        agentqlConfig: body.agentqlQueries
          ? JSON.stringify(
              typeof body.agentqlQueries === 'object' && body.agentqlQueries !== null
                ? body.agentqlQueries
                : {},
              (key, value) => typeof value === 'string' ? value.slice(0, 2000) : value
            )
          : null,
        // CloudBrowser config — validate URL and stringify
        cloudBrowserConfig: body.cloudBrowserUrl
          ? (() => {
              // Validate cloudBrowserUrl is a safe HTTP(S) URL
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