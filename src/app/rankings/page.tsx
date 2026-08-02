'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Trophy, Medal, BookOpen } from 'lucide-react';
import { motion } from 'framer-motion';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { BackToTop } from '@/components/BackToTop';
import { formatWordCount } from '@/lib/format';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';

// ─── Types ───────────────────────────────────────────────────────────

interface RankingNovel {
  id: string;
  title: string;
  author: string;
  description: string | null;
  status: string;
  wordCount: number;
  clickCount: number;
  favoriteCount: number;
  category: { id: string; name: string; slug: string; color: string; icon: string | null } | null;
  _count: { chapters: number };
  createdAt: string;
  updatedAt: string;
}

interface TabConfig {
  key: string;
  label: string;
  sortParam: string;
}

const TABS: TabConfig[] = [
  { key: 'weekly', label: '周点击榜', sortParam: 'weekly_clicks' },
  { key: 'monthly', label: '月点击榜', sortParam: 'monthly_clicks' },
  { key: 'favorites', label: '总收藏榜', sortParam: 'total_favorites' },
];

// ─── Medal Colors ────────────────────────────────────────────────────

const RANK_STYLES: Record<number, { text: string; bg: string; border: string; ring: string }> = {
  1: {
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    border: 'border-amber-200 dark:border-amber-800/60',
    ring: 'ring-amber-500/30',
  },
  2: {
    text: 'text-gray-500 dark:text-gray-300',
    bg: 'bg-gray-50 dark:bg-gray-900/40',
    border: 'border-gray-200 dark:border-gray-700/60',
    ring: 'ring-gray-400/30',
  },
  3: {
    text: 'text-orange-600 dark:text-orange-400',
    bg: 'bg-orange-50 dark:bg-orange-950/40',
    border: 'border-orange-200 dark:border-orange-800/60',
    ring: 'ring-orange-500/30',
  },
};

// ─── Rank Number Component ───────────────────────────────────────────

function RankNumber({ rank }: { rank: number }) {
  const style = RANK_STYLES[rank];
  if (style) {
    return (
      <div className={`relative flex items-center justify-center w-8 h-8 rounded-full ${style.bg} ring-2 ${style.ring} overflow-hidden`}>
        <Medal className={`w-4 h-4 ${style.text}`} />
        <div className="absolute inset-0 rank-shine pointer-events-none" />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted text-muted-foreground text-sm font-semibold">
      {rank}
    </div>
  );
}

// ─── Novel Row Component ─────────────────────────────────────────────

function NovelRow({
  novel,
  rank,
  index = 0,
  activeTab,
}: {
  novel: RankingNovel;
  rank: number;
  index?: number;
  activeTab: string;
}) {
  const isTop3 = rank <= 3;
  const style = RANK_STYLES[rank];
  const statValue = activeTab === 'favorites'
    ? novel.favoriteCount.toLocaleString()
    : novel.clickCount.toLocaleString();
  const statLabel = activeTab === 'favorites' ? '收藏' : '点击';

  const rankPercent = 1 - (rank - 1) / 30; // visual weight for progress bar

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, x: -8 }}
      animate={{ opacity: 1, y: 0, x: 0 }}
      transition={{ duration: 0.3, delay: index * 0.04, ease: 'easeOut' as const }}
    >
      <Link
        href={`/novels/${novel.id}`}
        className={
          isTop3
            ? `relative flex rounded-xl border-2 p-4 transition-all hover:shadow-lg hover:-translate-y-0.5 group overflow-hidden ${style?.border}`
            : 'flex items-center gap-4 px-4 py-3 border-b last:border-b-0 transition-all duration-200 hover:bg-muted/50 hover:translate-x-1 group'
        }
      >
      {/* Top 3 gradient background */}
      {isTop3 && (
        <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-background via-muted/30 to-background pointer-events-none" />
      )}
      {/* Rank progress indicator */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 transition-all duration-500"
        style={{
          backgroundColor: isTop3 ? 'var(--primary)' : 'hsl(var(--muted-foreground) / 0.3)',
          opacity: Math.max(0.2, rankPercent),
          borderRadius: isTop3 ? '0.5rem 0 0 0.5rem' : '0',
        }}
      />

      <div className={isTop3 ? 'relative flex items-start gap-4' : 'flex items-center gap-4 w-full'}>
        {/* Rank */}
        <RankNumber rank={rank} />

        {/* Title + Author + Category + Status */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm sm:text-base truncate group-hover:text-primary transition-colors">
              {novel.title}
            </h3>
            {novel.category && (
              <Badge
                variant="outline"
                className="shrink-0 text-[11px] px-1.5 py-0"
                style={{ borderColor: novel.category.color, color: novel.category.color }}
              >
                {novel.category.name}
              </Badge>
            )}
            <Badge
              variant={novel.status === 'completed' ? 'secondary' : 'outline'}
              className="shrink-0 text-[11px] px-1.5 py-0"
            >
              {{ ongoing: '连载中', completed: '已完结', hiatus: '暂停' }[novel.status] ?? novel.status}
            </Badge>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span>{novel.author}</span>
            <span>{formatWordCount(novel.wordCount)}</span>
            <span>{novel._count.chapters} 章</span>
          </div>
        </div>

        {/* Stat column — real click/favorite data */}
        <div className="shrink-0 text-right">
          <div className={isTop3 ? 'text-base sm:text-lg font-bold stat-number' : 'text-sm font-semibold stat-number'}>
            {statValue}
          </div>
          <div className="text-[11px] text-muted-foreground">{statLabel}</div>
        </div>
      </div>
      </Link>
    </motion.div>
  );
}

