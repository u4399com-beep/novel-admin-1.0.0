import { db } from '@/lib/db';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import NovelDetailClient from './NovelDetailClient';
import { isCuid } from '@/lib/slug-generator';

// ─── Types ───────────────────────────────────────────────────────────

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface Chapter {
  id: string;
  title: string;
  wordCount: number;
  sortOrder: number;
  createdAt: Date;
}

interface NovelDetail {
  id: string;
  title: string;
  author: string;
  description: string | null;
  coverUrl: string | null;
  coverPath: string | null;
  status: string;
  wordCount: number;
  clickCount: number;
  favoriteCount: number;
  categoryId: string | null;
  sourceUrl: string | null;
  sourceId: string | null;
  extraKeywords: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  category: { id: string; name: string; slug: string; color: string; icon: string | null } | null;
  tags: Tag[];
  _count: { chapters: number };
  createdAt: Date;
  updatedAt: Date;
}

// ─── Slug resolution ────────────────────────────────────────────────

/**
 * If the route param is not a cuid, look it up in the NovelSlug table.
 * Returns the resolved novel cuid, or null if not found.
 */
async function resolveSlugToNovelId(param: string): Promise<string | null> {
  if (isCuid(param)) {
    return param; // Already a cuid — direct lookup
  }

  const mapping = await db.novelSlug.findUnique({
    where: { slug: param },
    select: { novelId: true, isActive: true },
  });

  return mapping && mapping.isActive ? mapping.novelId : null;
}

// ─── Data fetching (server-side) ─────────────────────────────────────

async function getNovel(id: string): Promise<NovelDetail | null> {
  const novel = await db.novel.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true, slug: true, color: true, icon: true } },
      tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
      _count: { select: { chapters: true } },
    },
  });
  if (!novel) return null;
  const { tags, ...rest } = novel;
  return { ...rest, tags: tags.map((t) => t.tag) };
}

async function getChapters(novelId: string): Promise<Chapter[]> {
  // Limit SSR chapters to 200 for performance; client fetches more on demand
  return db.chapter.findMany({
    where: { novelId },
    orderBy: { sortOrder: 'asc' },
    take: 200,
    select: {
      id: true,
      title: true,
      wordCount: true,
      sortOrder: true,
      createdAt: true,
    },
  });
}

// ─── Metadata ────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id: paramId } = await params;
  const novelId = await resolveSlugToNovelId(paramId);
  if (!novelId) return { title: '小说未找到' };
  const novel = await getNovel(novelId);
  if (!novel) return { title: '小说未找到' };

  const title = `${novel.title} - ${novel.author} - 小说阁`;
  const chapterCount = novel._count.chapters;
  const wordCountStr = novel.wordCount >= 10000
    ? `${(novel.wordCount / 10000).toFixed(1)}万字`
    : `${novel.wordCount}字`;
  const fallbackDesc = `${novel.title} by ${novel.author}, ${wordCountStr}, ${chapterCount}章`;
  const description = (novel.description || fallbackDesc).slice(0, 160);

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'article',
    },
  };
}

// ─── Page ────────────────────────────────────────────────────────────

export default async function NovelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: paramId } = await params;

  // Resolve slug to novel cuid
  const novelId = await resolveSlugToNovelId(paramId);
  if (!novelId) {
    notFound();
  }

  let novel: NovelDetail | null = null;
  let chapters: Chapter[] = [];
  try {
    [novel, chapters] = await Promise.all([
      getNovel(novelId),
      getChapters(novelId),
    ]);
  } catch (error) {
    console.error('Failed to load novel detail:', error);
  }

  if (!novel) {
    notFound();
  }

  return (
    <NovelDetailClient
      novel={JSON.parse(JSON.stringify(novel))}
      chapters={JSON.parse(JSON.stringify(chapters))}
      totalChapters={novel._count.chapters}
    />
  );
}
