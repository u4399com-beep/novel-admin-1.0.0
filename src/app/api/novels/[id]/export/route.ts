import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

const MAX_EXPORT_CHAPTERS = 5000;

/**
 * Export a novel with all chapters.
 * GET /api/novels/[id]/export?format=json|txt
 *
 * - json: returns { novel, chapters } as JSON download
 * - txt: returns plain text with all chapter content as download
 */
export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const format = searchParams.get("format") || "json";

    if (!["json", "txt"].includes(format)) {
      return NextResponse.json({ error: "format 必须是 json 或 txt" }, { status: 400 });
    }

    const novel = await db.novel.findUnique({
      where: { id },
      include: {
        category: { select: { name: true, slug: true } },
        tags: { include: { tag: { select: { name: true, color: true } } } },
      },
    });

    if (!novel) {
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }

    // Pre-check chapter count to prevent OOM
    const chapterCount = await db.chapter.count({ where: { novelId: id } });
    if (chapterCount > MAX_EXPORT_CHAPTERS) {
      return NextResponse.json(
        { error: `章节数量(${chapterCount})超过导出上限(${MAX_EXPORT_CHAPTERS})，请分批导出` },
        { status: 400 }
      );
    }

    const chapters = await db.chapter.findMany({
      where: { novelId: id },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        title: true,
        content: true,
        wordCount: true,
        sortOrder: true,
        createdAt: true,
      },
    });

    if (format === "json") {
      const data = {
        exportedAt: new Date().toISOString(),
        novel: {
          title: novel.title,
          author: novel.author,
          description: novel.description,
          status: novel.status,
          wordCount: novel.wordCount,
          category: novel.category,
          tags: novel.tags.map((t) => ({ name: t.tag.name, color: t.tag.color })),
          createdAt: novel.createdAt,
          updatedAt: novel.updatedAt,
        },
        chapters: chapters.map((ch) => ({
          title: ch.title,
          content: ch.content,
          wordCount: ch.wordCount,
          sortOrder: ch.sortOrder,
        })),
        totalChapters: chapters.length,
        totalWordCount: chapters.reduce((sum, ch) => sum + ch.wordCount, 0),
      };

      return new NextResponse(JSON.stringify(data, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(novel.title)}.json"`,
        },
      });
    }

    // TXT format
    const STATUS_MAP: Record<string, string> = { ongoing: "连载中", completed: "已完结", hiatus: "暂停" };
    const safeName = novel.title.replace(/[\\/:*?"<>|]/g, "_");
    const tagNames = novel.tags.map((t) => t.tag.name).join(", ");
    const header = [
      novel.title,
      `作者: ${novel.author}`,
      novel.category ? `分类: ${novel.category.name}` : null,
      tagNames ? `标签: ${tagNames}` : null,
      `状态: ${STATUS_MAP[novel.status] ?? novel.status}`,
      `总字数: ${novel.wordCount.toLocaleString()}`,
      `章节数: ${chapters.length}`,
      `导出时间: ${new Date().toLocaleString("zh-CN")}`,
      "",
      "=".repeat(40),
    ].filter(Boolean).join("\n");

    const body = chapters
      .map((ch) => {
        const divider = `\n${"─".repeat(30)}\n`;
        return `${divider}第${ch.sortOrder}章 ${ch.title}${divider}\n\n${ch.content || "（无内容）"}`;
      })
      .join("\n\n");

    const txt = header + "\n" + body + "\n";

    return new NextResponse(txt, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(safeName)}.txt"`,
      },
    });
  } catch (error) {
    console.error("Export novel error:", error);
    return NextResponse.json({ error: "导出失败" }, { status: 500 });
  }
});
