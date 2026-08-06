'use client';

import React from 'react';
import { Info, AlertTriangle, CircleX, CircleCheck } from 'lucide-react';
import { ListChecks } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ScrapeTaskLog } from './types';

const LOG_LEVEL_CONFIG: Record<
  string,
  { color: string; icon: React.ElementType }
> = {
  info: { color: 'text-foreground', icon: Info },
  warn: { color: 'text-amber-500', icon: AlertTriangle },
  error: { color: 'text-red-500', icon: CircleX },
  success: { color: 'text-emerald-500', icon: CircleCheck },
};

interface TaskLogPanelProps {
  isExpanded: boolean;
  logs: ScrapeTaskLog[];
  logsLoading: boolean;
  formatDate: (d: string | null | undefined) => string;
}

export function TaskLogPanel({ isExpanded, logs, logsLoading, formatDate }: TaskLogPanelProps) {
  if (!isExpanded) return null;

  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex items-center gap-2 mb-2">
        <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">运行日志</span>
      </div>
      {logsLoading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : logs.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">暂无日志</p>
      ) : (
        <ScrollArea className="max-h-64">
          <div className="space-y-0.5">
            {logs.map((log) => {
              const logConfig = LOG_LEVEL_CONFIG[log.level] || LOG_LEVEL_CONFIG.info;
              const LogIcon = logConfig.icon;
              return (
                <div
                  key={log.id}
                  className="flex items-start gap-2 py-1 px-2 rounded-sm hover:bg-muted/50 text-xs"
                >
                  <LogIcon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${logConfig.color}`} />
                  <span className={`flex-1 break-words ${logConfig.color}`}>{log.message}</span>
                  {log.url && (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60 font-mono max-w-[160px] truncate hidden sm:inline-block">
                      {log.url}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground/50 font-mono whitespace-nowrap hidden md:inline">
                    {formatDate(log.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
