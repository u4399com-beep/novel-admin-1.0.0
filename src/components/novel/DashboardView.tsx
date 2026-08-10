'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BookOpen,
  PlusCircle,
  Globe,
  FolderTree,
  CheckCircle2,
  ArrowUpRight,
  Download,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-fetch';
import { useAppStore } from '@/stores/app-store';
import type { DashboardStats, Novel } from '@/types';
import ReadingHeatmap from '@/components/stats/ReadingHeatmap';
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
import { ActivityFeed } from '@/components/admin/ActivityFeed';

// ─── Component ────────────────────────────────────────────────────────────
export function DashboardView() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activityData, setActivityData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState(false);

  // Scrape rules quick actions state
  const [scrapeRuleCount, setScrapeRuleCount] = useState<number | null>(null);
  const [scrapeRuleLoading, setScrapeRuleLoading] = useState(false);
  const [scrapeImportResult, setScrapeImportResult] = useState<string | null>(null);

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
    // Fetch scrape rule count in background
    apiFetch<{ total: number }>('/api/scrape-rules?pageSize=0', { signal: controller.signal })
      .then((data) => setScrapeRuleCount(data.total ?? 0))
      .catch(() => { /* silent */ });
    return () => { controller.abort(); };
  }, [fetchDashboard, refreshDashboard]);

  // ─── Import preset scrape rules ─────────────────────────────
  const handleImportPresetRules = useCallback(async () => {
    setScrapeRuleLoading(true);
    setScrapeImportResult(null);
    try {
      const rules = [
        {
          name: '5165.org 大悟读书网',
          description: '大悟读书网全站采集。WordPress架构，HTML干净，cheerio即可采集。',
          enabled: true,
          listUrl: 'https://5165.org/wangluo/',
          listSelector: { type: 'css', value: 'article li' },
          bookTitleSelector: { type: 'css', value: 'a[href*="5165.org/"]' },
          bookCoverSelector: { type: 'css', value: 'a img' },
          chapterListUrl: '{bookUrl}',
          chapterListSelector: { type: 'css', value: 'article' },
          chapterTitleSelector: { type: 'css', value: 'a[href$=".html"]' },
          chapterLinkSelector: { type: 'css', value: 'a[href$=".html"]' },
          contentSelector: { type: 'css', value: '.entry-content' },
          antiCrawlConfig: { useJsRender: false, uaRotation: true, delay: [1500, 3000] },
          cleanConfig: { removeAds: true, removePatterns: ['.gsc-', 'script', 'style', '.sharedaddy'], adPatterns: ['请记住本书首发域名', '手机用户请浏览', '本章未完'] },
          scrapeMode: 'full',
          engine: 'cheerio',
          coverSavePath: '/app/public/covers/5165/',
          threadCount: 2,
          minDelay: 2000,
          maxDelay: 4000,
          enableShuffle: true,
          dedupMode: 'url',
        },
        {
          name: '二三阅读 (23.225.66.244)',
          description: '二三阅读全站采集。章节内容JS动态渲染，必须使用playwright引擎。',
          enabled: true,
          listUrl: 'http://23.225.66.244/sort/1/1.html',
          listSelector: { type: 'css', value: '.item' },
          listPagination: { type: 'next', selector: 'a.next', maxPage: 100 },
          bookTitleSelector: { type: 'css', value: 'dt a' },
          bookAuthorSelector: { type: 'css', value: 'dt span' },
          bookDescriptionSelector: { type: 'css', value: 'dd a' },
          bookCoverSelector: { type: 'css', value: '.image img' },
          chapterListUrl: '{bookUrl}',
          chapterListSelector: { type: 'css', value: '.layout-col1' },
          chapterTitleSelector: { type: 'css', value: 'a[href*=".html"]' },
          chapterLinkSelector: { type: 'css', value: 'a[href*=".html"]' },
          contentSelector: { type: 'css', value: '#container .layout-col1' },
          antiCrawlConfig: { useJsRender: true, uaRotation: true, delay: [2000, 5000], headers: { Referer: 'http://23.225.66.244/' } },
          cleanConfig: { removeAds: true, removePatterns: ['.reader-fun', '.select', '.footer', '.m-footer', '.m-setting', '.topbar', 'script', 'style', '.pc-novel', '.row-section', '.detail-box'], adPatterns: ['本章未完，点击下一页继续', '手机用户请浏览阅读', '请记住本书首发域名', '最快更新', '无弹窗小说'] },
          scrapeMode: 'full',
          engine: 'playwright',
          coverSavePath: '/app/public/covers/23ip/',
          threadCount: 1,
          minDelay: 3000,
          maxDelay: 6000,
          enableShuffle: true,
          dedupMode: 'url',
        },
      ];
      const res = await apiFetch<{ created: number; updated: number }>('/api/scrape-rules/import', {
        method: 'POST',
        body: JSON.stringify({ rules }),
      });
      setScrapeImportResult(`成功：新建 ${res.created}，更新 ${res.updated}`);
      setScrapeRuleCount((prev) => (prev ?? 0) + res.created);
      const store = useAppStore.getState();
      store.triggerRefresh('dashboard');
    } catch {
      setScrapeImportResult('导入失败，请重试');
    } finally {
      setScrapeRuleLoading(false);
    }
  }, []);

  // ─── Quick actions ─────────────────────────────────────────────────────
  const handleCreateNovel = useCallback(() => {
    setEditingNovel(null);
    setNovelFormOpen(true);
  }, [setEditingNovel, setNovelFormOpen]);

  const handleViewNovel = useCallback((novel: Novel) => {
    selectNovel(novel);
    setCurrentView('novel-detail');
  }, [selectNovel, setCurrentView]);

  const handleQuickAction = useCallback((action: QuickActionItem) => {
    if (action.view === 'createNovel') {
      handleCreateNovel();
    } else {
      setCurrentView(action.view);
    }
  }, [handleCreateNovel, setCurrentView]);

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
              <Card key={i} className="card-elevated card-glass">
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
            <ReadingHeatmap />
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

      {/* ── Activity Feed ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ActivityFeed />
      </div>

      {/* ── Scrape Rules Quick Actions ──────────────────────────────── */}
      <Card className="card-glass">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4 text-violet-500" />
              采集规则
            </CardTitle>
            <Badge variant="secondary" className="font-normal tabular-nums">
              {scrapeRuleCount ?? '...'} 条规则
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={handleImportPresetRules}
              disabled={scrapeRuleLoading}
            >
              <Download className="h-3.5 w-3.5" />
              {scrapeRuleLoading ? '导入中...' : '导入预设规则'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => setCurrentView('scrape')}
            >
              管理规则
              <ArrowUpRight className="h-3 w-3" />
            </Button>
            {scrapeImportResult && (
              <span className="text-xs text-muted-foreground ml-1">{scrapeImportResult}</span>
            )}
          </div>
        </CardContent>
      </Card>

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
