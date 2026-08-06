'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { DashboardStats, ViewType } from '@/types';
import {
  BookOpen,
  FileText,
  Hash,
  FolderTree,
  Tags,
  Heart,
} from 'lucide-react';

export interface StatCardConfig {
  key: keyof DashboardStats;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bg: string;
  view: ViewType;
}

export const statCards: StatCardConfig[] = [
  { key: 'totalNovels', label: '小说总数', icon: BookOpen, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', view: 'novels' },
  { key: 'totalChapters', label: '章节总数', icon: FileText, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', view: 'novels' },
  { key: 'totalWords', label: '总字数', icon: Hash, color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-900/20', view: 'novels' },
  { key: 'totalCategories', label: '分类总数', icon: FolderTree, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', view: 'categories' },
  { key: 'totalTags', label: '标签总数', icon: Tags, color: 'text-teal-600 dark:text-teal-400', bg: 'bg-teal-50 dark:bg-teal-900/20', view: 'tags' },
  { key: 'totalFavorites', label: '总收藏数', icon: Heart, color: 'text-red-500 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', view: 'novels' },
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
      className="cursor-pointer overflow-hidden transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 card-primary-glow card-border-glow hover-lift tap-feedback depth-hover hover-scale-sm card-depth card-glass"
      onClick={() => onClick(card.view)}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${card.bg}`}>
            <Icon className={`h-6 w-6 ${card.color}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="text-2xl font-bold tabular-nums counter-animate count-animate stat-value">{displayValue}</p>
            {trend && <div className="mt-0.5">{trend}</div>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
