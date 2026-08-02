'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BookOpen,
  FileText,
  Hash,
  FolderTree,
  TrendingUp,
  User,
  Clock,
  ArrowRight,
  Sparkles,
  Tags,
  Activity,
  PlusCircle,
  Globe,
  BarChart3,
  CheckCircle2,
  ArrowUpRight,
  Settings,
  Server,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { safeFormatDate } from '@/lib/format';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
  AreaChart,
  Area,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { apiFetch } from '@/lib/api-fetch';
import { useAppStore } from '@/stores/app-store';
import { NOVEL_STATUS_MAP } from '@/lib/constants';
import type { DashboardStats, NovelStatus, ViewType } from '@/types';

// ─── Activity API types ─────────────────────────────────────────────────────
interface ActivityData {
  dailyActivity: {
    date: string;
    novelsCreated: number;
    chaptersCreated: number;
    scrapeRuns: number;
  }[];
  recentEvents: {
    type: string;
    title: string;
    novelTitle?: string | null;
    timestamp: string;
  }[];
}

const statusChartColors: Record<string, string> = {
  ongoing: '#10b981',
  completed: '#f59e0b',
  hiatus: '#94a3b8',
};

const statusChartConfig: ChartConfig = {
  count: {
    label: '数量',
    color: '#10b981',
  },
};

const activityChartConfig: ChartConfig = {
  chaptersCreated: {
    label: '章节更新',
    color: '#a78bfa',
  },
  novelsCreated: {
    label: '新增小说',
    color: '#10b981',
  },
  scrapeRuns: {
    label: '采集任务',
    color: '#f59e0b',
  },
};

