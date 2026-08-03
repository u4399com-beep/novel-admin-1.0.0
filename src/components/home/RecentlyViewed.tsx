'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { Clock, ChevronRight, X, Loader2 } from 'lucide-react';
import { formatRelativeTime } from '@/lib/format';
import { getCoverGradient } from '@/lib/cover-gradient';

interface RecentNovel {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  category: { name: string; color: string } | null;
  viewedAt: number;
}

const RECENT_KEY = 'novel-recently-viewed';
const MAX_ITEMS = 8;

function RecentlyViewedSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-background p-3">
          <div className="aspect-[3/4] rounded-lg animate-pulse bg-muted mb-2.5" />
          <div className="h-3.5 w-3/4 rounded skeleton-line" />
          <div className="h-3 w-1/2 rounded skeleton-line mt-1.5" />
        </div>
      ))}
    </div>
  );
}

export function RecentlyViewed() {
  const [novels, setNovels] = useState<RecentNovel[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) { setLoading(false); return; }
      const list: RecentNovel[] = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        setNovels(list.slice(0, MAX_ITEMS));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [dismissed]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem('recently-viewed-dismissed', 'true'); } catch { /* ignore */ }
  }, []);

  // Don't render if dismissed or no data
  if (dismissed) return null;
  if (!loading && novels.length === 0) return null;

  return (
    <div className="group relative">
      {/* Section Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-primary/70" />
          <span className="text-xs font-medium text-muted-foreground">最近浏览</span>
          {novels.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60">{novels.length}</span>
          )}
        </div>
        {!loading && novels.length > 0 && (
          <button
            onClick={handleDismiss}
            className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors opacity-0 group-hover:opacity-100"
            aria-label="隐藏最近浏览"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <RecentlyViewedSkeleton />
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
          >
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 stagger-in">
              {novels.map((novel) => (
                <Link
                  key={novel.id}
                  href={`/novels/${novel.id}`}
                  className="group/item block rounded-xl border bg-background/80 backdrop-blur-sm overflow-hidden transition-all hover:shadow-md hover:border-primary/30 hover:-translate-y-0.5 card-glow"
                >
                  {/* Cover */}
                  <div className="aspect-[3/4] relative overflow-hidden">
                    {novel.coverUrl ? (
                      <img
                        src={novel.coverUrl}
                        alt={novel.title}
                        className="h-full w-full object-cover hover:scale-105 transition-transform duration-500"
                        loading="lazy"
                      />
                    ) : (
                      <div className={`h-full w-full bg-gradient-to-br ${getCoverGradient(novel.title)}`} />
                    )}
                    {/* Time overlay */}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/50 to-transparent p-2 pt-6">
                      <span className="text-[10px] text-white/70 flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        {formatRelativeTime(new Date(novel.viewedAt).toISOString())}
                      </span>
                    </div>
                  </div>
                  {/* Info */}
                  <div className="p-2.5">
                    <p className="text-sm font-medium line-clamp-1 group-hover/item:text-primary transition-colors">
                      {novel.title}
                    </p>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[11px] text-muted-foreground/60">{novel.author}</span>
                      {novel.category && (
                        <span
                          className="text-[9px] px-1 py-px rounded-sm"
                          style={{ color: novel.category.color, backgroundColor: `${novel.category.color}15` }}
                        >
                          {novel.category.name}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
