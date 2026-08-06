'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BookOpen,
  PlusCircle,
  Globe,
  FolderTree,
  CheckCircle2,
  ArrowUpRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-fetch';
import { useAppStore } from '@/stores/app-store';
import type { DashboardStats, Novel } from '@/types';
import { ReadingHeatMap } from '@/components/ReadingHeatMap';
import { ReadingStatsCard } from '@/components/ReadingStatsCard';

import { StatCard, statCards } from './dashboard/StatCard';
import { RecentActivity } from './dashboard/RecentActivity';
import type { ActivityData } from './dashboard/RecentActivity';
import { QuickActions } from './dashboard/QuickActions';
import type { QuickActionItem } from './dashboard/QuickActions';
import { StatusChart } from './dashboard/StatusChart';
import { ActivityChart } from './dashboard/ActivityChart';
import { RecentNovels } from './dashboard/RecentNovels';
import { DailyTip } from './dashboard/DailyTip';

// ─── Component ────────────────────────────────────────────────────────────
export function DashboardView() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activityData, setActivityData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState(false);

  const refreshDashboard = useAppStore((s) => s.refreshVersions['dashboard'] ?? 0);
  const selectNovel = useAppStore((s) => s.selectNovel);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setEditingNovel = useAppStore((s) => s.setEditingNovel);
  const setNovelFormOpen = useAppStore((s) => s.setNovelFormOpen);

  const fetchDashboard = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError(null);
      const [statsRes, activityRes] = await Promise.allSettled([
        apiFetch<DashboardStats>('/api/dashboard', { signal }),
        apiFetch<ActivityData>('/api/dashboard/activity', { signal }),
      ]);
      if (signal?.aborted) return;
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value);
      } else {
        setError(statsRes.reason instanceof Error ? statsRes.reason.message : '未知错误');
      }
      if (activityRes.status === 'fulfilled') {
        setActivityData(activityRes.value);
      } else {
        setActivityError(true);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchDashboard(controller.signal);
    return () => { controller.abort(); };
  }, [fetchDashboard, refreshDashboard]);

  // ─── Quick actions ─────────────────────────────────────────────────────
  const handleCreateNovel = () => {
    setEditingNovel(null);
    setNovelFormOpen(true);
  };

  const handleViewNovel = (novel: Novel) => {
    selectNovel(novel);
    setCurrentView('novel-detail');
  };

  const handleQuickAction = (action: QuickActionItem) => {
    if (action.view === 'createNovel') {
      handleCreateNovel();
    } else {
      setCurrentView(action.view);
    }
  };

  // ─── Trend indicators ─────────────────────────────────────────────────────
  const trendData = useMemo(() => {
    if (!stats) return { completedCount: 0, avgChapters: 0, avgWords: 0 };
    const completedEntry = stats.statusDistribution.find((s) => s.status === 'completed');
    const completedCount = completedEntry?.count ?? 0;
    const avgChapters = stats.totalNovels > 0 ? Math.round(stats.totalChapters / stats.totalNovels) : 0;
    const avgWords = stats.totalNovels > 0 ? Math.round(stats.totalWords / stats.totalNovels) : 0;
    return { completedCount, avgChapters, avgWords };
  }, [stats]);

  // ─── Welcome card helpers (refresh every 60s) ──────────────────────
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { greeting, dateStr } = useMemo(() => {
    const hour = new Date(now).getHours();
    let greeting: string;
    if (hour >= 6 && hour < 12) greeting = '早上好';
    else if (hour >= 12 && hour < 18) greeting = '下午好';
    else greeting = '晚上好';
    const dateStr = new Date(now).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
    return { greeting, dateStr };
  }, [now]);

  // ─── Helper: get trend indicator for a stat card ────────────────────────
  const getTrendIndicator = (cardKey: string) => {
    if (!stats) return null;
    switch (cardKey) {
      case 'totalNovels':
        return trendData.completedCount > 0 ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            <CheckCircle2 className="h-3 w-3" />
            已完结 {trendData.completedCount}
          </span>
        ) : null;
      case 'totalChapters':
        return stats.totalNovels > 0 ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ArrowUpRight className="h-3 w-3" />
            均 {trendData.avgChapters} 章/部
          </span>
        ) : null;
      case 'totalWords':
        return stats.totalNovels > 0 ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ArrowUpRight className="h-3 w-3" />
            均 {trendData.avgWords.toLocaleString()} 字/部
          </span>
        ) : null;
      default:
        return null;
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* ── Welcome Card ──────────────────────────────────────────────────── */}
      <Card className="overflow-hidden border-0 bg-gradient-to-r from-slate-50 to-slate-100/50 dark:from-slate-900/50 dark:to-slate-800/50">
        <CardContent className="relative flex items-center gap-4 p-5 md:p-6">
          {/* Decorative icon */}
          <div className="absolute -right-4 -top-4 h-28 w-28 rounded-full bg-emerald-100/40 dark:bg-emerald-900/20 animate-[pulse_4s_ease-in-out_infinite]" />
          <div className="absolute -right-8 -bottom-8 h-20 w-20 rounded-full bg-amber-100/30 dark:bg-amber-900/10 animate-[pulse_4s_ease-in-out_infinite_1s]" />
          <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm dark:bg-slate-800">
            <BookOpen className="h-6 w-6 text-emerald-500" />
          </div>
          <div className="relative">
            <h2 className="text-lg font-semibold">{greeting}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{dateStr}</p>
          </div>
        </CardContent>
      </Card>

      {/* Welcome (empty state) */}
      {!loading && stats && stats.totalNovels === 0 && stats.totalChapters === 0 && (
        <Card className="border-0 bg-gradient-to-br from-emerald-50 to-teal-50/50 dark:from-emerald-950/30 dark:to-teal-950/20">
          <CardContent className="p-6">
            <div className="text-center mb-6">
              <h3 className="text-xl font-semibold">欢迎使用小说阁</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">开始您的第一步：创建分类、添加小说或配置采集规则</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 stagger-children">
              <button
                type="button"
                className="group flex flex-col items-center gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-1 dark:border-emerald-800/40 dark:bg-emerald-950/30 hover-scale"
                onClick={() => setCurrentView('categories')}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30 transition-transform duration-200 group-hover:scale-110">
                  <FolderTree className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-medium">创建分类</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">为小说建立分类体系</p>
                </div>
              </button>
              <button
                type="button"
                className="group flex flex-col items-center gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-1 dark:border-emerald-800/40 dark:bg-emerald-950/30 hover-scale"
                onClick={handleCreateNovel}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30 transition-transform duration-200 group-hover:scale-110">
                  <PlusCircle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="text-sm font-medium">添加小说</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">手动创建或导入小说</p>
                </div>
              </button>
              <button
                type="button"
                className="group flex flex-col items-center gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-1 dark:border-emerald-800/40 dark:bg-emerald-950/30 hover-scale"
                onClick={() => setCurrentView('scrape')}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-900/30 transition-transform duration-200 group-hover:scale-110">
                  <Globe className="h-6 w-6 text-violet-600 dark:text-violet-400" />
                </div>
                <div>
                  <p className="text-sm font-medium">配置采集规则</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">自动化采集网络小说</p>
                </div>
              </button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Stats Grid ─────────────────────────────────────────────────── */}
      <div className="divider-gradient mb-4" aria-hidden="true" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5 stagger-in stagger-children">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <Card key={i} className="card-glass">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-12 w-12 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-8 w-24" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          : !stats && error ? (
            <div className="col-span-full flex flex-col items-center justify-center rounded-xl border border-dashed py-16">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" disabled={loading} onClick={() => fetchDashboard()}>
                重试
              </Button>
            </div>
          ) : statCards.map((card) => {
              const trend = getTrendIndicator(card.key);
              return (
                <StatCard
                  key={card.key}
                  card={card}
                  stats={stats}
                  trend={trend}
                  onClick={setCurrentView}
                />
              );
            })}
      </div>

      {/* ── Status Distribution + Recent Novels ─────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 stagger-children">
        <StatusChart
          statusDistribution={stats?.statusDistribution ?? []}
          loading={loading}
          onClick={() => setCurrentView('novels')}
        />
        <RecentNovels
          recentNovels={stats?.recentNovels ?? []}
          loading={loading}
          onViewNovel={handleViewNovel}
        />
      </div>

      {/* ── 7-Day Activity Chart ─────────────────────────────────────────── */}
      <ActivityChart
        dailyActivity={activityData?.dailyActivity ?? []}
        loading={loading}
      />

      {/* ── Reading Heatmap + Stats ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Card className="md:col-span-2 card-glass">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">阅读活跃度</CardTitle>
          </CardHeader>
          <CardContent>
            <ReadingHeatMap sessionId="" />
          </CardContent>
        </Card>
        <div className="md:col-span-1">
          <ReadingStatsCard className="h-full" />
        </div>
      </div>

      {/* ── Quick Actions + Daily Tip ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <QuickActions loading={loading} onAction={handleQuickAction} />
        </div>
        <div className="lg:col-span-1 flex items-start">
          <DailyTip />
        </div>
      </div>

      {/* ── Recent Activity (Real Data) ─────────────────────────────────── */}
      <RecentActivity
        loading={loading}
        activityData={activityData}
        activityError={activityError}
        onRetry={() => fetchDashboard()}
        onViewAll={() => setCurrentView('novels')}
      />

    </div>
  );
}