// ─── Stat card data ───────────────────────────────────────────────────────────
const statCards = [
  { key: 'totalNovels', label: '小说总数', icon: BookOpen, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', view: 'novels' as ViewType },
  { key: 'totalChapters', label: '章节总数', icon: FileText, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', view: 'novels' as ViewType },
  { key: 'totalWords', label: '总字数', icon: Hash, color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-900/20', view: 'novels' as ViewType },
  { key: 'totalCategories', label: '分类总数', icon: FolderTree, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', view: 'categories' as ViewType },
  { key: 'totalTags', label: '标签总数', icon: Tags, color: 'text-teal-600 dark:text-teal-400', bg: 'bg-teal-50 dark:bg-teal-900/20', view: 'tags' as ViewType },
] as const;

// ─── Quick action items ───────────────────────────────────────────────────────
interface QuickActionItem {
  key: string;
  label: string;
  desc: string;
  icon: typeof PlusCircle;
  view: ViewType | 'createNovel';
  color: string;
  bg: string;
}

const quickActionItems: QuickActionItem[] = [
  { key: 'create-novel', label: '新建小说', desc: '创建新的小说作品', icon: PlusCircle, view: 'createNovel', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
  { key: 'scrape-rules', label: '采集规则', desc: '管理采集规则与任务', icon: Globe, view: 'scrape', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20' },
  { key: 'categories', label: '分类管理', desc: '整理小说分类体系', icon: FolderTree, view: 'categories', color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20' },
  { key: 'sites', label: '站点管理', desc: '管理站点与主题配置', icon: Server, view: 'sites', color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-900/20' },
  { key: 'settings', label: '系统设置', desc: '配置系统参数与选项', icon: Settings, view: 'settings', color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-800/50' },
];

// ─── Event metadata helper ──────────────────────────────────────────────────
function getEventMeta(type: string) {
  switch (type) {
    case 'novel_created':
      return {
        icon: PlusCircle,
        color: 'text-emerald-600 dark:text-emerald-400',
        hoverBg: 'group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/30',
        label: '创建小说 ',
      };
    case 'chapter_added':
      return {
        icon: FileText,
        color: 'text-violet-600 dark:text-violet-400',
        hoverBg: 'group-hover:bg-violet-100 dark:group-hover:bg-violet-900/30',
        label: '新增章节 ',
      };
    case 'scrape_run':
      return {
        icon: Globe,
        color: 'text-amber-600 dark:text-amber-400',
        hoverBg: 'group-hover:bg-amber-100 dark:group-hover:bg-amber-900/30',
        label: '执行采集 ',
      };
    default:
      return {
        icon: Activity,
        color: 'text-muted-foreground',
        hoverBg: '',
        label: '',
      };
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export function DashboardView() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activityData, setActivityData] = useState<ActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshDashboard = useAppStore((s) => s.refreshVersions['dashboard'] ?? 0);
  const selectNovel = useAppStore((s) => s.selectNovel);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setEditingNovel = useAppStore((s) => s.setEditingNovel);
  const setNovelFormOpen = useAppStore((s) => s.setNovelFormOpen);

  const fetchDashboard = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [statsRes, activityRes] = await Promise.allSettled([
        apiFetch<DashboardStats>('/api/dashboard'),
        apiFetch<ActivityData>('/api/dashboard/activity'),
      ]);
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value);
      } else {
        setError(statsRes.reason instanceof Error ? statsRes.reason.message : '未知错误');
      }
      if (activityRes.status === 'fulfilled') {
        setActivityData(activityRes.value);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard, refreshDashboard]);

  // ─── Quick actions ─────────────────────────────────────────────────────
  const handleCreateNovel = () => {
    setEditingNovel(null);
    setNovelFormOpen(true);
  };

  const handleViewNovel = (novel: DashboardStats['recentNovels'][number]) => {
    selectNovel(novel);
    setCurrentView('novel-detail');
  };

  const handleQuickAction = (action: typeof quickActionItems[number]) => {
    if (action.view === 'createNovel') {
      handleCreateNovel();
    } else {
      setCurrentView(action.view);
    }
  };

  // ─── Chart data ───────────────────────────────────────────────────────────
  const chartData = stats?.statusDistribution.map((item) => ({
    name: NOVEL_STATUS_MAP[item.status]?.label ?? item.status,
    status: item.status,
    count: item.count,
    fill: statusChartColors[item.status] ?? '#94a3b8',
  })) ?? [];

  // ─── Trend indicators ─────────────────────────────────────────────────────
  const trendData = useMemo(() => {
    if (!stats) return { completedCount: 0, avgChapters: 0, avgWords: 0 };
    const completedEntry = stats.statusDistribution.find((s) => s.status === 'completed');
    const completedCount = completedEntry?.count ?? 0;
    const avgChapters = stats.totalNovels > 0 ? Math.round(stats.totalChapters / stats.totalNovels) : 0;
    const avgWords = stats.totalNovels > 0 ? Math.round(stats.totalWords / stats.totalNovels) : 0;
    return { completedCount, avgChapters, avgWords };
  }, [stats]);

  // ─── 7-day activity chart data (from real API) ─────────────────────────
  const chartActivityData = useMemo(() => {
    if (!activityData?.dailyActivity.length) return [];
    return activityData.dailyActivity.map((d) => {
      const date = new Date(d.date + 'T00:00:00Z');
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      return {
        name: `${month}/${day}`,
        novelsCreated: d.novelsCreated,
        chaptersCreated: d.chaptersCreated,
        scrapeRuns: d.scrapeRuns,
      };
    });
  }, [activityData]);

  // ─── Welcome card helpers ─────────────────────────────────────────────
  const { greeting, dateStr } = useMemo(() => {
    const hour = new Date().getHours();
    let greeting: string;
    if (hour >= 6 && hour < 12) greeting = '早上好';
    else if (hour >= 12 && hour < 18) greeting = '下午好';
    else greeting = '晚上好';
    const dateStr = new Date().toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    });
    return { greeting, dateStr };
  }, []);

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
            <Sparkles className="h-6 w-6 text-emerald-500" />
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <button
                type="button"
                className="group flex flex-col items-center gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-1 dark:border-emerald-800/40 dark:bg-emerald-950/30"
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
                className="group flex flex-col items-center gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-1 dark:border-emerald-800/40 dark:bg-emerald-950/30"
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
                className="group flex flex-col items-center gap-3 rounded-xl border border-emerald-200/60 bg-white/80 p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-1 dark:border-emerald-800/40 dark:bg-emerald-950/30"
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}>
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
              <Button variant="outline" size="sm" className="mt-3" onClick={fetchDashboard}>
                重试
              </Button>
            </div>
          ) : statCards.map((card) => {
              const Icon = card.icon;
              const value = stats?.[card.key] ?? 0;
              const trend = getTrendIndicator(card.key);
              const displayValue = card.key === 'totalWords'
                ? value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value.toLocaleString()
                : value.toLocaleString();
              return (
                <Card
                  key={card.key}
                  className="cursor-pointer overflow-hidden transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/20"
                  onClick={() => setCurrentView(card.view)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${card.bg}`}>
                        <Icon className={`h-6 w-6 ${card.color}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-muted-foreground">{card.label}</p>
                        <p className="text-2xl font-bold tabular-nums">{displayValue}</p>
                        {trend && <div className="mt-0.5">{trend}</div>}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* ── Status Distribution + Recent Novels ─────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Status Distribution Chart — Clickable */}
        <Card className="cursor-pointer transition-all duration-200 hover:shadow-md hover:border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              状态分布
              <span className="ml-auto text-xs font-normal text-muted-foreground">点击查看详情</span>
            </CardTitle>
          </CardHeader>
          <CardContent onClick={() => setCurrentView('novels')}>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-4 w-14" />
                    <Skeleton className="h-6 flex-1 rounded-full" />
                    <Skeleton className="h-4 w-8" />
                  </div>
                ))}
              </div>
            ) : chartData.length === 0 ? (
              <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
                暂无数据
              </div>
            ) : (
              <ChartContainer config={statusChartConfig} className="h-[200px] w-full">
                <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 20, top: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    tickLine={false}
                    axisLine={false}
                    width={60}
                    fontSize={12}
                  />
                  <XAxis type="number" tickLine={false} axisLine={false} fontSize={12} />
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={28} cursor="pointer">
                    {chartData.map((entry, index) => (
                      <Cell key={index} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Recent Novels */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-5 w-5 text-muted-foreground" />
              最近更新
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  </div>
                ))}
              </div>
            ) : !stats?.recentNovels.length ? (
              <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
                暂无小说
              </div>
            ) : (
              <div className="max-h-[280px] space-y-1 overflow-y-auto pr-1">
                {stats.recentNovels.map((novel) => {
                  const statusInfo = NOVEL_STATUS_MAP[novel.status as NovelStatus] ?? NOVEL_STATUS_MAP.ongoing;
                  return (
                    <div
                      key={novel.id}
                      className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700">
                        <BookOpen className="h-5 w-5 text-slate-500 dark:text-slate-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{novel.title}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <User className="h-3 w-3" />
                            {novel.author}
                          </span>
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3" />
                            {novel._count?.chapters ?? 0} 章
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {safeFormatDate(novel.updatedAt, (d) => formatDistanceToNow(d, {
                              addSuffix: true,
                              locale: zhCN,
                            }))}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="secondary" className={statusInfo.className}>
                          {statusInfo.label}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => handleViewNovel(novel)}
                        >
                          查看详情
                          <ArrowRight className="ml-1 h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 7-Day Activity Chart ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            近 7 天活动
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-4">
              <div className="flex items-end justify-between gap-2">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} className="h-[120px] flex-1 rounded-t-md" style={{ height: `${60 + Math.sin(i * 1.5) * 30 + 30}px` }} />
                ))}
              </div>
              <div className="flex justify-between">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} className="h-3 w-8" />
                ))}
              </div>
            </div>
          ) : chartActivityData.length === 0 ? (
            <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
              <div className="text-center">
                <BarChart3 className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
                <p>暂无数据</p>
              </div>
            </div>
          ) : (
            <ChartContainer config={activityChartConfig} className="h-[250px] w-full">
              <AreaChart data={chartActivityData} margin={{ left: 0, right: 10, top: 5, bottom: 0 }}>
                <defs>
                  <linearGradient id="chapterGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#a78bfa" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="novelGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="scrapeGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} strokeOpacity={0.15} />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
                  allowDecimals={false}
                  label={{
                    value: '数量',
                    angle: -90,
                    position: 'insideLeft',
                    offset: -2,
                    style: { fontSize: 12, fill: 'hsl(var(--muted-foreground))' },
                  }}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend
                  content={<ChartLegendContent nameKey="name" />}
                />
                <Area
                  type="monotone"
                  dataKey="scrapeRuns"
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                  fill="url(#scrapeGradient)"
                  dot={false}
                  activeDot={{ r: 4, fill: '#f59e0b', strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                />
                <Area
                  type="monotone"
                  dataKey="novelsCreated"
                  stroke="#10b981"
                  strokeWidth={1.5}
                  fill="url(#novelGradient)"
                  dot={false}
                  activeDot={{ r: 4, fill: '#10b981', strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                />
                <Area
                  type="monotone"
                  dataKey="chaptersCreated"
                  stroke="#a78bfa"
                  strokeWidth={2}
                  fill="url(#chapterGradient)"
                  dot={{ r: 4, fill: '#a78bfa', strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                  activeDot={{ r: 6, fill: '#a78bfa', strokeWidth: 2, stroke: 'hsl(var(--background))' }}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Quick Actions ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            快捷操作
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
                  <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {quickActionItems.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.key}
                    type="button"
                    className="group flex items-center gap-3 rounded-lg border p-3 text-left transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/20"
                    onClick={() => handleQuickAction(action)}
                  >
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${action.bg} transition-transform duration-200 group-hover:scale-110`}>
                      <Icon className={`h-5 w-5 ${action.color}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{action.label}</p>
                      <p className="text-xs text-muted-foreground truncate">{action.desc}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/0 transition-all duration-200 group-hover:text-muted-foreground" />
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Recent Activity (Real Data) ─────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-5 w-5 text-muted-foreground" />
            最近活动
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3">
                  <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
              ))}
            </div>
          ) : !activityData?.recentEvents.length ? (
            <div className="flex py-8 items-center justify-center text-sm text-muted-foreground">
              暂无最近活动
            </div>
          ) : (
            <div className="relative space-y-0">
              {activityData.recentEvents.map((event, i) => {
                const isLast = i === activityData.recentEvents.length - 1;
                const { icon: EventIcon, color: iconColor, hoverBg, label } = getEventMeta(event.type);
                return (
                  <div key={`${event.type}-${event.timestamp}-${i}`} className="relative flex items-start gap-3 pb-6 last:pb-0 group">
                    {!isLast && (
                      <div className="absolute left-[15px] top-9 h-[calc(100%-12px)] w-px bg-border" />
                    )}
                    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted ${hoverBg} transition-colors`}>
                      <EventIcon className={`h-4 w-4 text-muted-foreground ${iconColor} transition-colors`} />
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="text-sm">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium">{event.title}</span>
                        {event.novelTitle && (
                          <span className="text-muted-foreground"> · {event.novelTitle}</span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {safeFormatDate(event.timestamp, (d) => formatDistanceToNow(d, {
                          addSuffix: true,
                          locale: zhCN,
                        }))}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!loading && activityData?.recentEvents.length ? (
            <div className="mt-2 border-t pt-3">
              <button className="text-sm text-muted-foreground transition-colors hover:text-foreground" onClick={() => setCurrentView('novels')}>
                查看全部 →
              </button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {error && !stats && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-destructive">
            {error}
            <Button variant="outline" size="sm" className="ml-auto" onClick={fetchDashboard}>
              重试
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}