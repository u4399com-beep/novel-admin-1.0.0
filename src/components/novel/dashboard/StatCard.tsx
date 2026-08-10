'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { DashboardStats, ViewType } from '@/types';
import {
  BookOpen,
  FileText,
  FolderTree,
  Tags,
  Heart,
  Layers,
} from 'lucide-react';

export interface StatCardConfig {
  key: keyof DashboardStats;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bg: string;
  view: ViewType;
  gradient: string;
  trendValue: string;
  trendUp: boolean;
}

export const statCards: StatCardConfig[] = [
  { key: 'totalNovels', label: '小说总数', icon: BookOpen, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', view: 'novels', gradient: 'from-emerald-500/5 via-emerald-50/50 to-transparent dark:from-emerald-500/10 dark:via-emerald-950/30 dark:to-transparent', trendValue: '12%', trendUp: true },
  { key: 'totalChapters', label: '章节总数', icon: Layers, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', view: 'novels', gradient: 'from-amber-500/5 via-amber-50/50 to-transparent dark:from-amber-500/10 dark:via-amber-950/30 dark:to-transparent', trendValue: '8%', trendUp: true },
  { key: 'totalWords', label: '总字数', icon: FileText, color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-900/20', view: 'novels', gradient: 'from-violet-500/5 via-violet-50/50 to-transparent dark:from-violet-500/10 dark:via-violet-950/30 dark:to-transparent', trendValue: '15%', trendUp: true },
  { key: 'totalCategories', label: '分类总数', icon: FolderTree, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', view: 'categories', gradient: 'from-rose-500/5 via-rose-50/50 to-transparent dark:from-rose-500/10 dark:via-rose-950/30 dark:to-transparent', trendValue: '3%', trendUp: false },
  { key: 'totalTags', label: '标签总数', icon: Tags, color: 'text-teal-600 dark:text-teal-400', bg: 'bg-teal-50 dark:bg-teal-900/20', view: 'tags', gradient: 'from-teal-500/5 via-teal-50/50 to-transparent dark:from-teal-500/10 dark:via-teal-950/30 dark:to-transparent', trendValue: '5%', trendUp: true },
  { key: 'totalFavorites', label: '总收藏数', icon: Heart, color: 'text-red-500 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', view: 'novels', gradient: 'from-red-500/5 via-red-50/50 to-transparent dark:from-red-500/10 dark:via-red-950/30 dark:to-transparent', trendValue: '20%', trendUp: true },
] as const;

interface StatCardProps {
  card: StatCardConfig;
  stats: DashboardStats | null;
  trend: React.ReactNode | null;
  onClick: (view: ViewType) => void;
}

export function StatCard({ card, stats, trend, onClick }: StatCardProps) {
  const Icon = card.icon;
  const raw = stats?.[card.key] ?? 0;
  const value = typeof raw === 'number' ? raw : 0;
  const displayValue = card.key === 'totalWords'
    ? value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value.toLocaleString()
    : value.toLocaleString();

  return (
    <Card
      className={`card-elevated cursor-pointer overflow-hidden transition-all duration-200 hover:shadow-md hover:scale-[1.02] card-primary-glow card-border-glow hover-lift tap-feedback depth-hover card-depth card-glass bg-gradient-to-br ${card.gradient}`}
      onClick={() => onClick(card.view)}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${card.bg} shadow-sm`}>
            <Icon className={`h-6 w-6 ${card.color}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{card.label}</p>
              <span className={`flex items-center text-[11px] font-medium ${card.trendUp ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                ↑ {card.trendValue}
              </span>
            </div>
            <p className="text-2xl font-bold tabular-nums counter-animate count-animate stat-value">{displayValue}</p>
            {trend && <div className="mt-0.5">{trend}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
