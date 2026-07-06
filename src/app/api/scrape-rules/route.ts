import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

// GET /api/scrape-rules - List all scrape rules with pagination and search
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1");
    const pageSize = parseInt(searchParams.get("pageSize") || "20");
    const search = searchParams.get("search") || "";

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
        skip: (page - 1) * pageSize,
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
}

// POST /api/scrape-rules - Create a new scrape rule
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "规则名称不能为空" }, { status: 400 });
    }

    const rule = await db.scrapeRule.create({
      data: {
        name: body.name.trim(),
        description: body.description?.trim() || null,
        enabled: body.enabled ?? true,

        // 列表页配置
        listUrl: body.listUrl || null,
        listSelector: body.listSelector ? JSON.stringify(body.listSelector) : null,
        listPagination: body.listPagination ? JSON.stringify(body.listPagination) : null,

        // 书籍信息页配置
        bookTitleSelector: body.bookTitleSelector || null,
        bookAuthorSelector: body.bookAuthorSelector || null,
        bookCategorySelector: body.bookCategorySelector || null,
        bookKeywordsSelector: body.bookKeywordsSelector || null,
        bookDescriptionSelector: body.bookDescriptionSelector || null,
        bookCoverSelector: body.bookCoverSelector || null,
        bookStatusSelector: body.bookStatusSelector || null,

        // 章节目录页配置
        chapterListUrl: body.chapterListUrl || null,
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
        storageMode: body.storageMode || "database",
        filePath: body.filePath || null,
        coverSavePath: body.coverSavePath || null,

        // 采集策略
        scrapeMode: body.scrapeMode || "incremental",
        threadCount: body.threadCount || 3,
        minDelay: body.minDelay ?? 1000,
        maxDelay: body.maxDelay ?? 3000,
        enableShuffle: body.enableShuffle ?? false,
        dedupMode: body.dedupMode || "url",

        // 内容清洗
        cleanConfig: body.cleanConfig ? JSON.stringify(body.cleanConfig) : null,
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
}