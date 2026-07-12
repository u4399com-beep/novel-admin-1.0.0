/**
 * POST /api/scrape-rules/ai-analyze
 *
 * Receives HTML content from the scraper-service, uses z-ai-web-dev-sdk LLM
 * to analyze the page structure and generate a complete ScrapeRule configuration.
 *
 * Called by: scraper-service /ai/generate-rule endpoint
 */

import { apiSuccess, apiError, safeJson } from "@/lib/api-utils";
import { withAuth } from "@/lib/api-auth";
import { NextRequest } from "next/server";

// ==================== Types ====================

interface AiAnalyzeRequest {
  html: string;
  url: string;
  siteType?: string;
}

interface GeneratedRuleResult {
  success: boolean;
  rule: {
    name: string;
    description: string;
    engine: string;
    listUrl: string;
    listSelector: { type: string; value: string };
    listPagination: { type: string; selector: string; maxPage: number };
    bookTitleSelector: { type: string; value: string };
    bookAuthorSelector: { type: string; value: string };
    bookDescriptionSelector: { type: string; value: string };
    bookCoverSelector: { type: string; value: string };
    bookStatusSelector: { type: string; value: string };
    chapterListSelector: { type: string; value: string };
    chapterTitleSelector: { type: string; value: string };
    chapterLinkSelector: { type: string; value: string };
    contentSelector: { type: string; value: string };
    contentTitleSelector: { type: string; value: string };
    antiCrawlConfig: {
      useJsRender: boolean;
      uaRotation: boolean;
      minDelay: number;
      maxDelay: number;
    };
    agentqlQueries?: {
      title?: string;
      author?: string;
      description?: string;
      chapters?: string;
      content?: string;
    };
    confidence: number;
    notes: string[];
  };
  error?: string;
}

// ==================== System Prompt ====================

const SYSTEM_PROMPT = `你是一个专业的网页采集规则生成助手。分析给定的HTML页面结构，为小说采集系统生成完整的采集规则配置。

你需要：
1. 分析页面结构，识别列表页、书籍详情页、章节目录页、内容页的选择器
2. 生成精确的CSS选择器
3. 推荐最适合的采集引擎
4. 生成AgentQL自然语言查询作为备选方案
5. 评估每个选择器的置信度

返回格式要求：严格返回JSON格式，不要包含其他文本。

返回的JSON结构如下：
{
  "name": "站点名称 - 规则名称",
  "description": "简要描述该站点特点和规则用途",
  "engine": "cheerio|playwright|firecrawl|agentql|cloud-browser",
  "listUrl": "小说列表页URL（如果当前页面就是列表页则填入）",
  "listSelector": { "type": "css", "value": "CSS选择器" },
  "listPagination": { "type": "next|page", "selector": "下一页按钮的CSS选择器", "maxPage": 50 },
  "bookTitleSelector": { "type": "css", "value": "CSS选择器" },
  "bookAuthorSelector": { "type": "css", "value": "CSS选择器" },
  "bookDescriptionSelector": { "type": "css", "value": "CSS选择器" },
  "bookCoverSelector": { "type": "css", "value": "CSS选择器（提取img的src）" },
  "bookStatusSelector": { "type": "css", "value": "CSS选择器" },
  "chapterListSelector": { "type": "css", "value": "章节列表容器的CSS选择器" },
  "chapterTitleSelector": { "type": "css", "value": "章节标题的CSS选择器" },
  "chapterLinkSelector": { "type": "css", "value": "章节链接的CSS选择器（a标签的href）" },
  "contentSelector": { "type": "css", "value": "正文内容的CSS选择器" },
  "contentTitleSelector": { "type": "css", "value": "内容页标题的CSS选择器" },
  "antiCrawlConfig": {
    "useJsRender": false,
    "uaRotation": true,
    "minDelay": 1000,
    "maxDelay": 3000
  },
  "agentqlQueries": {
    "title": "AgentQL自然语言查询：提取页面标题",
    "author": "AgentQL自然语言查询：提取作者名",
    "description": "AgentQL自然语言查询：提取简介描述",
    "chapters": "AgentQL自然语言查询：提取章节列表（含标题和链接）",
    "content": "AgentQL自然语言查询：提取正文内容"
  },
  "confidence": 75,
  "notes": [
    "分析说明1：该站点使用xxx结构",
    "分析说明2：推荐使用xxx引擎因为xxx"
  ]
}

分析规则：
- 根据HTML结构判断当前页面类型（列表页/详情页/章节目录页/内容页）
- CSS选择器要尽量精确，优先使用class和id，避免过于宽泛的选择器
- 如果页面是列表页，重点分析列表项的选择器
- 如果页面是详情页，重点分析书籍信息字段的选择器
- 如果页面是章节目录页，重点分析章节列表的选择器
- 如果页面是内容页，重点分析正文区域的选择器
- 对于无法确定的选择器，填入合理的猜测值并降低置信度
- engine推荐：静态HTML用cheerio，需要JS渲染用playwright，复杂页面用cloud-browser
- 如果站点有明显反爬措施，建议开启useJsRender和uaRotation
- confidence: 整体规则置信度(0-100)，基于选择器的确定性和页面的典型程度
- notes: 列出你的分析依据和注意事项，用中文`;

