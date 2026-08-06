'use client';

import { Activity } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { safeFormatDate } from '@/lib/format';
import {
  PlusCircle,
  FileText,
  Globe,
} from 'lucide-react';

interface RecentEvent {
  type: string;
  title: string;
  novelTitle?: string | null;
  timestamp: string;
}

interface ActivityData {
  dailyActivity: {
    date: string;
    novelsCreated: number;
    chaptersCreated: number;
    scrapeRuns: number;
  }[];
  recentEvents: RecentEvent[];
}

// Cache event meta objects to avoid creating new objects on each call
const EVENT_META_MAP: Record<string, { icon: typeof PlusCircle; color: string; hoverBg: string; label: string }> = {
  novel_created: {
    icon: PlusCircle,
    color: 'text-emerald-600 dark:text-emerald-400',
    hoverBg: 'group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/30',
    label: '创建小说 ',
  },
  chapter_added: {
    icon: FileText,
    color: 'text-violet-600 dark:text-violet-400',
    hoverBg: 'group-hover:bg-violet-100 dark:group-hover:bg-violet-900/30',
    label: '新增章节 ',
  },
  scrape_run: {
    icon: Globe,
    color: 'text-amber-600 dark:text-amber-400',
    hoverBg: 'group-hover:bg-amber-100 dark:group-hover:bg-amber-900/30',
    label: '执行采集 ',
  },
};
const DEFAULT_EVENT_META = {
  icon: Activity,
  color: 'text-muted-foreground',
  hoverBg: '',
  label: '',
};

function getEventMeta(type: string) {
  return EVENT_META_MAP[type] || DEFAULT_EVENT_META;
}

export type { ActivityData, RecentEvent };

interface RecentActivityProps {
  loading: boolean;
  activityData: ActivityData | null;
  activityError: boolean;
  onRetry: () => void;
  onViewAll: () => void;
}

export function RecentActivity({
  loading,
  activityData,
  activityError,
  onRetry,
  onViewAll,
}: RecentActivityProps) {
  return (
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
                <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-48 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-20 rounded bg-muted animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : activityError ? (
          <div className="flex py-8 flex-col items-center justify-center text-sm text-muted-foreground">
            <p>活动数据加载失败</p>
            <button
              className="mt-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline transition-colors"
              disabled={loading} onClick={onRetry}
            >
              重试
            </button>
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
            <button className="text-sm text-muted-foreground transition-colors hover:text-foreground" onClick={onViewAll}>
              查看全部 →
            </button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
