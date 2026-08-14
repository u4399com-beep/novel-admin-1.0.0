import { NextRequest } from 'next/server';
import { SCRAPE_TEMPLATES, searchTemplates } from '@/lib/scrape-templates';
import { apiSuccess } from '@/lib/api-utils';

/**
 * GET /api/scrape-rules/templates
 * 返回模板列表，支持 ?search=xxx 过滤
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const search = (searchParams.get('search') || '').trim();
  const templates = searchTemplates(search);

  // 返回模板列表（不含选择器的原始值，仅返回元数据和选择器字段）
  return apiSuccess({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      siteUrl: t.siteUrl,
      engine: t.engine,
      difficulty: t.difficulty,
      tags: t.tags,
      // 选择器字段
      listUrl: t.listUrl,
      listSelector: t.listSelector,
      bookTitleSelector: t.bookTitleSelector,
      bookAuthorSelector: t.bookAuthorSelector,
      bookCategorySelector: t.bookCategorySelector,
      bookKeywordsSelector: t.bookKeywordsSelector,
      bookDescriptionSelector: t.bookDescriptionSelector,
      bookCoverSelector: t.bookCoverSelector,
      bookStatusSelector: t.bookStatusSelector,
      chapterListUrl: t.chapterListUrl,
      chapterListSelector: t.chapterListSelector,
      chapterTitleSelector: t.chapterTitleSelector,
      chapterLinkSelector: t.chapterLinkSelector,
      contentSelector: t.contentSelector,
      scrapeMode: t.scrapeMode,
      dedupMode: t.dedupMode,
    })),
  });
}
