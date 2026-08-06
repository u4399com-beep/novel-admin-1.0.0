'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { History } from 'lucide-react';
import { ContinueReading } from '@/components/home/ContinueReading';
import { getCoverGradient } from '@/lib/cover-gradient';

// ─── Recently Viewed ──────────────────────────────────────────────

const RECENT_KEY = 'novel-recently-viewed';

interface RecentNovel {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  category: { name: string; color: string } | null;
  viewedAt: number;
}

function getRecentlyViewed(): RecentNovel[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch { return []; }
}

function clearRecentlyViewed() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(RECENT_KEY);
}

// ─── HomeActivity Component ────────────────────────────────────────

export function HomeActivity() {
  const [recentNovels, setRecentNovels] = useState<RecentNovel[]>(() => {
    if (typeof window === 'undefined') return [];
    return getRecentlyViewed();
  });

  // Listen for storage changes from other tabs
  useEffect(() => {
    const handler = () => setRecentNovels(getRecentlyViewed());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return (
    <>
      {/* Continue Reading */}
      <section className="border-b card-glass">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">
          <ContinueReading />
        </div>
      </section>

      {/* Recently Viewed */}
      {recentNovels.length > 0 && (
        <section className="border-b bg-muted/20 card-glass">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">最近浏览</span>
                <span className="text-[10px] text-muted-foreground/60">{recentNovels.length}</span>
              </div>
              <button
                onClick={() => { clearRecentlyViewed(); setRecentNovels([]); }}
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors focus-ring-soft"
              >
                清除
              </button>
            </div>
            <div className="flex items-center gap-3 overflow-x-auto scrollbar-none pb-1">
              {recentNovels.slice(0, 8).map((rn) => (
                <Link
                  key={rn.id}
                  href={`/novels/${rn.id}`}
                  className="shrink-0 flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2 transition-all hover:shadow-sm hover:border-primary/30 group hover-lift tap-feedback"
                >
                  <div className="h-8 w-6 rounded overflow-hidden shrink-0">
                    {rn.coverUrl ? (
                      <img src={rn.coverUrl} alt={rn.title} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className={`h-full w-full bg-gradient-to-br ${getCoverGradient(rn.title)}`} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium line-clamp-1 group-hover:text-primary transition-colors">{rn.title}</p>
                    <p className="text-[10px] text-muted-foreground line-clamp-1">{rn.author}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
