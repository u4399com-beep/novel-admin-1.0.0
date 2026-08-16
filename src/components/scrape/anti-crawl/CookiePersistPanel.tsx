'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HardDrive, RefreshCw, Loader2, ChevronDown, ChevronRight, Clock, Database, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CookiePersistStats {
  domains: { domain: string; count: number }[];
  totalCookies: number;
  totalDomains: number;
  dbSize?: number;
  lastCleanup?: number;
  serviceReachable: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CookiePersistPanel() {
  const [stats, setStats] = useState<CookiePersistStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<CookiePersistStats>('/api/admin/scraper/cookie-persist/stats', {
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

  const totalCookies = stats?.totalCookies || 0;
  const totalDomains = stats?.totalDomains || 0;
  const domains = stats?.domains || [];

  return (
    <div className="rounded-lg border bg-background/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <HardDrive className="h-4 w-4 text-primary" />
          <span className="text-xs font-medium">Cookie 持久化</span>
          {totalCookies > 0 && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
              {totalCookies} 个
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
              {/* Info banner */}
              <div className="flex items-start gap-2 rounded-md bg-primary/5 border border-primary/10 px-3 py-2">
                <Info className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                <p className="text-[10px] text-muted-foreground">
                  Cookie 已持久化到 SQLite，服务重启后自动恢复
                </p>
              </div>

              {/* Stats grid 2x2 */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border bg-muted/20 px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <HardDrive className="h-3 w-3 text-muted-foreground" />
                    <p className="text-[10px] text-muted-foreground">总 Cookie</p>
                  </div>
                  <p className="text-sm font-semibold mt-0.5">{totalCookies}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <Database className="h-3 w-3 text-muted-foreground" />
                    <p className="text-[10px] text-muted-foreground">域名数</p>
                  </div>
                  <p className="text-sm font-semibold mt-0.5">{totalDomains}</p>
                </div>
                {stats?.dbSize != null && (
                  <div className="rounded-lg border bg-muted/20 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <Database className="h-3 w-3 text-muted-foreground" />
                      <p className="text-[10px] text-muted-foreground">DB 大小</p>
                    </div>
                    <p className="text-sm font-semibold mt-0.5">{formatBytes(stats.dbSize)}</p>
                  </div>
                )}
                {stats?.lastCleanup != null && (
                  <div className="rounded-lg border bg-muted/20 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3 w-3 text-muted-foreground" />
                      <p className="text-[10px] text-muted-foreground">上次清理</p>
                    </div>
                    <p className="text-sm font-semibold mt-0.5">{formatTimeAgo(stats.lastCleanup)}</p>
                  </div>
                )}
              </div>

              {/* Refresh button */}
              <div className="flex justify-end">
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

              {/* Domain list */}
              {domains.length > 0 ? (
                <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin">
                  {domains.map((d) => (
                    <div
                      key={d.domain}
                      className="flex items-center justify-between rounded-md border bg-background/50 px-3 py-2"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <HardDrive className="h-3 w-3 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium truncate" title={d.domain}>
                            {d.domain}
                          </div>
                          <Badge variant="secondary" className="text-[9px] px-1 py-0 font-normal mt-0.5">
                            {d.count} 个 Cookie
                          </Badge>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                  <HardDrive className="h-6 w-6 mb-1.5 opacity-40" />
                  <p className="text-[11px]">持久化存储为空</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