// ─── Skeleton Row ────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b">
      <Skeleton className="w-8 h-8 rounded-full shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-12 rounded-full" />
          <Skeleton className="h-4 w-14 rounded-full" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-10" />
        </div>
      </div>
      <div className="text-right space-y-1 shrink-0">
        <Skeleton className="h-4 w-10 ml-auto" />
        <Skeleton className="h-3 w-8 ml-auto" />
      </div>
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
      <BookOpen className="w-12 h-12 mb-4 opacity-30" />
      <p className="text-sm">暂无排行数据</p>
    </div>
  );
}

// ─── Tab Content ─────────────────────────────────────────────────────

function RankingTabContent({ tab, active }: { tab: TabConfig; active: boolean }) {
  const [novels, setNovels] = useState<RankingNovel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchNovels = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/public/novels?sort=${tab.sortParam}&pageSize=30`, { signal });
      if (res.ok) {
        const data = await res.json();
        setNovels(data.novels || []);
      } else if (!signal?.aborted) {
        setError(true);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(true);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [tab.sortParam]);

  useEffect(() => {
    if (!active) return;
    const abortController = new AbortController();
    fetchNovels(abortController.signal);
    return () => abortController.abort();
  }, [active, fetchNovels]);

  if (loading) {
    return (
      <div className="rounded-lg border overflow-hidden">
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <BookOpen className="w-10 h-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground mb-3">加载排行榜数据失败</p>
        <Button variant="outline" size="sm" onClick={() => {
          fetchNovels();
        }}>
          重试
        </Button>
      </div>
    );
  }

  if (novels.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3">
      {/* Top 3 cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        {novels.slice(0, 3).map((novel, i) => (
          <NovelRow
            key={novel.id}
            novel={novel}
            rank={i + 1}
            index={i}
            activeTab={tab.key}
          />
        ))}
      </div>

      {/* Remaining rows */}
      {novels.length > 3 && (
        <div className="rounded-lg border overflow-hidden">
          {novels.slice(3).map((novel, i) => (
            <NovelRow
              key={novel.id}
              novel={novel}
              rank={i + 4}
              index={i + 3}
              activeTab={tab.key}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page Component ──────────────────────────────────────────────────

export default function RankingsPage() {
  const [activeTab, setActiveTab] = useState('weekly');

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:py-10">
        {/* Header */}
        <motion.div
          className="mb-6 sm:mb-8"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild><Link href="/">首页</Link></BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>排行榜</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <motion.div
            className="flex items-center gap-3 mt-4"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
          >
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-900/40">
              <Trophy className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1">
              <h1 className="text-xl sm:text-2xl font-bold">排行榜</h1>
              <p className="text-sm text-muted-foreground">热门小说排行，发现好书</p>
            </div>
            <div className="hidden sm:flex items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5">
              <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Top 30</span>
            </div>
          </motion.div>        </motion.div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="w-full sm:w-auto">
            {TABS.map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {TABS.map((tab) => (
            <TabsContent key={tab.key} value={tab.key} className="mt-6">
              <RankingTabContent tab={tab} active={activeTab === tab.key} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
      <BackToTop />
    </div>
  );
}
