import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const MAX_SEARCH_LENGTH = 200;

// GET /api/novels/[id]/chapters - List chapters for a novel (with pagination)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;
    const { searchParams } = new URL(request.url);

    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const pageSize = Math.min(Math.max(1, parseInt(searchParams.get("pageSize") || "100") || 100), 500);

    const [chapters, total] = await Promise.all([
      db.chapter.findMany({
        where: { novelId },
        orderBy: { sortOrder: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.chapter.count({ where: { novelId } }),
    ]);

    return NextResponse.json({
      chapters,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("List chapters error:", error);
    return NextResponse.json({ error: "获取章节列表失败" }, { status: 500 });
  }
}

// POST /api/novels/[id]/chapters - Create a chapter
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: novelId } = await params;
    const body = await request.json();
    const { title, content } = body;

    if (!title?.trim()) {
      return NextResponse.json({ error: "章节标题不能为空" }, { status: 400 });
    }

    const trimmedTitle = title.trim().slice(0, 200);
    const trimmedContent = content ? String(content).slice(0, 500000) : null;
    const wordCount = trimmedContent ? trimmedContent.length : 0;

    // Use transaction to ensure atomicity
    const chapter = await db.$transaction(async (tx) => {
      // Get the max sortOrder for this novel
      const maxOrder = await tx.chapter.findFirst({
        where: { novelId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });

      const newChapter = await tx.chapter.create({
        data: {
          title: trimmedTitle,
          content: trimmedContent,
          wordCount,
          sortOrder: (maxOrder?.sortOrder || 0) + 1,
          novelId,
        },
      });

      // Update novel word count atomically
      await tx.novel.update({
        where: { id: novelId },
        data: { wordCount: { increment: wordCount } },
      });

      return newChapter;
    });

    return NextResponse.json(chapter, { status: 201 });
  } catch (error) {
    console.error("Create chapter error:", error);
    return NextResponse.json({ error: "创建章节失败" }, { status: 500 });
  }
}