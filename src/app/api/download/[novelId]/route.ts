import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

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
  // Pick 1-2 random lines
  const count = Math.min(lines.length, Math.floor(Math.random() * 2) + 1);
  const shuffled = [...lines].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).join("\n");
}

// GET /api/download/[novelId] - Generate and return a downloadable novel file
export async function GET(
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

    // Fetch download config
    let config = null;
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
      let textContent = "";

      // Insert site info at beginning
      if (config?.insertSiteInfo && config.siteInfoContent) {
        textContent +=
          replaceVars(config.siteInfoContent, vars) + "\n\n";
      }

      // Process each chapter
      for (let i = 0; i < novel.chapters.length; i++) {
        const chapter = novel.chapters[i];
        const chapterTitle = chapter.title;
        const chapterVars = { ...vars, chapterTitle };

        // Chapter title
        textContent += `\n${chapterTitle}\n\n`;

        // Chapter content
        if (chapter.content) {
          const paragraphs = chapter.content
            .split("\n")
            .filter((p) => p.trim());

          for (let j = 0; j < paragraphs.length; j++) {
            textContent += paragraphs[j] + "\n\n";

            // Insert confusion text between paragraphs
            if (config?.insertConfusion && config.confusionText && j < paragraphs.length - 1) {
              textContent += generateConfusionBlock(config.confusionText) + "\n\n";
            }
          }
        }

        // Insert ad at configured interval and position
        if (config?.insertAd && config.adContent && config.adInterval > 0) {
          if ((i + 1) % config.adInterval === 0) {
            const adText = replaceVars(config.adContent, chapterVars);
            if (config.adPosition === "start") {
              textContent =
                `\n${adText}\n\n${chapterTitle}\n\n` +
                textContent.slice((`\n${chapterTitle}\n\n`).length);
            } else if (config.adPosition === "middle") {
              // Insert ad roughly in the middle of the chapter content
              const lines = textContent.split("\n");
              const midPoint = Math.floor(lines.length / 2);
              lines.splice(midPoint, 0, "", adText, "");
              textContent = lines.join("\n");
            } else {
              // end (default)
              textContent += `\n${adText}\n\n`;
            }
          }
        }
      }

      // Insert site info at end
      if (config?.insertSiteInfo && config.siteInfoContent) {
        textContent += "\n" + replaceVars(config.siteInfoContent, vars);
      }

      // Generate filename
      let fileName: string;
      if (config?.fileNamePattern) {
        fileName = replaceVars(config.fileNamePattern, vars) + ".txt";
      } else {
        fileName = replaceVars("{title} - {author}", vars) + ".txt";
      }

      // Sanitize filename
      fileName = fileName.replace(/[<>:"/\\|?*]/g, "_");

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
      return new Response(textContent, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        },
      });
    }

    return NextResponse.json({ error: "不支持的格式" }, { status: 400 });
  } catch (error) {
    console.error("Download novel error:", error);
    return NextResponse.json({ error: "生成下载文件失败" }, { status: 500 });
  }
}