import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/scrape-rules/[id] - Get a single scrape rule
export async function GET(
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
}

// PUT /api/scrape-rules/[id] - Update a scrape rule
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (body.name !== undefined && !body.name?.trim()) {
      return NextResponse.json({ error: "规则名称不能为空" }, { status: 400 });
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
        ...(body.threadCount !== undefined && { threadCount: body.threadCount }),
        ...(body.minDelay !== undefined && { minDelay: body.minDelay }),
        ...(body.maxDelay !== undefined && { maxDelay: body.maxDelay }),
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
}

// DELETE /api/scrape-rules/[id] - Delete a scrape rule
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.scrapeRule.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete scrape rule error:", error);
    return NextResponse.json({ error: "删除采集规则失败" }, { status: 500 });
  }
}