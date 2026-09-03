'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Gauge, RefreshCw, Loader2, Clock,
  RotateCcw, Settings2, Search,
  Zap, AlertTriangle, CheckCircle2,
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

function statusBadgeStyle(status: DomainRateState['status']): { text: string; bg: string; label: string; dot: string } {
  switch (status) {
    case 'normal':
      return { text: 'text-green-700 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30', label: '正常', dot: 'bg-green-500' };
    case 'throttled':
      return { text: 'text-yellow-700 dark:text-yellow-400', bg: 'bg-yellow-100 dark:bg-yellow-900/30', label: '限速', dot: 'bg-yellow-500' };
    case 'penalized':
      return { text: 'text-red-700 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30', label: '惩罚', dot: 'bg-red-500' };
    case 'cooldown':
      return { text: 'text-sky-700 dark:text-sky-400', bg: 'bg-sky-100 dark:bg-sky-900/30', label: '冷却', dot: 'bg-sky-500' };
  }
}

function rpmBarColor(ratio: number): string {
  if (ratio < 0.7) return 'bg-green-500';
  if (ratio < 0.9) return 'bg-yellow-500';
  return 'bg-red-500';
}

function rpmSparkColor(ratio: number): string {
  if (ratio < 0.7) return 'bg-green-400';
  if (ratio < 0.9) return 'bg-amber-400';
  return 'bg-red-400';
}

// ─── Mini RPM Sparkline ─────────────────────────────────────────────────────