// ==================== Default Rule ====================

function getDefaultRule(url: string): GeneratedRuleResult["rule"] {
  const hostname = (() => {
    try { return new URL(url).hostname; } catch { return "unknown"; }
  })();

  return {
    name: `${hostname} - 自动生成规则`,
    description: `基于AI分析自动生成的采集规则，目标站点: ${hostname}`,
    engine: "cheerio",
    listUrl: url,
    listSelector: { type: "css", value: "" },
    listPagination: { type: "next", selector: "", maxPage: 50 },
    bookTitleSelector: { type: "css", value: "" },
    bookAuthorSelector: { type: "css", value: "" },
    bookDescriptionSelector: { type: "css", value: "" },
    bookCoverSelector: { type: "css", value: "" },
    bookStatusSelector: { type: "css", value: "" },
    chapterListSelector: { type: "css", value: "" },
    chapterTitleSelector: { type: "css", value: "" },
    chapterLinkSelector: { type: "css", value: "" },
    contentSelector: { type: "css", value: "" },
    contentTitleSelector: { type: "css", value: "" },
    antiCrawlConfig: {
      useJsRender: false,
      uaRotation: true,
      minDelay: 1000,
      maxDelay: 3000,
    },
    agentqlQueries: {
      title: "extract the title of this page",
      author: "extract the author name",
      description: "extract the description or summary text",
      chapters: "extract the list of chapter titles and their links",
      content: "extract the main text content of this page",
    },
    confidence: 0,
    notes: ["LLM分析失败，使用默认规则。请手动配置选择器。"],
  };
}

// ==================== POST Handler ====================

export const POST = withAuth(async function POST(request: NextRequest) {
  let body: AiAnalyzeRequest;
  try {
    body = await safeJson<AiAnalyzeRequest>(request);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : "Invalid request body", 400);
  }

  const { html, url, siteType } = body;

  if (!html || typeof html !== "string") {
    return apiError("html is required and must be a string", 400);
  }
  if (html.length > 500_000) {
    return apiError("HTML内容过大", 400);
  }
  if (!url || typeof url !== "string") {
    return apiError("url is required and must be a string", 400);
  }

  // Build user message
  const siteTypeHint = siteType
    ? `\n站点类型提示: ${siteType}`
    : "";
  const userMessage = `URL: ${url}${siteTypeHint}

HTML内容:
${html}`;

  try {
    // Use z-ai-web-dev-sdk for LLM analysis
    const ZAI = (await import("z-ai-web-dev-sdk")).default;
    const zai = await ZAI.create();

    console.log(`[AI Analyze] Analyzing ${url} (${html.length} chars) ...`);

    const llmAbort = new AbortController();
    let llmTimeoutId: ReturnType<typeof setTimeout>;
    const completion = await Promise.race([
      zai.chat.completions.create({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        thinking: { type: "disabled" },
      }),
      new Promise<never>((_, reject) => {
        llmTimeoutId = setTimeout(() => {
          llmAbort.abort();
          reject(new Error("LLM request timed out after 120s"));
        }, 120_000);
      }),
    ]);
    clearTimeout(llmTimeoutId);

    const rawContent = completion.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.error("[AI Analyze] LLM returned empty content");
      return apiSuccess<GeneratedRuleResult>({
        success: false,
        rule: getDefaultRule(url),
        error: "LLM returned empty response",
      });
    }

    // Parse the JSON from the LLM response
    // LLM may wrap the JSON in markdown code blocks
    let jsonStr = rawContent.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error("[AI Analyze] Failed to parse LLM JSON response:", parseErr);
      console.error("[AI Analyze] Raw response:", rawContent.substring(0, 1000));
      return apiSuccess<GeneratedRuleResult>({
        success: false,
        rule: getDefaultRule(url),
        error: `LLM returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : "parse error"}`,
      });
    }

    // Validate and normalize the rule
    const rule = normalizeRule(parsed, url);

    console.log(`[AI Analyze] Rule generated. Confidence: ${rule.confidence}, Engine: ${rule.engine}`);

    return apiSuccess<GeneratedRuleResult>({
      success: true,
      rule,
    });
  } catch (err) {
    console.error("[AI Analyze] Error:", err);
    return apiSuccess<GeneratedRuleResult>({
      success: false,
      rule: getDefaultRule(url),
      error: "AI analysis failed, please try again",
    });
  }
});

