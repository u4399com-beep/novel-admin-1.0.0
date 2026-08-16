'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Gauge, RefreshCw, Loader2, ChevronDown, ChevronRight, Clock,
  RotateCcw, Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DomainRateState {
  domain: string;
  maxRPM: number;
  currentRPM: number;
  burstRemaining: number;
  penaltyActive: boolean;
  penaltyUntil: number;
  lastRequestTime: number;
  status: 'normal' | 'throttled' | 'penalized' | 'cooldown';
  estimatedWaitMs: number;
}

interface RateLimitStatsResponse {
  domains: DomainRateState[];
  totalDomains: number;
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

function formatMs(ms: number): string {
  if (ms <= 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

function statusStyle(status: DomainRateState['status']): { text: string; bg: string; label: string } {
  switch (status) {
    case 'normal': return { text: 'text-green-700 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30', label: '正常' };
    case 'throttled': return { text: 'text-yellow-700 dark:text-yellow-400', bg: 'bg-yellow-100 dark:bg-yellow-900/30', label: '限速' };
    case 'penalized': return { text: 'text-red-700 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30', label: '惩罚' };
    case 'cooldown': return { text: 'text-gray-700 dark:text-gray-400', bg: 'bg-gray-100 dark:bg-gray-900/30', label: '冷却' };
  }
}

function rpmBarColor(ratio: number): string {
  if (ratio < 0.7) return 'bg-green-500';
  if (ratio < 0.9) return 'bg-yellow-500';
  return 'bg-red-500';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function RateLimiterPanel() {
  const [stats, setStats] = useState<RateLimitStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [editingDomain, setEditingDomain] = useState<string | null>(null);
  const [editRPM, setEditRPM] = useState('');
  const [settingLimit, setSettingLimit] = useState(false);
  const [resettingDomain, setResettingDomain] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<RateLimitStatsResponse>('/api/admin/scraper/rate-limit-stats', {
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

  const handleSetLimit = async (domain: string) => {
    const rpm = parseInt(editRPM);
    if (isNaN(rpm) || rpm < 1) return;
    setSettingLimit(true);
    try {
      await apiFetch('/api/admin/scraper/rate-limit-manage', {
        method: 'POST',
        body: JSON.stringify({ action: 'set', domain, maxRPM: rpm }),
        silent: true,
      });
      setEditingDomain(null);
      setEditRPM('');
      handleRefresh();
    } catch {
      // handled by apiFetch
    } finally {
      setSettingLimit(false);
    }
  };

  const handleReset = async (domain: string) => {
    setResettingDomain(domain);
    try {
      await apiFetch('/api/admin/scraper/rate-limit-manage', {
        method: 'POST',
        body: JSON.stringify({ action: 'reset', domain }),
        silent: true,
      });
      handleRefresh();
    } catch {
      // handled by apiFetch
    } finally {
      setResettingDomain(null);
    }
  };

  const domains = stats?.domains || [];
  const totalDomains = stats?.totalDomains || 0;
  const penalizedCount = domains.filter(d => d.status === 'penalized').length;
  const throttledCount = domains.filter(d => d.status === 'throttled').length;
  const avgMaxRPM = domains.length > 0
    ? Math.round(domains.reduce((sum, d) => sum + d.maxRPM, 0) / domains.length)
    : 0;

  return (
    <div className="rounded-lg border bg-background/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <Gauge className="h-4 w-4 text-primary" />
          <span className="text-xs font-medium">域名速率限制</span>
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
                    <Gauge className="h-2.5 w-2.5 mr-0.5" />
                    限制 {totalDomains} 域名
                  </Badge>
                  {penalizedCount > 0 && (
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                      惩罚 {penalizedCount}
                    </Badge>
                  )}
                  {throttledCount > 0 && (
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                      限速 {throttledCount}
                    </Badge>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    平均上限 {avgMaxRPM} RPM
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
                    const ratio = d.maxRPM > 0 ? d.currentRPM / d.maxRPM : 0;
                    return (
                      <div
                        key={d.domain}
                        className="rounded-md border bg-background/50 px-3 py-2 group/rate"
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[11px] font-medium truncate max-w-[40%]" title={d.domain}>
                            {d.domain}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <Badge variant="secondary" className={`text-[9px] px-1 py-0 font-normal ${sc.bg} ${sc.text}`}>
                              {sc.label}
                            </Badge>
                            {d.penaltyActive && (
                              <Badge variant="secondary" className="text-[9px] px-1 py-0 font-normal bg-red-50 text-red-600 dark:bg-red-900/20">
                                等待 {formatMs(d.estimatedWaitMs)}
                              </Badge>
                            )}
                          </div>
                        </div>
                        {/* RPM progress bar */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[10px] text-muted-foreground shrink-0 w-16">
                            {d.currentRPM}/{d.maxRPM} RPM
                          </span>
                          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${rpmBarColor(ratio)}`}
                              style={{ width: `${Math.max(ratio * 100, 2)}%` }}
                            />
                          </div>
                        </div>
                        {/* Details + Actions */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
                            <span>突发余量 {d.burstRemaining}</span>
                            <span className="flex items-center gap-0.5">
                              <Clock className="h-2.5 w-2.5" />
                              {formatTimeAgo(d.lastRequestTime)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover/rate:opacity-100 transition-opacity">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-[9px] px-1.5 gap-0.5"
                              onClick={() => { setEditingDomain(d.domain); setEditRPM(String(d.maxRPM)); }}
                            >
                              <Settings2 className="h-2.5 w-2.5" />
                              设限
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-[9px] px-1.5 gap-0.5"
                              onClick={() => handleReset(d.domain)}
                              disabled={resettingDomain === d.domain}
                            >
                              {resettingDomain === d.domain
                                ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                : <RotateCcw className="h-2.5 w-2.5" />
                              }
                              重置
                            </Button>
                          </div>
                        </div>

                        {/* Inline RPM editor */}
                        {editingDomain === d.domain && (
                          <div className="flex items-center gap-1.5 mt-2 pt-2 border-t">
                            <Input
                              type="number"
                              min={1}
                              value={editRPM}
                              onChange={(e) => setEditRPM(e.target.value)}
                              className="h-7 text-[11px] w-24"
                              placeholder="RPM"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSetLimit(d.domain);
                                if (e.key === 'Escape') { setEditingDomain(null); setEditRPM(''); }
                              }}
                            />
                            <Button
                              size="sm"
                              className="h-7 text-[10px] px-2"
                              onClick={() => handleSetLimit(d.domain)}
                              disabled={settingLimit}
                            >
                              {settingLimit ? <Loader2 className="h-3 w-3 animate-spin" /> : '确定'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-[10px] px-2"
                              onClick={() => { setEditingDomain(null); setEditRPM(''); }}
                            >
                              取消
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                  <Gauge className="h-6 w-6 mb-1.5 opacity-40" />
                  <p className="text-[11px]">暂无限速数据，开始采集后自动生效</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