function RpmSparkline({ readings, maxRPM }: { readings: number[]; maxRPM: number }) {
  if (readings.length === 0) return null;
  const maxVal = Math.max(...readings, 1);
  return (
    <div className="flex items-end gap-px h-[40px] mt-1.5 group/spark">
      {readings.map((rpm, i) => {
        const ratio = maxRPM > 0 ? rpm / maxRPM : 0;
        const height = maxVal > 0 ? (rpm / maxVal) * 100 : 0;
        return (
          <div
            key={i}
            className="flex-1 relative rounded-t-sm transition-all duration-300"
            style={{ height: `${Math.max(height, 4)}%` }}
          >
            <div className={`absolute inset-0 rounded-t-sm ${rpmSparkColor(ratio)}`} />
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 hidden group-hover/spark:block z-10">
              <div className="bg-foreground text-background text-[9px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap shadow-md">
                {rpm} RPM
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Status Badge Component ──────────────────────────────────────────────────

function StatusBadge({ status }: { status: DomainRateState['status'] }) {
  const sc = statusBadgeStyle(status);
  return (
    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 font-normal gap-1 ${sc.bg} ${sc.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${sc.dot} ${status !== 'normal' ? 'animate-pulse' : ''}`} />
      {sc.label}
    </Badge>
  );
}

// ─── Domain Row Component ────────────────────────────────────────────────────

function DomainRow({
  d,
  rpmHistory,
  editingDomain,
  editRPM,
  settingLimit,
  resettingDomain,
  onSetEdit,
  onSetRPM,
  onReset,
  onCancelEdit,
  onConfirmEdit,
}: {
  d: DomainRateState;
  rpmHistory: number[];
  editingDomain: string | null;
  editRPM: string;
  settingLimit: boolean;
  resettingDomain: string | null;
  onSetEdit: (domain: string, rpm: string) => void;
  onSetRPM: (val: string) => void;
  onReset: (domain: string) => void;
  onCancelEdit: () => void;
  onConfirmEdit: (domain: string) => void;
}) {
  const ratio = d.maxRPM > 0 ? d.currentRPM / d.maxRPM : 0;
  const isThrottledOrPenalized = d.status === 'throttled' || d.status === 'penalized';
  const showWaitTime = isThrottledOrPenalized && d.estimatedWaitMs > 0;

  return (
    <div className="rounded-lg border bg-background/50 px-4 py-3 group/rate hover:border-muted-foreground/20 transition-all duration-200">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="text-xs font-medium truncate" title={d.domain}>
            {d.domain}
          </span>
          <StatusBadge status={d.status} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {showWaitTime && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal gap-1 bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400 border-amber-500/20">
              <Clock className="h-2.5 w-2.5" />
              等待 {formatMs(d.estimatedWaitMs)}
            </Badge>
          )}
        </div>
      </div>

      {/* RPM progress bar */}
      <div className="flex items-center gap-2.5 mb-1.5">
        <span className="text-[11px] text-muted-foreground shrink-0 w-20 font-mono">
          {d.currentRPM}<span className="text-muted-foreground/50">/{d.maxRPM}</span>
          <span className="text-muted-foreground/40 text-[9px] ml-0.5">RPM</span>
        </span>
        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${rpmBarColor(ratio)}`}
            style={{ width: `${Math.max(ratio * 100, 2)}%` }}
          />
        </div>
        <span className="text-[10px] font-mono text-muted-foreground/60 w-8 text-right">
          {ratio >= 1 ? 'MAX' : `${Math.round(ratio * 100)}%`}
        </span>
      </div>

      {/* Sparkline */}
      <RpmSparkline readings={rpmHistory} maxRPM={d.maxRPM} />

      {/* Details + Actions */}
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            突发 {d.burstRemaining}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatTimeAgo(d.lastRequestTime)}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover/rate:opacity-100 transition-opacity duration-200">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[10px] px-2 gap-1 hover:bg-muted"
            onClick={() => onSetEdit(d.domain, String(d.maxRPM))}
          >
            <Settings2 className="h-3 w-3" />
            设限
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[10px] px-2 gap-1 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
            onClick={() => onReset(d.domain)}
            disabled={resettingDomain === d.domain}
          >
            {resettingDomain === d.domain
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <RotateCcw className="h-3 w-3" />
            }
            重置
          </Button>
        </div>
      </div>

      {/* Inline RPM editor */}
      {editingDomain === d.domain && (
        <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t">
          <Input
            type="number"
            min={1}
            value={editRPM}
            onChange={(e) => onSetRPM(e.target.value)}
            className="h-8 text-xs w-28"
            placeholder="RPM"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onConfirmEdit(d.domain);
              if (e.key === 'Escape') onCancelEdit();
            }}
          />
          <Button
            size="sm"
            className="h-8 text-xs px-3"
            onClick={() => onConfirmEdit(d.domain)}
            disabled={settingLimit}
          >
            {settingLimit ? <Loader2 className="h-3 w-3 animate-spin" /> : '确定'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs px-3"
            onClick={onCancelEdit}
          >
            取消
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

const MAX_RPM_HISTORY = 10;
const REFRESH_INTERVAL = 10_000;

export function RateLimiterPanel() {
  const [stats, setStats] = useState<RateLimitStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingDomain, setEditingDomain] = useState<string | null>(null);
  const [editRPM, setEditRPM] = useState('');
  const [settingLimit, setSettingLimit] = useState(false);
  const [resettingDomain, setResettingDomain] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rpmHistoryRef = useRef<Record<string, number[]>>({});

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<RateLimitStatsResponse>('/api/admin/scraper/rate-limit-stats', {
        signal,
        timeout: 8000,
        silent: true,
      });
      if (!signal?.aborted) {
        if (data?.domains) {
          for (const d of data.domains) {
            const hist = rpmHistoryRef.current[d.domain] || [];
            hist.push(d.currentRPM);
            if (hist.length > MAX_RPM_HISTORY) hist.splice(0, hist.length - MAX_RPM_HISTORY);
            rpmHistoryRef.current[d.domain] = hist;
          }
        }
        setStats(data);
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

    timerRef.current = setInterval(() => {
      abortRef.current?.abort();
      const newAc = new AbortController();
      abortRef.current = newAc;
      fetchStats(newAc.signal);
    }, REFRESH_INTERVAL);

    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
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
    } catch { /* handled by apiFetch */ } finally { setSettingLimit(false); }
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
    } catch { /* handled by apiFetch */ } finally { setResettingDomain(null); }
  };

  const allDomains = stats?.domains || [];
  const totalDomains = stats?.totalDomains || 0;

  // Filter domains by search query
  const filteredDomains = useMemo(() => {
    if (!searchQuery.trim()) return allDomains;
    const q = searchQuery.toLowerCase();
    return allDomains.filter(d => d.domain.toLowerCase().includes(q));
  }, [allDomains, searchQuery]);

  // Aggregate stats
  const penalizedCount = allDomains.filter(d => d.status === 'penalized').length;
  const throttledCount = allDomains.filter(d => d.status === 'throttled').length;
  const normalCount = allDomains.filter(d => d.status === 'normal').length;
  const avgMaxRPM = allDomains.length > 0
    ? Math.round(allDomains.reduce((sum, d) => sum + d.maxRPM, 0) / allDomains.length)
    : 0;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
        <div className="rounded-lg border bg-background/50 p-3">
          <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
            <Gauge className="h-3.5 w-3.5" />
            <span className="text-[10px]">追踪域名</span>
          </div>
          <p className="text-lg font-bold">{totalDomains}</p>
        </div>
        <div className="rounded-lg border bg-background/50 p-3">
          <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400 mb-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span className="text-[10px]">正常</span>
          </div>
          <p className="text-lg font-bold text-green-600 dark:text-green-400">{normalCount}</p>
        </div>
        <div className="rounded-lg border bg-background/50 p-3">
          <div className="flex items-center gap-1.5 text-yellow-600 dark:text-yellow-400 mb-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="text-[10px]">限速</span>
          </div>
          <p className="text-lg font-bold text-yellow-600 dark:text-yellow-400">{throttledCount}</p>
        </div>
        <div className="rounded-lg border bg-background/50 p-3">
          <div className="flex items-center gap-1.5 text-red-600 dark:text-red-400 mb-1">
            <Zap className="h-3.5 w-3.5" />
            <span className="text-[10px]">惩罚</span>
          </div>
          <p className="text-lg font-bold text-red-600 dark:text-red-400">{penalizedCount}</p>
        </div>
        <div className="rounded-lg border bg-background/50 p-3">
          <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
            <Gauge className="h-3.5 w-3.5" />
            <span className="text-[10px]">平均上限</span>
          </div>
          <p className="text-lg font-bold">{avgMaxRPM}<span className="text-xs text-muted-foreground ml-1">RPM</span></p>
        </div>
      </div>

      {/* Search bar + refresh */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="搜索域名..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 text-xs pl-8"
          />
        </div>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal gap-1 shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          10s
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 shrink-0"
          onClick={handleRefresh}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Domain list */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-xs">加载速率限制数据...</span>
        </div>
      ) : filteredDomains.length > 0 ? (
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1 scrollbar-thin">
          {filteredDomains.map((d) => (
            <DomainRow
              key={d.domain}
              d={d}
              rpmHistory={rpmHistoryRef.current[d.domain] || []}
              editingDomain={editingDomain}
              editRPM={editRPM}
              settingLimit={settingLimit}
              resettingDomain={resettingDomain}
              onSetEdit={(domain, rpm) => { setEditingDomain(domain); setEditRPM(rpm); }}
              onSetRPM={setEditRPM}
              onReset={handleReset}
              onCancelEdit={() => { setEditingDomain(null); setEditRPM(''); }}
              onConfirmEdit={handleSetLimit}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Gauge className="h-8 w-8 opacity-30" />
          <p className="text-xs">
            {searchQuery ? '无匹配的域名' : '暂无限速数据，开始采集后自动生效'}
          </p>
        </div>
      )}
    </div>
  );
}
