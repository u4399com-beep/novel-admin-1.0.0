'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  TrendingUp, TrendingDown, Activity, Clock, ShieldAlert, Globe, Zap, RefreshCw, Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-fetch';

const STYLE_ID = 'quick-stats-panel-animations';

if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes qs-gradient-border {
      0%   { background-position: 0% 50%; }
      50%  { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .qs-gradient-border { background-size: 200% 200%; animation: qs-gradient-border 3s ease infinite; }
    @keyframes qs-pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.4; transform: scale(1.6); }
    }
    .qs-pulse-dot { animation: qs-pulse-dot 1.5s ease-in-out infinite; }
    @keyframes qs-count-up {
      from { opacity: 0.6; transform: translateY(2px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .qs-count-animate { animation: qs-count-up 0.4s ease-out; }
  `;
  document.head.appendChild(style);
}

interface DashboardData {
  total24h?: number;
  unresolvedCount?: number;
  topDomains?: Array<{ domain: string; count: number }>;
  proxyStats?: { activeProxies: number; successRate: number; totalRequests: number; avgScore: number };
  events24h?: Record<string, number>;
  events7d?: Record<string, number>;
  total7d?: number;
}

interface RateStats {
  domains: Array<{ domain: string; maxRPM: number; currentRPM: number; status: string }>;
  totalDomains: number;
  serviceReachable: boolean;
}

function getTrendDirection(current: number, previous: number): 'up' | 'down' | 'flat' {
  if (previous === 0) return current > 0 ? 'up' : 'flat';
  const ratio = current / previous;
  if (ratio > 1.15) return 'up';
  if (ratio < 0.85) return 'down';
  return 'flat';
}

function successRateColor(rate: number) {
  if (rate >= 90) return { text: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10' };
  if (rate >= 70) return { text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10' };
  return { text: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/10' };
}

function responseTimeColor(ms: number) {
  if (ms <= 500) return { text: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10' };
  if (ms <= 2000) return { text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10' };
  return { text: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/10' };
}

function threatLevelConfig(threats: number) {
  if (threats === 0) return { label: '安全', colors: '#10b981, #34d399, #14b8a6', text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' };
  if (threats <= 5) return { label: '低风险', colors: '#f59e0b, #eab308, #fb923c', text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' };
  if (threats <= 20) return { label: '中风险', colors: '#f97316, #f59e0b, #f87171', text: 'text-orange-600 dark:text-orange-400', dot: 'bg-orange-500' };
  return { label: '高风险', colors: '#dc2626, #ef4444, #fb7185', text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500' };
}

function formatNumber(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const [displayed, setDisplayed] = useState(value);
  const prevRef = useRef(value);

  useEffect(() => {
    if (prevRef.current === value) return;
    const start = prevRef.current;
    const diff = value - start;
    const steps = 20;
    const stepTime = 20;
    let step = 0;
    prevRef.current = value;
    const timer = setInterval(() => {
      step++;
      const eased = 1 - Math.pow(1 - step / steps, 3);
      setDisplayed(Math.round(start + diff * eased));
      if (step >= steps) { clearInterval(timer); setDisplayed(value); }
    }, stepTime);
    return () => clearInterval(timer);
  }, [value]);

  return <span className={className}>{formatNumber(displayed)}</span>;
}

function StatCard({ icon: Icon, label, value, sub, trend, color, pulse }: {
  icon: typeof Activity; label: string; value: number; sub?: string;
  trend?: 'up' | 'down' | 'flat'; color: string; pulse?: boolean;
}) {
  return (
    <Card className="glass-card hover:scale-[1.02] transition-transform duration-200 cursor-default">
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className={`rounded-lg p-2 ${color}`}><Icon className="h-4 w-4" /></div>
          {trend && (
            <div className="flex items-center gap-0.5">
              {trend === 'up' && <TrendingUp className="h-3.5 w-3.5 text-red-500" />}
              {trend === 'down' && <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />}
              {trend === 'flat' && <Activity className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
          )}
        </div>
        <div className="mt-3">
          <p className="text-2xl font-bold tracking-tight qs-count-animate">
            <AnimatedNumber value={value} />
            {pulse && value > 0 && <span className="inline-block h-2 w-2 rounded-full bg-red-500 ml-2 qs-pulse-dot" />}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
          {sub && <p className="text-[10px] text-muted-foreground/60 mt-0.5">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function DomainBarChart({ domains }: { domains: Array<{ domain: string; count: number }> }) {
  const top5 = domains.slice(0, 5);
  const maxCount = Math.max(...top5.map(d => d.count), 1);
  const barColors = ['bg-primary/70', 'bg-amber-500/60', 'bg-violet-500/60', 'bg-sky-500/60', 'bg-rose-500/60'];

  if (top5.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
        <Globe className="h-5 w-5 mr-2 opacity-30" />暂无域名数据
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {top5.map((d, i) => (
        <div key={d.domain} className="flex items-center gap-3">
          <span className="text-[11px] font-medium truncate max-w-[120px] shrink-0" title={d.domain}>{d.domain}</span>
          <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-700 ease-out ${barColors[i]}`} style={{ width: `${Math.max(Math.round((d.count / maxCount) * 100), 3)}%` }} />
          </div>
          <span className="text-[11px] font-mono text-muted-foreground w-10 text-right shrink-0">{formatNumber(d.count)}</span>
        </div>
      ))}
    </div>
  );
}

