'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { BookOpen } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';

interface SimilarNovel {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  status: string;
  wordCount: number;
  category?: { name: string; color: string } | null;
  _count?: { chapters: number };
}

export function SimilarNovels({ categoryId, currentNovelId, novelTitle }: { categoryId: string | null; currentNovelId: string; novelTitle: string }) {
  const [novels, setNovels] = useState<SimilarNovel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!categoryId) { queueMicrotask(() => setLoading(false)); return; }

    const controller = new AbortController();
    apiFetch<{ novels?: SimilarNovel[]; items?: SimilarNovel[] }>(`/api/public/novels?categoryId=${categoryId}&pageSize=6`, { signal: controller.signal })
      .then((data) => {
        const items = data.novels || data.items || [];
        setNovels(items.filter((n) => n.id !== currentNovelId).slice(0, 5));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [categoryId, currentNovelId]);

  if (loading) {
    return (
      <div className='space-y-3 mt-6'>
        <div className='flex items-center gap-2'>
          <div className='h-5 w-1 rounded-full bg-primary' />
          <h3 className='text-sm font-semibold'>同类推荐</h3>
        </div>
        <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3'>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className='h-24 rounded-lg bg-muted animate-pulse' />
          ))}
        </div>
      </div>
    );
  }

  if (novels.length === 0) return null;

  return (
    <div className='space-y-3 mt-6'>
      <div className='flex items-center gap-2'>
        <div className='h-5 w-1 rounded-full bg-primary' />
        <h3 className='text-sm font-semibold'>同类推荐</h3>
        <span className='text-xs text-muted-foreground'>与「{novelTitle}」相同分类</span>
      </div>
      <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3'>
        {novels.map((novel, i) => (
          <motion.div
            key={novel.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, duration: 0.2 }}
          >
            <Link
              href={`/novels/${novel.id}`}
              className='flex items-start gap-3 p-3 rounded-lg border bg-card hover-scale list-item-compact group'
            >
              <div className='w-10 h-14 rounded bg-muted flex items-center justify-center shrink-0 overflow-hidden'>
                {novel.coverUrl ? (
                  <img src={novel.coverUrl} alt={novel.title} className='w-full h-full object-cover' loading='lazy' />
                ) : (
                  <BookOpen className='h-4 w-4 text-muted-foreground/50' />
                )}
              </div>
              <div className='min-w-0 flex-1'>
                <p className='text-sm font-medium truncate group-hover:text-primary transition-colors'>{novel.title}</p>
                <p className='text-xs text-muted-foreground mt-0.5'>{novel.author}</p>
                <p className='text-[10px] text-muted-foreground/60 mt-0.5 tabular-nums'>
                  {novel._count?.chapters ?? 0}章 · {(novel.wordCount / 10000).toFixed(1)}万字
                </p>
              </div>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
