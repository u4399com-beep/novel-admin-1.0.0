import { db } from "@/lib/db";
import type { DownloadConfig } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";

// Replace variables in a template string
function replaceVars(
  template: string,
  vars: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

// Generate confusion text to insert between paragraphs
function generateConfusionBlock(confusionText: string): string {
  const lines = confusionText
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.trim());
  if (lines.length === 0) return "";
  const count = Math.min(lines.length, Math.floor(Math.random() * 2) + 1);
  const shuffled = [...lines].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).join("\n");
}

// GET /api/download/[novelId] - Generate and return a downloadable novel file
export const GET = withAuth(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ novelId: string }> }
) {
  try {
    const { novelId } = await params;
    const { searchParams } = new URL(request.url);
    const configId = searchParams.get("configId");
    const format = searchParams.get("format") || "txt";

    // Fetch novel with chapters
    const novel = await db.novel.findUnique({
      where: { id: novelId },
      include: {
        category: true,
        chapters: {
          orderBy: { sortOrder: "asc" },
          select: {
            title: true,
            content: true,
            wordCount: true,
          },
        },
      },
    });

    if (!novel) {
      return NextResponse.json({ error: "小说不存在" }, { status: 404 });
    }

    if (novel.chapters.length === 0) {
      return NextResponse.json({ error: "该小说暂无章节" }, { status: 400 });
    }

    // Fetch download config
    let config: DownloadConfig | null = null;
    if (configId) {
      config = await db.downloadConfig.findUnique({ where: { id: configId } });
      if (!config) {
        return NextResponse.json(
          { error: "下载配置不存在" },
          { status: 400 }
        );
      }
    }

    // Variables for template replacement
    const chapterCount = novel.chapters.length;
    const totalWordCount = novel.chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0);
    const dateStr = new Date().toISOString().slice(0, 10);
    const vars: Record<string, string> = {
      title: novel.title,
      author: novel.author,
      wordCount: String(totalWordCount),
      chapterCount: String(chapterCount),
      date: dateStr,
      siteName: "本站",
    };

    if (format === "txt") {
      const chapterBlocks: string[] = [];

      // Process each chapter
      for (let i = 0; i < novel.chapters.length; i++) {
        const chapter = novel.chapters[i];
        const chapterTitle = chapter.title;
        const chapterVars = { ...vars, chapterTitle };
        let block = "";

        // Insert ad at "start" position before this chapter if needed
        if (config && config.insertAd && config.adContent && config.adInterval > 0 && (i + 1) % config.adInterval === 0) {
          if (config.adPosition === "start") {
            block += `\n${replaceVars(config.adContent, chapterVars)}\n\n`;
          }
        }

        // Chapter title
        block += `${chapterTitle}\n\n`;

        // Chapter content
        if (chapter.content) {
          const paragraphs = chapter.content
            .split("\n")
            .filter((p) => p.trim());

          // Insert ad at "middle" position
          let middleAdInserted = false;
          const midPoint = Math.floor(paragraphs.length / 2);

          for (let j = 0; j < paragraphs.length; j++) {
            // Insert ad in the middle of content
            if (
              !middleAdInserted &&
              config &&
              config.insertAd &&
              config.adContent &&
              config.adInterval > 0 &&
              (i + 1) % config.adInterval === 0 &&
              config.adPosition === "middle" &&
              j === midPoint
            ) {
              block += `\n${replaceVars(config.adContent, chapterVars)}\n\n`;
              middleAdInserted = true;
            }

            block += paragraphs[j] + "\n\n";

            // Insert confusion text between paragraphs
            if (config && config.insertConfusion && config.confusionText && j < paragraphs.length - 1) {
              block += generateConfusionBlock(config.confusionText) + "\n\n";
            }
          }
        }

        // Insert ad at "end" position after this chapter
        if (config && config.insertAd && config.adContent && config.adInterval > 0 && (i + 1) % config.adInterval === 0) {
          if (config.adPosition === "end") {
            block += `\n${replaceVars(config.adContent, chapterVars)}\n\n`;
          }
        }

        chapterBlocks.push(block);
      }

      // Assemble final text
      let textContent = "";

      // Insert site info at beginning
      if (config && config.insertSiteInfo && config.siteInfoContent) {
        textContent += replaceVars(config.siteInfoContent, vars) + "\n\n";
      }

      textContent += chapterBlocks.join("\n");

      // Insert site info at end
      if (config && config.insertSiteInfo && config.siteInfoContent) {
        textContent += "\n" + replaceVars(config.siteInfoContent, vars);
      }

      // Generate filename
      let fileName: string;
      if (config && config.fileNamePattern) {
        fileName = replaceVars(config.fileNamePattern, vars) + ".txt";
      } else {
        fileName = replaceVars("{title} - {author}", vars) + ".txt";
      }

      // Sanitize filename
      fileName = fileName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();

      // Record file in NovelFile
      await db.novelFile.create({
        data: {
          novelId,
          fileName,
          filePath: `/downloads/${fileName}`,
          fileSize: Buffer.byteLength(textContent, "utf-8"),
          format: "txt",
          configId: configId || null,
        },
      });

      // Return as download
      const downloadResponse = new Response(textContent, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Content-Security-Policy": "default-src 'none'",
        },
      });
      // Wrap plain Response in NextResponse.json metadata pattern for withAuth compatibility
      return downloadResponse as unknown as NextResponse;
    }

    return NextResponse.json({ error: "不支持的格式" }, { status: 400 });
  } catch (error) {
    console.error("Download novel error:", error);
    return NextResponse.json({ error: "生成下载文件失败" }, { status: 500 });
  }
});