function ThreatIndicator({ threats, total }: { threats: number; total: number }) {
  const cfg = threatLevelConfig(threats);
  const ratio = total > 0 ? (threats / total) * 100 : 0;
  const gradientStyle = { background: `linear-gradient(135deg, ${cfg.colors})`, backgroundSize: '200% 200%' };

  return (
    <div className="relative rounded-xl p-[2px] overflow-hidden">
      <div className="absolute inset-0 qs-gradient-border" style={gradientStyle} />
      <div className="relative rounded-[10px] bg-background/90 backdrop-blur-sm p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldAlert className={`h-5 w-5 ${cfg.text}`} />
            <div>
              <p className="text-xs font-medium">威胁等级</p>
              <p className="text-[10px] text-muted-foreground/60">未解决事件 / 总事件</p>
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2">
              <span className={`text-lg font-bold ${cfg.text}`}>{cfg.label}</span>
              <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot} ${threats > 0 ? 'qs-pulse-dot' : ''}`} />\n            </div>
            <p className="text-[10px] text-muted-foreground font-mono">{threats} / {total} ({Math.round(ratio)}%)</p>
          </div>
        </div>
        <div className="mt-3 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-700 ${cfg.dot}`} style={{ width: `${Math.max(ratio, 1)}%` }} />
        </div>
      </div>
    </div>
  );
}

const REFRESH_MS = 10_000;

export function QuickStatsPanel() {
  const [dashData, setDashData] = useState<DashboardData | null>(null);
  const [rateData, setRateData] = useState<RateStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const results = await Promise.allSettled([
        apiFetch<DashboardData>('/api/admin/anti-crawl/dashboard', { signal, timeout: 10000, silent: true }),
        apiFetch<RateStats>('/api/admin/scraper/rate-limit-stats', { signal, timeout: 10000, silent: true }),
      ]);
      if (signal?.aborted) return;
      const d = results[0].status === 'fulfilled' ? results[0].value : null;
      const r = results[1].status === 'fulfilled' ? results[1].value : null;
      if (d) setDashData(d);
      if (r) setRateData(r);
      if (!d && !r) setError('服务不可达');
      setLastRefresh(new Date());
    } catch {
      if (!signal?.aborted) setError('服务不可达');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
    timerRef.current = setInterval(() => {
      abortRef.current?.abort();
      const nac = new AbortController();
      abortRef.current = nac;
      fetchData(nac.signal);
    }, REFRESH_MS);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [fetchData]);

  const handleRefresh = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
  };

  const totalRequests = dashData?.total24h ?? 0;
  const total7d = dashData?.total7d ?? 0;
  const avgDaily7d = total7d > 0 ? Math.round(total7d / 7) : 0;
  const requestTrend = getTrendDirection(totalRequests, avgDaily7d);
  const proxySR = dashData?.proxyStats?.successRate ? Math.round(dashData.proxyStats.successRate * 100) : 0;
  const srColor = successRateColor(proxySR);
  const unresolved = dashData?.unresolvedCount ?? 0;
  const avgRT = totalRequests > 0 ? Math.round(200 + (unresolved / totalRequests) * 800) : 0;
  const rtColor = responseTimeColor(avgRT);
  const activeThreats = unresolved;
  const hasRealDomainData = (dashData?.topDomains?.length ?? 0) > 0;
  const domains = hasRealDomainData ? dashData.topDomains! : [];

  const content = error && !dashData ? (
    <Card className="glass-card">
      <CardContent className="py-8 flex flex-col items-center gap-2 text-muted-foreground">
        <ShieldAlert className="h-8 w-8 opacity-30" />
        <p className="text-xs">{error}</p>
        <Button variant="outline" size="sm" className="mt-2 text-xs" onClick={handleRefresh}>
          <RefreshCw className="h-3 w-3 mr-1" />重试
        </Button>
      </CardContent>
    </Card>
  ) : (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Activity} label="总请求数 (24h)" value={totalRequests} sub={`7天日均 ${avgDaily7d}`} trend={requestTrend} color="bg-primary/10" />
        <StatCard icon={Zap} label="请求成功率" value={proxySR} sub={proxySR >= 90 ? '运行良好' : proxySR >= 70 ? '需要关注' : '严重下降'} color={srColor.bg} />
        <StatCard icon={Clock} label="平均响应时间（估算）" value={avgRT} sub="ms" color={rtColor.bg} />
        <StatCard icon={ShieldAlert} label="活跃威胁" value={activeThreats} sub="未解决事件" color="bg-red-500/10" pulse />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="glass-card">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-medium flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 text-primary" />域名请求分布 TOP 5
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">{hasRealDomainData ? <DomainBarChart domains={domains} /> : (
            <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
              <Globe className="h-5 w-5 mr-2 opacity-30" />暂无请求数据
            </div>
          )}</CardContent>
        </Card>
        <Card className="glass-card">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-medium flex items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-primary" />系统威胁等级
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ThreatIndicator threats={activeThreats} total={totalRequests || 1} />
            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-background/50 border p-2.5 text-center">
                <p className={`text-sm font-bold ${srColor.text}`}>{proxySR}%</p>
                <p className="text-[9px] text-muted-foreground">成功率</p>
              </div>
              <div className="rounded-lg bg-background/50 border p-2.5 text-center">
                <p className={`text-sm font-bold ${rtColor.text}`}>{avgRT}<span className="text-[9px] ml-0.5">ms</span></p>
                <p className="text-[9px] text-muted-foreground">响应</p>
              </div>
              <div className="rounded-lg bg-background/50 border p-2.5 text-center">
                <p className="text-sm font-bold">{rateData?.totalDomains ?? dashData?.topDomains?.length ?? 0}</p>
                <p className="text-[9px] text-muted-foreground">域名</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          <h3 className="text-xs font-medium">实时概览</h3>
          {lastRefresh && (
            <span className="text-[10px] text-muted-foreground/60">
              更新于 {lastRefresh.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            10s 自动刷新
          </Badge>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleRefresh} disabled={loading}>
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>
      </div>
      {content}
    </div>
  );
}
