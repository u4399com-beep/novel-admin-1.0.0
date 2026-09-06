'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Sparkles, TrendingUp } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { NovelCover } from '@/components/shared/NovelCover';
import { getStatusInfo } from '@/components/home/shared-types';
import type { NovelCardData } from '@/components/home/shared-types';

// ─── Session ID helper ────────────────────────────────────────
function getSessionId(): string {
  if (typeof window === 'undefined') return '';
  const KEY = 'reading-session-id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

// ─── Component ───────────────────────────────────────────────
export function RecommendationSection() {
  const [novels, setNovels] = useState<NovelCardData[]>([]);
  const [isPersonal, setIsPersonal] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    async function load() {
      try {
        // Try to get reading history first
        const sessionId = getSessionId();
        let historyNovelIds: string[] = [];

        if (sessionId) {
          try {
            const historyData = await apiFetch<{ progress: Array<{ novelId: string }> }>(
              `/api/public/reading-progress?sessionId=${encodeURIComponent(sessionId)}`,
              { signal: ac.signal, silent: true, timeout: 3000 }
            );
            historyNovelIds = historyData.progress?.map((p) => p.novelId).slice(0, 10) ?? [];
          } catch { /* no history, fall through */ }
        }

        // Fetch novels — if we have history, try "猜你喜欢" (same category as read novels)
        // For now, fall back to popular/trending novels
        const sortKey = historyNovelIds.length > 0 ? 'weekly_clicks' : 'favorites';
        const data = await apiFetch<{ novels: NovelCardData[] }>(
          `/api/public/novels?page=1&pageSize=6&sort=${sortKey}`,
          { signal: ac.signal, silent: true, timeout: 5000 }
        );

        if (!ac.signal.aborted) {
          setNovels(data.novels || []);
          setIsPersonal(historyNovelIds.length > 0);
          setLoading(false);
        }
      } catch {
        if (!ac.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => ac.abort();
  }, []);

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 mb-6">
        <div className="h-6 w-32 skeleton-shimmer rounded mb-3" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton-shimmer rounded-lg h-48" />
          ))}
        </div>
      </div>
    );
  }

  if (novels.length === 0) return null;

  const title = isPersonal ? '猜你喜欢' : '热门推荐';
  const Icon = isPersonal ? Sparkles : TrendingUp;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
      className="mx-auto max-w-7xl px-4 sm:px-6 mb-6"
    >
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-primary/70" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 sm:gap-4 stagger-in">
        {novels.map((novel) => (
          <RecommendationCard key={novel.id} novel={novel} />
        ))}
      </div>
    </motion.div>
  );
}

// ─── Compact Recommendation Card ─────────────────────────────
function RecommendationCard({ novel }: { novel: NovelCardData }) {
  const statusInfo = getStatusInfo(novel.status);

  return (
    <Link href={`/novels/${novel.id}`} className="group block">
      <motion.div
        whileHover={{ scale: 1.03, y: -2 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
        className="relative overflow-hidden rounded-lg border border-border/40 bg-card shadow-sm hover:shadow-md transition-shadow duration-200"
      >
        <div className="relative aspect-[3/4] w-full overflow-hidden">
          <NovelCover
            coverUrl={novel.coverUrl}
            title={novel.title}
            className="transition-all duration-300 group-hover:brightness-75"
            textClassName="text-2xl"
          />
          {/* Gradient overlay */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
          {/* Status dot */}
          <span className={`absolute top-1.5 right-1.5 inline-block h-1.5 w-1.5 rounded-full ${statusInfo.dotClass}`} />
          {/* Title at bottom */}
          <div className="absolute bottom-0 left-0 right-0 p-2">
            <p className="text-xs font-medium text-white line-clamp-1">{novel.title}</p>
            <p className="text-[10px] text-white/60 line-clamp-1">{novel.author}</p>
          </div>
        </div>
      </motion.div>
    </Link>
  );
}
