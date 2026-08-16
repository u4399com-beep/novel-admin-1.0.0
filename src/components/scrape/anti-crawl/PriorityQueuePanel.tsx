'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import {
  ListOrdered, Loader2, RefreshCw,
  X, ArrowUpDown, Clock, Play,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-fetch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CollapsiblePanel } from './CollapsiblePanel';

// ─── Types ───────────────────────────────────────────────────────────────────

interface QueueItem {
  taskId: string;
  priority: number;
  ruleId?: string;
  createdAt: number;
  position: number;
}

interface ProcessingItem {
  taskId: string;
  priority: number;
  ruleId?: string;
  createdAt: number;
}

interface QueueStats {
  queueSize: number;
  processingCount: number;
  maxConcurrent: number;
  byPriority: Record<string, number>;
  queueItems: QueueItem[];
  processingItems: ProcessingItem[];
  serviceReachable: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PRIORITY_CONFIG: Record<number, { label: string; variant: 'destructive' | 'outline' | 'secondary' | 'secondary'; className: string }> = {
  0: { label: '紧急', variant: 'destructive', className: 'bg-red-500/10 text-red-600 border-red-500/20' },
  1: { label: '高', variant: 'outline', className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  2: { label: '普通', variant: 'secondary', className: 'bg-sky-500/10 text-sky-600 border-sky-500/20' },
  3: { label: '低', variant: 'secondary', className: 'bg-muted text-muted-foreground' },
};

const PRIORITY_OPTIONS: { value: number; label: string; icon: string }[] = [
  { value: 0, label: '紧急', icon: '🔴' },
  { value: 1, label: '高', icon: '🟠' },
  { value: 2, label: '普通', icon: '🔵' },
  { value: 3, label: '低', icon: '⚪' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncateId(id: string, chars = 8): string {
  return id.length > chars ? `${id.slice(0, chars)}…` : id;
}

function formatWaitTime(createdAt: number): string {
  const diff = Date.now() - createdAt;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时`;
}

function formatRunningTime(createdAt: number): string {
  return formatWaitTime(createdAt);
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PriorityQueuePanel() {
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [maxInput, setMaxInput] = useState('3');
  const [settingConcurrency, setSettingConcurrency] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<QueueStats>('/api/admin/scraper/priority-queue', {
        signal,
        timeout: 8000,
        silent: true,
      });
      if (!signal?.aborted) {
        setStats(data);
        setMaxInput(String(data.maxConcurrent));
      }
    } catch {
      // handled by apiFetch
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchStats(ac.signal);
    return () => { abortRef.current?.abort(); abortRef.current = null; };
  }, [fetchStats]);

  const handleRefresh = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchStats(ac.signal);
  };

  const handleSetConcurrency = useCallback(async () => {
    const val = parseInt(maxInput, 10);
    if (isNaN(val) || val < 1 || val > 20) return;
    setSettingConcurrency(true);
    try {
      await apiFetch('/api/admin/scraper/priority-queue', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrent: val }),
      });
      toast.success(`最大并发数已设为 ${val}`);
      handleRefresh();
    } catch {
      // handled by apiFetch
    } finally {
      setSettingConcurrency(false);
    }
  }, [maxInput]);

  const handleReorder = useCallback(async (taskId: string, newPriority: number) => {
    try {
      await apiFetch('/api/admin/scraper/priority-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', taskId, priority: newPriority }),
      });
      toast.success(`已调整优先级为 ${PRIORITY_CONFIG[newPriority]?.label || newPriority}`);
      handleRefresh();
    } catch {
      // handled by apiFetch
    }
  }, []);

  const handleCancel = useCallback(async (taskId: string) => {
    try {
      await apiFetch('/api/admin/scraper/priority-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', taskId }),
      });
      toast.success('已取消排队任务');
      handleRefresh();
    } catch {
      // handled by apiFetch
    }
  }, []);

  const queueItems = stats?.queueItems || [];
  const processingItems = stats?.processingItems || [];
  const queueSize = stats?.queueSize || 0;
  const processingCount = stats?.processingCount || 0;
  const maxConcurrent = stats?.maxConcurrent || 3;

  return (
    <CollapsiblePanel
      icon={ListOrdered}
      title="任务优先级队列"
      loading={loading}
      expanded={expanded}
      onExpandedChange={setExpanded}
      badges={processingCount > 0 ? (
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
          {processingCount} 处理中
        </Badge>
      ) : undefined}
    >
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
          <p className="text-[10px] text-muted-foreground">队列</p>
          <p className="text-sm font-semibold text-chart-sky">{queueSize}</p>
        </div>
        <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
          <p className="text-[10px] text-muted-foreground">处理中</p>
          <p className="text-sm font-semibold text-chart-emerald">{processingCount}</p>
        </div>
        <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
          <p className="text-[10px] text-muted-foreground">最大并发</p>
          <p className="text-sm font-semibold text-chart-amber">{maxConcurrent}</p>
        </div>
      </div>

      {/* Concurrent control */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">最大并发数</span>
        <Input
          type="number"
          min={1}
          max={20}
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          className="h-7 w-20 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px] px-2"
          onClick={handleSetConcurrency}
          disabled={settingConcurrency}
        >
          {settingConcurrency ? <Loader2 className="h-3 w-3 animate-spin" /> : '设置'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px] px-2 ml-auto"
          onClick={handleRefresh}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {/* Queue list */}
      <div className="space-y-1">
        <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
          <ListOrdered className="h-3 w-3" />
          等待队列 ({queueSize})
        </p>
        {queueItems.length > 0 ? (
          <div className="space-y-1 max-h-64 overflow-y-auto scrollbar-thin">
            {queueItems.map((item) => {
              const pCfg = PRIORITY_CONFIG[item.priority] || PRIORITY_CONFIG[2];
              return (
                <div
                  key={item.taskId}
                  className="flex items-center justify-between rounded-md border bg-background/50 px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge
                      variant={pCfg.variant}
                      className={`text-[9px] px-1 py-0 font-normal shrink-0 ${pCfg.className}`}
                    >
                      {pCfg.label}
                    </Badge>
                    <span className="text-[11px] font-mono shrink-0" title={item.taskId}>
                      {truncateId(item.taskId)}
                    </span>
                    {item.ruleId && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">
                        {truncateId(item.ruleId)}
                      </span>
                    )}
                    <div className="flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground">
                      <Clock className="h-2.5 w-2.5" />
                      {formatWaitTime(item.createdAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                          <ArrowUpDown className="h-3 w-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-28">
                        {PRIORITY_OPTIONS.map((opt) => (
                          <DropdownMenuItem
                            key={opt.value}
                            onClick={() => handleReorder(item.taskId, opt.value)}
                            className="text-xs"
                          >
                            {opt.icon} {opt.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleCancel(item.taskId)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-4 text-muted-foreground">
            <ListOrdered className="h-5 w-5 mb-1 opacity-40" />
            <p className="text-[11px]">队列为空</p>
          </div>
        )}
      </div>

      {/* Processing list */}
      <div className="space-y-1">
        <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
          <Play className="h-3 w-3" />
          处理中 ({processingCount})
        </p>
        {processingItems.length > 0 ? (
          <div className="space-y-1 max-h-32 overflow-y-auto scrollbar-thin">
            {processingItems.map((item) => {
              const pCfg = PRIORITY_CONFIG[item.priority] || PRIORITY_CONFIG[2];
              return (
                <div
                  key={item.taskId}
                  className="flex items-center justify-between rounded-md border bg-emerald-500/5 px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge
                      variant={pCfg.variant}
                      className={`text-[9px] px-1 py-0 font-normal shrink-0 ${pCfg.className}`}
                    >
                      {pCfg.label}
                    </Badge>
                    <span className="text-[11px] font-mono shrink-0" title={item.taskId}>
                      {truncateId(item.taskId)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground">
                    <Clock className="h-2.5 w-2.5" />
                    {formatRunningTime(item.createdAt)}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center justify-center py-2 text-[10px] text-muted-foreground/60">
            无处理中的任务
          </div>
        )}
      </div>
    </CollapsiblePanel>
  );
}
