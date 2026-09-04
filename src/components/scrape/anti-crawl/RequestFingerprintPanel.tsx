'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ScanSearch, Loader2, RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';
import { CollapsiblePanel } from './CollapsiblePanel';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FingerprintEntry {
  id?: string;
  domain?: string;
  engine?: string;
  userAgent?: string;
  proxy?: string;
  timestamp?: number;
  createdAt?: number;
}

interface DomainStat {
  domain: string;
  count: number;
}

interface FingerprintStats {
  total: number;
  domains: DomainStat[];
}

interface FingerprintData {
  recent: FingerprintEntry[];
  stats: FingerprintStats;
  serviceReachable: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeAgo(ts?: number): string {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时前`;
}

function getDomainColor(index: number): string {
  const colors = [
    'bg-green-400', 'bg-cyan-400', 'bg-amber-400', 'bg-rose-400',
    'bg-violet-400', 'bg-cyan-400', 'bg-orange-400', 'bg-teal-400',
  ];
  return colors[index % colors.length];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function RequestFingerprintPanel() {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<FingerprintData | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiFetch<FingerprintData>('/api/admin/scraper/fingerprint-stats', {
        signal,
        timeout: 8000,
        silent: true,
      });
      if (!signal?.aborted) setData(res);
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

  // Auto-refresh every 10s when expanded
  useEffect(() => {
    if (expanded) {
      intervalRef.current = setInterval(() => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        fetchStats(ac.signal);
      }, 10000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [expanded, fetchStats]);

  const handleRefresh = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchStats(ac.signal);
  };

  const totalCount = data?.stats?.total ?? 0;
  const domainCount = data?.stats?.domains?.length ?? 0;
  const maxDomainCount = data?.stats?.domains?.reduce((max, d) => Math.max(max, d.count), 0) ?? 0;
  const recentFingerprints = Array.isArray(data?.recent) ? data.recent.slice(0, 10) : [];

  return (
    <CollapsiblePanel
      icon={ScanSearch}
      title="请求指纹追踪"
      loading={loading}
      expanded={expanded}
      onExpandedChange={setExpanded}
      badges={totalCount > 0 ? (
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
          {totalCount}
        </Badge>
      ) : undefined}
    >
      {/* Summary + Refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>近5分钟 <strong className="text-foreground">{totalCount}</strong> 请求</span>
          <span>域名 <strong className="text-foreground">{domainCount}</strong></span>
          {expanded && (
            <span className="text-[9px] text-muted-foreground/60">每10秒刷新</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px] px-2"
          onClick={handleRefresh}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {/* Domain bar chart */}
      {data?.stats?.domains && data.stats.domains.length > 0 && (
        <div className="space-y-1.5">
          {data.stats.domains.map((d, i) => (
            <div key={d.domain} className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-28 truncate shrink-0" title={d.domain}>
                {d.domain}
              </span>
              <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${getDomainColor(i)} transition-all`}
                  style={{ width: `${maxDomainCount > 0 ? (d.count / maxDomainCount) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[9px] text-muted-foreground font-mono w-6 text-right">{d.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent fingerprints table */}
      {recentFingerprints.length > 0 ? (
        <div className="rounded-md border overflow-hidden">
          <div className="grid grid-cols-[1fr_1fr_0.7fr_2fr_0.8fr_0.8fr] gap-0 text-[9px] font-medium text-muted-foreground bg-muted/30 px-2 py-1.5">
            <span>请求ID</span>
            <span>域名</span>
            <span>引擎</span>
            <span>User-Agent</span>
            <span>代理</span>
            <span>时间</span>
          </div>
          <div className="max-h-48 overflow-y-auto scrollbar-thin">
            {recentFingerprints.map((fp, i) => (
              <div
                key={`${fp.id}-${i}`}
                className="grid grid-cols-[1fr_1fr_0.7fr_2fr_0.8fr_0.8fr] gap-0 text-[10px] px-2 py-1.5 border-t hover:bg-muted/20 transition-colors items-center"
              >
                <span className="font-mono text-muted-foreground truncate" title={fp.id}>
                  {fp.id ? fp.id.slice(0, 8) : '-'}
                </span>
                <span className="truncate" title={fp.domain}>{fp.domain || '-'}</span>
                <span className="text-muted-foreground truncate">{fp.engine || '-'}</span>
                <span className="text-muted-foreground truncate" title={fp.userAgent}>
                  {fp.userAgent ? fp.userAgent.slice(0, 40) : '-'}
                </span>
                <span className="text-muted-foreground truncate" title={fp.proxy}>
                  {fp.proxy ? '✓' : '-'}
                </span>
                <span className="text-muted-foreground">
                  {formatTimeAgo(fp.timestamp || fp.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground text-center py-4">
          暂无请求指纹数据
        </div>
      )}
    </CollapsiblePanel>
  );
}
