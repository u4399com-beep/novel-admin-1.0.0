'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Timer, RefreshCw, Loader2, ChevronDown, ChevronRight, Clock, Activity,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DomainDelayStat {
  domain: string;
  currentDelay: number;
  backoffLevel: number;
  consecutiveErrors: number;
  avgResponseTime: number;
  lastRequestTime: number;
  status: 'normal' | 'warning' | 'backoff' | 'critical';
}

interface DelayStatsResponse {
  domains: DomainDelayStat[];
  totalDomains: number;
  serviceReachable: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_BACKOFF_MS = 60000;

function formatTimeAgo(ts: number): string {
  if (!ts) return '未知';
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

function statusStyle(status: DomainDelayStat['status']): { text: string; bg: string; label: string } {
  switch (status) {
    case 'normal': return { text: 'text-green-700 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30', label: '正常' };
    case 'warning': return { text: 'text-yellow-700 dark:text-yellow-400', bg: 'bg-yellow-100 dark:bg-yellow-900/30', label: '注意' };
    case 'backoff': return { text: 'text-orange-700 dark:text-orange-400', bg: 'bg-orange-100 dark:bg-orange-900/30', label: '退避' };
    case 'critical': return { text: 'text-red-700 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30', label: '严重' };
  }
}

function delayBarColor(ratio: number): string {
  if (ratio < 0.3) return 'bg-green-500';
  if (ratio < 0.6) return 'bg-yellow-500';
  if (ratio < 0.8) return 'bg-orange-500';
  return 'bg-red-500';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AdaptiveDelayPanel() {
  const [stats, setStats] = useState<DelayStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<DelayStatsResponse>('/api/admin/scraper/delay-stats', {
        signal,
        timeout: 8000,
        silent: true,
      });
      if (!signal?.aborted) setStats(data);
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

  const domains = stats?.domains || [];
  const totalDomains = stats?.totalDomains || 0;
  const backoffCount = domains.filter(d => d.status === 'backoff').length;
  const criticalCount = domains.filter(d => d.status === 'critical').length;
  const avgBaseDelay = domains.length > 0
    ? Math.round(domains.reduce((sum, d) => sum + d.currentDelay, 0) / domains.length)
    : 0;

  return (
    <div className="rounded-lg border bg-background/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <Timer className="h-4 w-4 text-primary" />
          <span className="text-xs font-medium">自适应延迟控制</span>
          {totalDomains > 0 && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
              {totalDomains} 域名
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          }
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t px-4 py-3 space-y-3">
              {/* Summary Row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
                    <Activity className="h-2.5 w-2.5 mr-0.5" />
                    追踪 {totalDomains} 域名
                  </Badge>
                  {backoffCount > 0 && (
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                      退避 {backoffCount}
                    </Badge>
                  )}
                  {criticalCount > 0 && (
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                      严重 {criticalCount}
                    </Badge>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    平均延迟 {formatMs(avgBaseDelay)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px] px-2"
                  onClick={handleRefresh}
                  disabled={loading}
                >
                  {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  <span className="ml-1">刷新</span>
                </Button>
              </div>

              {/* Domain List */}
              {domains.length > 0 ? (
                <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin">
                  {domains.map((d) => {
                    const sc = statusStyle(d.status);
                    const ratio = Math.min(d.currentDelay / MAX_BACKOFF_MS, 1);
                    return (
                      <div
                        key={d.domain}
                        className="rounded-md border bg-background/50 px-3 py-2"
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[11px] font-medium truncate max-w-[55%]" title={d.domain}>
                            {d.domain}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <Badge variant="secondary" className={`text-[9px] px-1 py-0 font-normal ${sc.bg} ${sc.text}`}>
                              {sc.label}
                            </Badge>
                          </div>
                        </div>
                        {/* Delay bar */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[10px] text-muted-foreground shrink-0 w-14">延迟</span>
                          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${delayBarColor(ratio)}`}
                              style={{ width: `${Math.max(ratio * 100, 2)}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-medium shrink-0 w-14 text-right">
                            {formatMs(d.currentDelay)}
                          </span>
                        </div>
                        {/* Details row */}
                        <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
                          <span className="flex items-center gap-0.5">
                            <Activity className="h-2.5 w-2.5" />
                            错误 {d.consecutiveErrors}
                          </span>
                          <span>平均 {d.avgResponseTime > 0 ? formatMs(d.avgResponseTime) : '-'}s</span>
                          <span>退避 Lv.{d.backoffLevel}</span>
                          <span className="flex items-center gap-0.5">
                            <Clock className="h-2.5 w-2.5" />
                            {formatTimeAgo(d.lastRequestTime)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                  <Timer className="h-6 w-6 mb-1.5 opacity-40" />
                  <p className="text-[11px]">暂无延迟数据，开始采集后自动追踪</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
