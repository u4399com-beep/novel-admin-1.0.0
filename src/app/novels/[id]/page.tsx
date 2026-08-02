import { db } from '@/lib/db';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import NovelDetailClient from './NovelDetailClient';

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
  return db.chapter.findMany({
    where: { novelId },
    orderBy: { sortOrder: 'asc' },
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
  const { id } = await params;
  const novel = await getNovel(id);
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
  const { id } = await params;
  let novel: NovelDetail | null = null;
  let chapters: Chapter[] = [];
  try {
    [novel, chapters] = await Promise.all([
      getNovel(id),
      getChapters(id),
    ]);
  } catch (error) {
    console.error('Failed to load novel detail:', error);
  }

  if (!novel) {
    notFound();
  }

  return <NovelDetailClient novel={JSON.parse(JSON.stringify(novel))} chapters={JSON.parse(JSON.stringify(chapters))} />;
}
