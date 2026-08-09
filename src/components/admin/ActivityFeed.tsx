'use client';

import { useState, useEffect, useCallback } from 'react';
import { BookOpen, FileText, Zap } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { formatRelativeTime } from '@/lib/format';
import { useAppStore } from '@/stores/app-store';
import { Skeleton } from '@/components/ui/skeleton';
import type { Novel } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────────

interface ActivityItem {
  id: string;
  type: 'novel_updated' | 'chapter_created' | 'task_created' | 'task_completed' | 'task_failed';
  title: string;
  description: string;
  timestamp: string;
  link?: string;
  meta?: { [key: string]: string | number };
}

interface ActivityResponse {
  activities: ActivityItem[];
}

// ─── Helpers ────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<ActivityItem['type'], { icon: typeof BookOpen; dotClass: string }> = {
  novel_updated: { icon: BookOpen, dotClass: 'bg-blue-500' },
  chapter_created: { icon: FileText, dotClass: 'bg-chart-emerald' },
  task_created: { icon: Zap, dotClass: 'bg-chart-amber' },
  task_completed: { icon: Zap, dotClass: 'bg-chart-emerald' },
  task_failed: { icon: Zap, dotClass: 'bg-destructive' },
};

function extractNovelId(link: string | undefined): string | null {
  if (!link) return null;
  const match = link.match(/\/novels\/([^/]+)/);
  return match ? match[1] : null;
}

// ─── Component ──────────────────────────────────────────────────────────

export function ActivityFeed() {
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectNovel = useAppStore((s) => s.selectNovel);
  const setCurrentView = useAppStore((s) => s.setCurrentView);

  const fetchActivities = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiFetch<ActivityResponse>('/api/admin/activity', { signal, silent: true });
      if (!signal?.aborted) {
        queueMicrotask(() => setActivities(data.activities));
      }
    } catch (err) {
      if (!signal?.aborted) {
        queueMicrotask(() => setError(err instanceof Error ? err.message : '获取活动失败'));
      }
    } finally {
      if (!signal?.aborted) {
        queueMicrotask(() => setLoading(false));
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchActivities(controller.signal);
    return () => { controller.abort(); };
  }, [fetchActivities]);

  const handleClick = useCallback((item: ActivityItem) => {
    const novelId = extractNovelId(item.link);
    if (novelId) {
      selectNovel({ id: novelId } as Novel);
      setCurrentView('novel-detail');
    }
  }, [selectNovel, setCurrentView]);

  // ─── Loading skeleton ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="card-subtle rounded-xl p-4">
        <h3 className="mb-3 text-sm font-medium">系统动态</h3>
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="h-4 w-4 rounded-full shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ─── Error state ──────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="card-subtle rounded-xl p-4">
        <h3 className="mb-2 text-sm font-medium">系统动态</h3>
        <p className="text-xs text-muted-foreground">{error}</p>
      </div>
    );
  }

  // ─── Empty state ──────────────────────────────────────────────────────
  if (activities.length === 0) {
    return (
      <div className="card-subtle rounded-xl p-4">
        <h3 className="mb-2 text-sm font-medium">系统动态</h3>
        <p className="text-xs text-muted-foreground">暂无活动记录</p>
      </div>
    );
  }

  // ─── Feed ─────────────────────────────────────────────────────────────
  return (
    <div className="card-subtle rounded-xl p-4">
      <h3 className="mb-3 text-sm font-medium">系统动态</h3>
      <div className="max-h-96 overflow-y-auto scrollbar-compact">
        <div className="border-l-2 border-border ml-[7px]">
          {activities.map((item) => {
            const config = TYPE_CONFIG[item.type];
            const Icon = config.icon;
            const clickable = !!extractNovelId(item.link);

            return (
              <div
                key={item.id}
                className={`relative flex items-start gap-3 py-2 pr-1 pl-4 -ml-[9px] rounded-md transition-colors ${clickable ? 'list-hover-highlight cursor-pointer' : ''}`}
                onClick={clickable ? () => handleClick(item) : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(item); } } : undefined}
              >
                {/* Timeline dot */}
                <div className={`absolute -left-[5px] top-3 h-2.5 w-2.5 rounded-full ${config.dotClass} ring-2 ring-background`} />
                {/* Icon */}
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm leading-snug">{item.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.description}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground/70">{formatRelativeTime(item.timestamp)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
