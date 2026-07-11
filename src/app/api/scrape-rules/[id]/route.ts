import { db } from "@/lib/db";
import { safeJson } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const VALID_SCRAPE_MODES = ["incremental", "full"];
const VALID_ENGINES = ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser"];
const VALID_STORAGE_MODES = ["database", "file"];
const VALID_DEDUP_MODES = ["url", "title", "both"];
const MAX_THREAD = 20;
const MIN_THREAD = 1;
const MAX_DELAY = 60000;

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

    const rule = await db.scrapeRule.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.description !== undefined && { description: body.description?.trim() || null }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),

        // 列表页配置
        ...(body.listUrl !== undefined && { listUrl: body.listUrl || null }),
        ...(body.listSelector !== undefined && {
          listSelector: body.listSelector ? JSON.stringify(body.listSelector) : null,
        }),
        ...(body.listPagination !== undefined && {
          listPagination: body.listPagination ? JSON.stringify(body.listPagination) : null,
        }),

        // 书籍信息页配置
        ...(body.bookTitleSelector !== undefined && { bookTitleSelector: body.bookTitleSelector || null }),
        ...(body.bookAuthorSelector !== undefined && { bookAuthorSelector: body.bookAuthorSelector || null }),
        ...(body.bookCategorySelector !== undefined && { bookCategorySelector: body.bookCategorySelector || null }),
        ...(body.bookKeywordsSelector !== undefined && { bookKeywordsSelector: body.bookKeywordsSelector || null }),
        ...(body.bookDescriptionSelector !== undefined && { bookDescriptionSelector: body.bookDescriptionSelector || null }),
        ...(body.bookCoverSelector !== undefined && { bookCoverSelector: body.bookCoverSelector || null }),
        ...(body.bookStatusSelector !== undefined && { bookStatusSelector: body.bookStatusSelector || null }),

        // 章节目录页配置
        ...(body.chapterListUrl !== undefined && { chapterListUrl: body.chapterListUrl || null }),
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
        ...(body.filePath !== undefined && { filePath: body.filePath || null }),
        ...(body.coverSavePath !== undefined && { coverSavePath: body.coverSavePath || null }),

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
  } catch (error) {
    console.error("Update scrape rule error:", error);
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