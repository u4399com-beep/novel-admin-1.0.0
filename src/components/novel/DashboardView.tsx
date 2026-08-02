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
  Bug,
  Sparkles,
  Tags,
  Activity,
  PlusCircle,
  Globe,
  Upload,
  BarChart3,
  CheckCircle2,
  ArrowUpRight,
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
  ResponsiveContainer,
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
  type ChartConfig,
} from '@/components/ui/chart';
import { apiFetch } from '@/lib/api-fetch';
import { useAppStore } from '@/stores/app-store';
import { NOVEL_STATUS_MAP } from '@/lib/constants';
import type { DashboardStats, NovelStatus, ViewType } from '@/types';

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

// TODO: Connect to real activity data API
const activityChartConfig: ChartConfig = {
  chapters: {
    label: '新增章节',
    color: '#a78bfa',
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
const quickActionItems = [
  { key: 'create-novel', label: '新建小说', desc: '创建新的小说作品', icon: PlusCircle, view: 'createNovel' as const },
  { key: 'scrape-rules', label: '采集规则', desc: '管理采集规则与任务', icon: Globe, view: 'scrape' as const },
  { key: 'import-categories', label: '导入分类', desc: '整理小说分类体系', icon: Upload, view: 'categories' as const },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────
export function DashboardView() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
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
      const data: DashboardStats = await apiFetch('/api/dashboard');
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
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

  // ─── Placeholder 7-day activity data ────────────────────────────────────
  // TODO: Connect to real activity data API
  const activityData = useMemo(() => {
    const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const now = new Date();
    return days.map((day, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      const month = d.getMonth() + 1;
      const date = d.getDate();
      // Placeholder: simulate some variation
      const base = stats?.totalChapters ? Math.floor(stats.totalChapters / 30) : 3;
      const count = Math.max(0, base + Math.floor(Math.sin(i * 1.5) * 2) + (i === 3 ? 4 : 0));
      return {
        name: `${month}/${date}`,
        day,
        chapters: count,
      };
    });
  }, [stats?.totalChapters]);

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
          ) : (
            <ChartContainer config={activityChartConfig} className="h-[180px] w-full">
              <AreaChart data={activityData} margin={{ left: 0, right: 10, top: 5, bottom: 5 }}>
                <defs>
                  <linearGradient id="chapterGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#a78bfa" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
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
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="monotone"
                  dataKey="chapters"
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
            <div className="flex flex-wrap gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-32 rounded-md" />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              {quickActionItems.map((action) => {
                const Icon = action.icon;
                return (
                  <Button
                    key={action.key}
                    variant="outline"
                    className="h-10 gap-2"
                    onClick={() => handleQuickAction(action)}
                  >
                    <Icon className="h-4 w-4" />
                    {action.label}
                  </Button>
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
          ) : !stats?.recentNovels.length ? (
            <div className="flex py-8 items-center justify-center text-sm text-muted-foreground">
              暂无最近活动
            </div>
          ) : (
            <div className="relative space-y-0">
              {stats.recentNovels.slice(0, 5).map((novel, i) => {
                const statusInfo = NOVEL_STATUS_MAP[novel.status as NovelStatus] ?? NOVEL_STATUS_MAP.ongoing;
                const isLast = i === Math.min(stats.recentNovels.length, 5) - 1;
                return (
                  <div key={novel.id} className="relative flex items-start gap-3 pb-6 last:pb-0 group">
                    {/* Timeline line */}
                    {!isLast && (
                      <div className="absolute left-[15px] top-9 h-[calc(100%-12px)] w-px bg-border" />
                    )}
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted group-hover:bg-violet-100 dark:group-hover:bg-violet-900/30 transition-colors">
                      <BookOpen className="h-4 w-4 text-muted-foreground group-hover:text-violet-600 dark:group-hover:text-violet-400 transition-colors" />
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="text-sm">
                        <span className="font-medium">{novel.title}</span>
                        <span className="text-muted-foreground"> 由 </span>
                        <span className="font-medium">{novel.author}</span>
                        <span className="text-muted-foreground"> 更新</span>
                        <Badge variant="secondary" className={`ml-2 text-[10px] px-1.5 py-0 ${statusInfo.className}`}>
                          {statusInfo.label}
                        </Badge>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {safeFormatDate(novel.updatedAt, (d) => formatDistanceToNow(d, {
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
          <div className="mt-2 border-t pt-3">
            <button className="text-sm text-muted-foreground transition-colors hover:text-foreground" onClick={() => setCurrentView('novels')}>
              查看全部 →
            </button>
          </div>
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