// ==================== Normalization ====================

/**
 * Normalize and validate the LLM-returned rule object.
 * Ensures all required fields exist with sensible defaults.
 */
function normalizeRule(raw: Record<string, unknown>, url: string): GeneratedRuleResult["rule"] {
  const hostname = (() => {
    try { return new URL(url).hostname; } catch { return "unknown"; }
  })();

  const makeSelector = (field: unknown): { type: string; value: string } => {
    if (field && typeof field === "object" && !Array.isArray(field)) {
      const obj = field as Record<string, unknown>;
      return {
        type: String(obj.type || "css"),
        value: String(obj.value || ""),
      };
    }
    return { type: "css", value: "" };
  };

  const pagination = (raw.listPagination && typeof raw.listPagination === "object" && !Array.isArray(raw.listPagination))
    ? raw.listPagination as Record<string, unknown>
    : {};

  const antiCrawl = (raw.antiCrawlConfig && typeof raw.antiCrawlConfig === "object" && !Array.isArray(raw.antiCrawlConfig))
    ? raw.antiCrawlConfig as Record<string, unknown>
    : {};

  const agentql = (raw.agentqlQueries && typeof raw.agentqlQueries === "object" && !Array.isArray(raw.agentqlQueries))
    ? raw.agentqlQueries as Record<string, unknown>
    : {};

  const notes = Array.isArray(raw.notes)
    ? raw.notes.map((n: unknown) => String(n))
    : [];

  const validEngines = ["cheerio", "playwright", "firecrawl", "agentql", "cloud-browser"];
  const engine = validEngines.includes(String(raw.engine || ""))
    ? String(raw.engine)
    : "cheerio";

  const confidence = typeof raw.confidence === "number"
    ? Math.max(0, Math.min(100, Math.round(raw.confidence)))
    : 50;

  return {
    name: String(raw.name || `${hostname} - 自动生成规则`),
    description: String(raw.description || `基于AI分析自动生成的采集规则`),
    engine,
    listUrl: String(raw.listUrl || url),
    listSelector: makeSelector(raw.listSelector),
    listPagination: {
      type: String(pagination.type || "next"),
      selector: String(pagination.selector || ""),
      maxPage: typeof pagination.maxPage === "number" ? Math.min(pagination.maxPage, 500) : 50,
    },
    bookTitleSelector: makeSelector(raw.bookTitleSelector),
    bookAuthorSelector: makeSelector(raw.bookAuthorSelector),
    bookDescriptionSelector: makeSelector(raw.bookDescriptionSelector),
    bookCoverSelector: makeSelector(raw.bookCoverSelector),
    bookStatusSelector: makeSelector(raw.bookStatusSelector),
    chapterListSelector: makeSelector(raw.chapterListSelector),
    chapterTitleSelector: makeSelector(raw.chapterTitleSelector),
    chapterLinkSelector: makeSelector(raw.chapterLinkSelector),
    contentSelector: makeSelector(raw.contentSelector),
    contentTitleSelector: makeSelector(raw.contentTitleSelector),
    antiCrawlConfig: {
      useJsRender: Boolean(antiCrawl.useJsRender),
      uaRotation: Boolean(antiCrawl.uaRotation !== false), // default true
      minDelay: typeof antiCrawl.minDelay === "number" ? Math.max(0, antiCrawl.minDelay) : 1000,
      maxDelay: typeof antiCrawl.maxDelay === "number" ? Math.max(0, antiCrawl.maxDelay) : 3000,
    },
    agentqlQueries: {
      title: typeof agentql.title === "string" ? agentql.title : undefined,
      author: typeof agentql.author === "string" ? agentql.author : undefined,
      description: typeof agentql.description === "string" ? agentql.description : undefined,
      chapters: typeof agentql.chapters === "string" ? agentql.chapters : undefined,
      content: typeof agentql.content === "string" ? agentql.content : undefined,
    },
    confidence,
    notes,
  };
}