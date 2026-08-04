'use client';

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Chapter {
  id: string;
  title: string;
  wordCount: number;
  sortOrder: number;
  createdAt: string;
}

export interface Novel {
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
  category: { id: string; name: string; slug: string; color: string; icon: string | null } | null;
  tags: Tag[];
  _count: { chapters: number };
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkEntry {
  chapterIndex: number;
  chapterTitle: string;
  timestamp: number;
  scrollPercent: number;
}
