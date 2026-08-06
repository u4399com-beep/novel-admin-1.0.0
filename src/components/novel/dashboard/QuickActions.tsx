'use client';

import { ArrowRight, PlusCircle, Globe, FolderTree, Server, Settings, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

import type { ViewType } from '@/types';

export interface QuickActionItem {
  key: string;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  view: ViewType | 'createNovel';
  color: string;
  bg: string;
}

export const quickActionItems: QuickActionItem[] = [
  { key: 'create-novel', label: '新建小说', desc: '创建新的小说作品', icon: PlusCircle, view: 'createNovel', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
  { key: 'scrape-rules', label: '采集规则', desc: '管理采集规则与任务', icon: Globe, view: 'scrape', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20' },
  { key: 'categories', label: '分类管理', desc: '整理小说分类体系', icon: FolderTree, view: 'categories', color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20' },
  { key: 'sites', label: '站点管理', desc: '管理站点与主题配置', icon: Server, view: 'sites', color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-900/20' },
  { key: 'settings', label: '系统设置', desc: '配置系统参数与选项', icon: Settings, view: 'settings', color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-800/50' },
];

interface QuickActionsProps {
  loading: boolean;
  onAction: (action: QuickActionItem) => void;
}

export function QuickActions({ loading, onAction }: QuickActionsProps) {
  return (
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 stagger-in">
            {quickActionItems.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  key={action.key}
                  type="button"
                  className="group flex items-center gap-3 rounded-lg border p-3 text-left transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/20 card-depth appear-smooth"
                  onClick={() => onAction(action)}
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
  );
}
