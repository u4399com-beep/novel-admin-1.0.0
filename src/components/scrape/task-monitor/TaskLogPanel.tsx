'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import {
  Info,
  AlertTriangle,
  CircleX,
  CircleCheck,
  ListChecks,
  ArrowDown,
  Download,
  Search,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ScrapeTaskLog } from './types';

const LOG_LEVEL_CONFIG: Record<
  string,
  { color: string; icon: React.ElementType }
> = {
  info: { color: 'text-foreground', icon: Info },
  warn: { color: 'text-chart-amber', icon: AlertTriangle },
  error: { color: 'text-destructive', icon: CircleX },
  success: { color: 'text-chart-emerald', icon: CircleCheck },
};

const LOG_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'info', label: '信息' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' },
  { value: 'success', label: '成功' },
];

const LEVEL_LABELS: Record<string, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  success: 'OK',
};

/** Split text by query and wrap matches in highlighted spans */
function highlightMatch(text: string, query: string): ReactNode[] {
  if (!query.trim()) return [text];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <span key={i} className="bg-primary/20 rounded px-0.5">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function formatTimeForExport(dateStr: string): string {
  const d = new Date(dateStr);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

interface TaskLogPanelProps {
  isExpanded: boolean;
  logs: ScrapeTaskLog[];
  logsLoading: boolean;
  formatDate: (d: string | null | undefined) => string;
}

export function TaskLogPanel({ isExpanded, logs, logsLoading, formatDate }: TaskLogPanelProps) {
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchQuery]);

  // Filtered logs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter !== 'all' && log.level !== levelFilter) return false;
      if (debouncedQuery && !log.message.toLowerCase().includes(debouncedQuery.toLowerCase()))
        return false;
      return true;
    });
  }, [logs, levelFilter, debouncedQuery]);

  // Auto-scroll to bottom when new logs arrive
  const prevLogCountRef = useRef(filteredLogs.length);
  useEffect(() => {
    if (autoScroll && filteredLogs.length > prevLogCountRef.current) {
      requestAnimationFrame(() => {
        const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      });
    }
    prevLogCountRef.current = filteredLogs.length;
  }, [filteredLogs.length, autoScroll]);

  // Detect manual scroll up to disable auto-scroll
  const handleScroll = useCallback(() => {
    const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    if (!viewport) return;
    const isAtBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 20;
    setAutoScroll(isAtBottom);
  }, []);

  // Re-enable auto-scroll
  const handleAutoScrollClick = useCallback(() => {
    setAutoScroll(true);
    requestAnimationFrame(() => {
      const viewport = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
  }, []);

  // Export logs as .txt
  const handleExport = useCallback(() => {
    const lines = filteredLogs.map((log) => {
      const time = formatTimeForExport(log.createdAt);
      const level = LEVEL_LABELS[log.level] || 'INFO';
      const url = log.url ? ` (${log.url})` : '';
      return `[${time}] [${level}] ${log.message}${url}`;
    });
    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `task-logs-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredLogs]);

  if (!isExpanded) return null;

  return (
    <div className="mt-3 border-t pt-3">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">运行日志</span>
        </div>
        <span className="text-[10px] text-muted-foreground">
          显示 {filteredLogs.length} / 共 {logs.length} 条
        </span>
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
        <>
          {/* Separator + Filter/Search row */}
          <div className="border-t my-2" />
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-2">
            {/* Level filter buttons */}
            <div className="flex items-center gap-1 flex-wrap">
              {LOG_FILTERS.map((f) => (
                <Button
                  key={f.value}
                  variant={levelFilter === f.value ? 'default' : 'outline'}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setLevelFilter(f.value)}
                >
                  {f.label}
                </Button>
              ))}
            </div>

            {/* Search + Action buttons */}
            <div className="flex items-center gap-1.5 sm:ml-auto">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索日志..."
                  className="h-6 pl-7 pr-2 text-[11px] w-36 sm:w-44"
                />
              </div>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={autoScroll ? 'default' : 'outline'}
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={handleAutoScrollClick}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">
                    {autoScroll ? '自动滚动：开' : '点击恢复自动滚动'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={handleExport}
                    >
                      <Download className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">
                    导出日志
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {/* Log list */}
          <ScrollArea className="max-h-64" ref={scrollRef} onScrollCapture={handleScroll}>
            <div className="space-y-0.5">
              {filteredLogs.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2 text-center">
                  无匹配日志
                </p>
              ) : (
                filteredLogs.map((log, index) => {
                  const logConfig = LOG_LEVEL_CONFIG[log.level] || LOG_LEVEL_CONFIG.info;
                  const LogIcon = logConfig.icon;
                  const isOdd = index % 2 === 1;
                  const isError = log.level === 'error';
                  const isWarn = log.level === 'warn';
                  return (
                    <div
                      key={log.id}
                      className={`
                        flex items-start gap-2 py-1 px-2 rounded-sm hover:bg-muted/50 text-xs transition-colors
                        ${isOdd ? 'bg-muted/20' : ''}
                        ${isError ? 'border-l-2 border-destructive/30' : ''}
                        ${isWarn && !isError ? 'border-l-2 border-chart-amber/30' : ''}
                      `}
                    >
                      <LogIcon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${logConfig.color}`} />
                      <span className={`flex-1 break-words ${logConfig.color}`}>
                        {highlightMatch(log.message, debouncedQuery)}
                      </span>
                      {log.url && (
                        <span className="shrink-0 text-[10px] text-muted-foreground/60 font-mono max-w-[160px] truncate hidden sm:inline-block">
                          {highlightMatch(log.url, debouncedQuery)}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-muted-foreground/50 font-mono whitespace-nowrap hidden md:inline">
                        {formatDate(log.createdAt)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </>
      )}
    </div>
  );
}
