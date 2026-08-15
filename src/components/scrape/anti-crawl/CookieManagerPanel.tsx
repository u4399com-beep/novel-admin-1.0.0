'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Cookie, Trash2, RefreshCw, Loader2, ChevronDown, ChevronRight, Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CookieDomainStat {
  domain: string;
  count: number;
  lastActivity: number;
}

interface CookieStats {
  domains: CookieDomainStat[];
  totalDomains: number;
  totalCookies: number;
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

// ─── Component ───────────────────────────────────────────────────────────────

export function CookieManagerPanel() {
  const [stats, setStats] = useState<CookieStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<CookieStats>('/api/admin/scraper/cookies', {
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
    setConfirmClear(false);
    fetchStats(ac.signal);
  };

  const handleClearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setClearing(true);
    try {
      await apiFetch('/api/admin/scraper/cookies/clear', {
        method: 'POST',
        body: JSON.stringify({}),
        silent: true,
      });
      setConfirmClear(false);
      handleRefresh();
    } catch {
      // handled by apiFetch
    } finally {
      setClearing(false);
    }
  };

  const handleClearDomain = async (domain: string) => {
    try {
      await apiFetch('/api/admin/scraper/cookies/clear', {
        method: 'POST',
        body: JSON.stringify({ domain }),
        silent: true,
      });
      handleRefresh();
    } catch {
      // handled by apiFetch
    }
  };

  const totalCookies = stats?.totalCookies || 0;
  const totalDomains = stats?.totalDomains || 0;

  return (
    <div className="rounded-lg border bg-background/50 overflow-hidden">
      {/* Header - always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <Cookie className="h-4 w-4 text-primary" />
          <span className="text-xs font-medium">Cookie 管理</span>
          {totalCookies > 0 && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
              {totalCookies} 个
            </Badge>
          )}
          {totalDomains > 0 && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal">
              {totalDomains} 域名
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
      </button>

      {/* Expandable content */}
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
              {/* Actions */}
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground">
                  {totalCookies === 0
                    ? '暂无存储的Cookie'
                    : `共 ${totalCookies} 个Cookie，覆盖 ${totalDomains} 个域名`
                  }
                </div>
                <div className="flex items-center gap-1.5">
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
                  {totalCookies > 0 && (
                    <Button
                      variant={confirmClear ? 'destructive' : 'ghost'}
                      size="sm"
                      className="h-7 text-[11px] px-2"
                      onClick={handleClearAll}
                      disabled={clearing}
                    >
                      {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      <span className="ml-1">{confirmClear ? '确认清除?' : '清除所有'}</span>
                    </Button>
                  )}
                </div>
              </div>

              {/* Domain list */}
              {stats?.domains && stats.domains.length > 0 && (
                <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin">
                  {stats.domains.map((d) => (
                    <div
                      key={d.domain}
                      className="flex items-center justify-between rounded-md border bg-background/50 px-3 py-2 group/cookie"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Cookie className="h-3 w-3 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium truncate" title={d.domain}>
                            {d.domain}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Badge variant="secondary" className="text-[9px] px-1 py-0 font-normal">
                              {d.count} 个
                            </Badge>
                            <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
                              <Clock className="h-2.5 w-2.5" />
                              {formatTimeAgo(d.lastActivity)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover/cookie:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                        onClick={() => handleClearDomain(d.domain)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}