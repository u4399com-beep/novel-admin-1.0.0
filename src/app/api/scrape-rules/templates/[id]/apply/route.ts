import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { getTemplateById } from '@/lib/scrape-templates';
import { sanitizeField, apiError, apiSuccess, safeJson } from '@/lib/api-utils';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/scrape-rules/templates/[id]/apply
 * 基于模板创建一条新的采集规则
 *
 * Body (optional): { name?: string, description?: string }
 */
export const POST = withAuth(async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;

    // 1. 查找模板
    const template = getTemplateById(id);
    if (!template) {
      return apiError('模板不存在', 404);
    }

    // 2. 解析可选的覆盖参数
    let overrides: { name?: string; description?: string } = {};
    try {
      overrides = await safeJson<{ name?: string; description?: string }>(request);
    } catch {
      // 空body或无效JSON，使用默认值
    }

    const ruleName = sanitizeField(overrides.name, 200) || `${template.name} - 基于模板`;
    const ruleDesc = sanitizeField(overrides.description, 2000) || `基于「${template.name}」模板创建的采集规则`;

    // 3. 创建规则 — 模板数据已预验证，直接使用
    const rule = await db.scrapeRule.create({
      data: {
        name: ruleName,
        description: ruleDesc,
        enabled: true,

        // 列表页配置
        listUrl: template.listUrl || null,
        listSelector: template.listSelector || null,

        // 书籍信息选择器
        bookTitleSelector: template.bookTitleSelector || null,
        bookAuthorSelector: template.bookAuthorSelector || null,
        bookCategorySelector: template.bookCategorySelector || null,
        bookKeywordsSelector: template.bookKeywordsSelector || null,
        bookDescriptionSelector: template.bookDescriptionSelector || null,
        bookCoverSelector: template.bookCoverSelector || null,
        bookStatusSelector: template.bookStatusSelector || null,

        // 章节目录配置
        chapterListUrl: template.chapterListUrl || null,
        chapterListSelector: template.chapterListSelector || null,
        chapterTitleSelector: template.chapterTitleSelector || null,
        chapterLinkSelector: template.chapterLinkSelector || null,

        // 正文配置
        contentSelector: template.contentSelector || null,

        // 采集策略
        engine: template.engine,
        scrapeMode: template.scrapeMode,
        dedupMode: template.dedupMode,

        // 默认值
        storageMode: 'database',
        threadCount: 3,
        minDelay: 1000,
        maxDelay: 3000,
        enableShuffle: false,

        // 内容清洗: 默认开启广告清理
        cleanConfig: JSON.stringify({
          removeAds: true,
          cleanHtml: true,
          removeSelectors: '',
          removePatterns: '',
          adPatterns: '',
        }),
      },
      include: { _count: { select: { tasks: true } } },
    });

    return apiSuccess(rule, 201);
  } catch (error) {
    console.error('Apply template error:', error);
    return apiError('应用模板失败');
  }
});
