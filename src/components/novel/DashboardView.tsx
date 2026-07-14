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
import { useAppStore } from '@/stores/app-store';
import { NOVEL_STATUS_MAP } from '@/lib/constants';
import type { DashboardStats, NovelStatus } from '@/types';

const statusChartColors: Record<string, string> = {
  ongoing: '#10b981',
  completed: '#f59e0b',
  hiatus: '#94a3b8',
};

const chartConfig: ChartConfig = {
  count: {
    label: '数量',
    color: '#10b981',
  },
};

// ─── Stat card data ───────────────────────────────────────────────────────────
const statCards = [
  { key: 'totalNovels', label: '小说总数', icon: BookOpen, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
  { key: 'totalChapters', label: '章节总数', icon: FileText, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20' },
  { key: 'totalWords', label: '总字数', icon: Hash, color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-900/20' },
  { key: 'totalCategories', label: '分类总数', icon: FolderTree, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20' },
  { key: 'totalTags', label: '标签总数', icon: Tags, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20' },
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
      const res = await fetch('/api/dashboard');
      if (!res.ok) throw new Error('获取仪表盘数据失败');
      const data: DashboardStats = await res.json();
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

  // ─── Chart data ───────────────────────────────────────────────────────────
  const chartData = stats?.statusDistribution.map((item) => ({
    name: NOVEL_STATUS_MAP[item.status]?.label ?? item.status,
    status: item.status,
    count: item.count,
    fill: statusChartColors[item.status] ?? '#94a3b8',
  })) ?? [];

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
              return (
                <Card key={card.key} className="overflow-hidden transition-all duration-200 hover:shadow-md hover:-translate-y-0.5">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${card.bg}`}>
                        <Icon className={`h-6 w-6 ${card.color}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-muted-foreground">{card.label}</p>
                        <p className="text-2xl font-bold tabular-nums">{value.toLocaleString()}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* ── Status Distribution + Recent Novels ─────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Status Distribution Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              状态分布
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[200px] w-full" />
            ) : chartData.length === 0 ? (
              <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
                暂无数据
              </div>
            ) : (
              <ChartContainer config={chartConfig} className="h-[200px] w-full">
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
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={28}>
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

      {/* ── Quick Actions ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* 新建小说 */}
        <Card
          className="cursor-pointer transition-all duration-200 hover:shadow-md hover:border-primary/20"
          onClick={handleCreateNovel}
        >
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30">
              <BookOpen className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-medium">新建小说</p>
              <p className="text-xs text-muted-foreground">创建新的小说作品</p>
            </div>
          </CardContent>
        </Card>

        {/* 采集任务 */}
        <Card
          className="cursor-pointer transition-all duration-200 hover:shadow-md hover:border-primary/20"
          onClick={() => setCurrentView('scrape')}
        >
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
              <Bug className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-sm font-medium">采集任务</p>
              <p className="text-xs text-muted-foreground">管理采集规则与任务</p>
            </div>
          </CardContent>
        </Card>

        {/* 管理分类 */}
        <Card
          className="cursor-pointer transition-all duration-200 hover:shadow-md hover:border-primary/20"
          onClick={() => setCurrentView('categories')}
        >
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-900/30">
              <FolderTree className="h-5 w-5 text-violet-600 dark:text-violet-400" />
            </div>
            <div>
              <p className="text-sm font-medium">管理分类</p>
              <p className="text-xs text-muted-foreground">整理小说分类体系</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Recent Activity ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-5 w-5 text-muted-foreground" />
            最近活动
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative space-y-0">
            {[
              { icon: BookOpen, text: '创建了小说《示例小说》', time: '2小时前' },
              { icon: FileText, text: '更新了3个章节', time: '5小时前' },
              { icon: FolderTree, text: '新增分类「玄幻」', time: '1天前' },
            ].map((item, i) => {
              const ItemIcon = item.icon;
              return (
                <div key={i} className="relative flex items-start gap-3 pb-6 last:pb-0">
                  {/* Timeline line */}
                  {i < 2 && (
                    <div className="absolute left-[15px] top-9 h-[calc(100%-12px)] w-px bg-border" />
                  )}
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    <ItemIcon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="text-sm">{item.text}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.time}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 border-t pt-3">
            <button className="text-sm text-muted-foreground transition-colors hover:text-foreground">
              查看全部 →
            </button>
          </div>
        </CardContent>
      </Card>

      {/* ── Error ───────────────────────────────────────────────────────── */}
      {error && (
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