import { db } from "@/lib/db";
import { safeJson, sanitizeField } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const VALID_SCRAPE_MODES = ["incremental", "full"];
const VALID_ENGINES = ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser"];
const VALID_STORAGE_MODES = ["database", "file"];
const VALID_DEDUP_MODES = ["url", "title", "both"];
const MAX_THREAD = 20;
const MIN_THREAD = 1;
const MAX_DELAY = 60000;
const VALID_SELECTOR_TYPES = ["css", "xpath", "regex"] as const;
const VALID_PAGINATION_TYPES = ["next", "page"] as const;
const MAX_SELECTOR_VALUE_LENGTH = 500;
const MAX_PAGINATION_SELECTOR_LENGTH = 500;
const MAX_PAGINATION_MAX_PAGE = 10000;

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

// GET /api/scrape-rules/[id] - Get a single scrape rule
export const GET = withAuth(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const rule = await db.scrapeRule.findUnique({
      where: { id },
      include: {
        _count: { select: { tasks: true } },
      },
    });

    if (!rule) {
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }

    return NextResponse.json(rule);
  } catch (error) {
    console.error("Get scrape rule error:", error);
    return NextResponse.json({ error: "获取采集规则详情失败" }, { status: 500 });
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
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }

    if (body.name !== undefined && !body.name?.trim()) {
      return NextResponse.json({ error: "规则名称不能为空" }, { status: 400 });
    }

    // Validate enums and ranges
    if (body.scrapeMode !== undefined && !VALID_SCRAPE_MODES.includes(body.scrapeMode)) {
      return NextResponse.json({ error: `采集模式只能是: ${VALID_SCRAPE_MODES.join(", ")}` }, { status: 400 });
    }
    if (body.engine !== undefined && !VALID_ENGINES.includes(body.engine)) {
      return NextResponse.json({ error: `采集引擎只能是: ${VALID_ENGINES.join(", ")}` }, { status: 400 });
    }
    if (body.storageMode !== undefined && !VALID_STORAGE_MODES.includes(body.storageMode)) {
      return NextResponse.json({ error: `存储模式只能是: ${VALID_STORAGE_MODES.join(", ")}` }, { status: 400 });
    }
    if (body.dedupMode !== undefined && !VALID_DEDUP_MODES.includes(body.dedupMode)) {
      return NextResponse.json({ error: `去重模式只能是: ${VALID_DEDUP_MODES.join(", ")}` }, { status: 400 });
    }
    if (body.threadCount !== undefined) {
      const tc = Math.floor(Number(body.threadCount) || 3);
      if (tc < MIN_THREAD || tc > MAX_THREAD) {
        return NextResponse.json({ error: `线程数必须在${MIN_THREAD}-${MAX_THREAD}之间` }, { status: 400 });
      }
    }
    if (body.minDelay !== undefined) {
      const md = Math.floor(Number(body.minDelay) || 1000);
      if (md < 0 || md > MAX_DELAY) {
        return NextResponse.json({ error: `最小延迟必须在0-${MAX_DELAY}ms之间` }, { status: 400 });
      }
    }
    if (body.maxDelay !== undefined) {
      const mx = Math.floor(Number(body.maxDelay) || 3000);
      if (mx < 0 || mx > MAX_DELAY) {
        return NextResponse.json({ error: `最大延迟必须在0-${MAX_DELAY}ms之间` }, { status: 400 });
      }
    }

    // Ensure maxDelay >= minDelay if both provided
    const minD = body.minDelay !== undefined ? Math.max(0, Math.floor(Number(body.minDelay) || 1000)) : undefined;
    const maxD = body.maxDelay !== undefined ? Math.max(0, Math.floor(Number(body.maxDelay) || 3000)) : undefined;
    if (minD !== undefined && maxD !== undefined && maxD < minD) {
      return NextResponse.json({ error: "最大延迟不能小于最小延迟" }, { status: 400 });
    }

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
      if (body[key] !== undefined) {
        const err = validateSelector(body[key], name);
        if (err) return NextResponse.json({ error: err }, { status: 400 });
      }
    }

    // Validate pagination fields
    const paginationFields: Array<{ key: string; name: string }> = [
      { key: "listPagination", name: "列表分页" },
      { key: "chapterPagination", name: "章节分页" },
      { key: "contentPagination", name: "内容分页" },
    ];
    for (const { key, name } of paginationFields) {
      if (body[key] !== undefined) {
        const err = validatePagination(body[key], name);
        if (err) return NextResponse.json({ error: err }, { status: 400 });
      }
    }

    const rule = await db.scrapeRule.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: sanitizeField(body.name, 200) }),
        ...(body.description !== undefined && { description: sanitizeField(body.description, 2000) || null }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),

        // 列表页配置
        ...(body.listUrl !== undefined && { listUrl: sanitizeField(body.listUrl, 2000) || null }),
        ...(body.listSelector !== undefined && {
          listSelector: body.listSelector ? JSON.stringify(body.listSelector) : null,
        }),
        ...(body.listPagination !== undefined && {
          listPagination: body.listPagination ? JSON.stringify(body.listPagination) : null,
        }),

        // 书籍信息页配置
        ...(body.bookTitleSelector !== undefined && { bookTitleSelector: sanitizeField(body.bookTitleSelector, 500) || null }),
        ...(body.bookAuthorSelector !== undefined && { bookAuthorSelector: sanitizeField(body.bookAuthorSelector, 500) || null }),
        ...(body.bookCategorySelector !== undefined && { bookCategorySelector: sanitizeField(body.bookCategorySelector, 500) || null }),
        ...(body.bookKeywordsSelector !== undefined && { bookKeywordsSelector: sanitizeField(body.bookKeywordsSelector, 500) || null }),
        ...(body.bookDescriptionSelector !== undefined && { bookDescriptionSelector: sanitizeField(body.bookDescriptionSelector, 500) || null }),
        ...(body.bookCoverSelector !== undefined && { bookCoverSelector: sanitizeField(body.bookCoverSelector, 500) || null }),
        ...(body.bookStatusSelector !== undefined && { bookStatusSelector: sanitizeField(body.bookStatusSelector, 500) || null }),

        // 章节目录页配置
        ...(body.chapterListUrl !== undefined && { chapterListUrl: sanitizeField(body.chapterListUrl, 2000) || null }),
        ...(body.chapterListSelector !== undefined && {
          chapterListSelector: body.chapterListSelector ? JSON.stringify(body.chapterListSelector) : null,
        }),
        ...(body.chapterTitleSelector !== undefined && {
          chapterTitleSelector: body.chapterTitleSelector ? JSON.stringify(body.chapterTitleSelector) : null,
        }),
        ...(body.chapterLinkSelector !== undefined && {
          chapterLinkSelector: body.chapterLinkSelector ? JSON.stringify(body.chapterLinkSelector) : null,
        }),
        ...(body.chapterPagination !== undefined && {
          chapterPagination: body.chapterPagination ? JSON.stringify(body.chapterPagination) : null,
        }),

        // 章节内容页配置
        ...(body.contentTitleSelector !== undefined && {
          contentTitleSelector: body.contentTitleSelector ? JSON.stringify(body.contentTitleSelector) : null,
        }),
        ...(body.contentSelector !== undefined && {
          contentSelector: body.contentSelector ? JSON.stringify(body.contentSelector) : null,
        }),
        ...(body.contentPagination !== undefined && {
          contentPagination: body.contentPagination ? JSON.stringify(body.contentPagination) : null,
        }),

        // 反爬策略
        ...(body.antiCrawlConfig !== undefined && {
          antiCrawlConfig: body.antiCrawlConfig ? JSON.stringify(body.antiCrawlConfig) : null,
        }),

        // 存储配置
        ...(body.storageMode !== undefined && { storageMode: body.storageMode }),
        ...(body.filePath !== undefined && {
          filePath: (() => {
            const val = sanitizeField(body.filePath, 500);
            if (val && (!val.startsWith('/app/public/') || val.includes('..'))) return null;
            return val || null;
          })(),
        }),
        ...(body.coverSavePath !== undefined && {
          coverSavePath: (() => {
            const val = sanitizeField(body.coverSavePath, 500);
            if (val && (!val.startsWith('/app/public/') || val.includes('..'))) return null;
            return val || null;
          })(),
        }),

        // 采集策略
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

        // 内容清洗
        ...(body.cleanConfig !== undefined && {
          cleanConfig: body.cleanConfig ? JSON.stringify(body.cleanConfig) : null,
        }),
      },
      include: {
        _count: { select: { tasks: true } },
      },
    });

    return NextResponse.json(rule);
  } catch (error: unknown) {
    console.error("Update scrape rule error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2025") {
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "更新采集规则失败" }, { status: 500 });
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
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }
    await db.scrapeRule.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error("Delete scrape rule error:", error);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2025") {
      return NextResponse.json({ error: "采集规则不存在" }, { status: 404 });
    }
    return NextResponse.json({ error: "删除采集规则失败" }, { status: 500 });
  }
});