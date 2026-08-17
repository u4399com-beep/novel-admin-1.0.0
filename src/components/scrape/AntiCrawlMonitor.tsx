'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, ArrowLeft, RefreshCw, Loader2, Clock, Globe, Server, ListOrdered } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';
import { EventList } from './anti-crawl/EventList';
import { type AntiCrawlEvent } from './anti-crawl/EventList';
import { MonitorStats } from './anti-crawl/MonitorStats';
import { type DashboardStats } from './anti-crawl/MonitorStats';
import { MonitorFilters } from './anti-crawl/MonitorFilters';
import { AlertConfigPanel } from './anti-crawl/AlertConfigPanel';
import { EventAnalysisPanel } from './anti-crawl/EventAnalysisPanel';
import { CookieManagerPanel } from './anti-crawl/CookieManagerPanel';
import { AntiCrawlCapabilityPanel } from './anti-crawl/AntiCrawlCapabilityPanel';
import { ProxyPoolPanel } from './anti-crawl/ProxyPoolPanel';
import { FingerprintHealthPanel } from './anti-crawl/FingerprintHealthPanel';
import { AdaptiveDelayPanel } from './anti-crawl/AdaptiveDelayPanel';
import { RateLimiterPanel } from './anti-crawl/RateLimiterPanel';
import { CookiePersistPanel } from './anti-crawl/CookiePersistPanel';
import { ProxyTestPanel } from './anti-crawl/ProxyTestPanel';
import { SessionManagerPanel } from './anti-crawl/SessionManagerPanel';
import { RequestFingerprintPanel } from './anti-crawl/RequestFingerprintPanel';
import { AntiCrawlSimPanel } from './anti-crawl/AntiCrawlSimPanel';
import { AntiCrawlAdvisorPanel } from './anti-crawl/AntiCrawlAdvisorPanel';
import { PriorityQueuePanel } from './anti-crawl/PriorityQueuePanel';
import { QualityScorePanel } from './anti-crawl/QualityScorePanel';
import { QuickStatsPanel } from './anti-crawl/QuickStatsPanel';

// ─── Summary bar types ────────────────────────────────────────────────────────

interface SummaryData {
  activeDomains: number;
  healthStatus: 'healthy' | 'warning' | 'critical';
  activeProxies: number;
  queueDepth: number;
}

type WsStatus = 'connected' | 'offline' | 'reconnecting';

// ─── Main Monitor ──────────────────────────────────────────────────────────────

interface AntiCrawlMonitorProps {
  onBack: () => void;
}

export function AntiCrawlMonitor({ onBack }: AntiCrawlMonitorProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [events, setEvents] = useState<AntiCrawlEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('all');
  const fetchAcRef = useRef<AbortController | null>(null);

  // Summary bar state
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('offline');

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [dashData, eventsData] = await Promise.all([
        apiFetch<DashboardStats>('/api/admin/anti-crawl/dashboard', { signal, timeout: 15000 }),
        apiFetch<{ events: AntiCrawlEvent[]; total: number }>(
          `/api/admin/anti-crawl/events?pageSize=50&sort=desc${eventTypeFilter !== 'all' ? `&eventType=${eventTypeFilter}` : ''}`,
          { signal, timeout: 15000 }
        ),
      ]);
      if (signal?.aborted) return;
      setStats(dashData);
      setEvents(eventsData.events || []);

      // Derive summary from dashboard data
      const activeDomains = dashData.topDomains?.length || 0;
      const unresolvedRatio = dashData.total24h > 0
        ? dashData.unresolvedCount / dashData.total24h
        : 0;
      const healthStatus: SummaryData['healthStatus'] = unresolvedRatio > 0.5
        ? 'critical'
        : unresolvedRatio > 0.2
          ? 'warning'
          : 'healthy';

      setSummary({
        activeDomains,
        healthStatus,
        activeProxies: dashData.proxyStats?.activeProxies ?? 0,
        queueDepth: 0, // fetched separately
      });

      // Update WS status based on successful fetch
      setWsStatus('connected');
    } catch {
      // handled by apiFetch
      if (!signal?.aborted) {
        setWsStatus(prev => prev === 'connected' ? 'reconnecting' : 'offline');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [eventTypeFilter]);

  // Fetch queue depth separately (lightweight)
  const fetchQueueDepth = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<{ queueSize: number }>('/api/admin/scraper/priority-queue', {
        signal,
        timeout: 5000,
        silent: true,
      });
      if (!signal?.aborted) {
        setSummary(prev => prev ? { ...prev, queueDepth: data.queueSize || 0 } : null);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchAcRef.current?.abort();
    const ac = new AbortController();
    fetchAcRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
    fetchQueueDepth(ac.signal);
    return () => { fetchAcRef.current?.abort(); fetchAcRef.current = null; };
  }, [fetchData, fetchQueueDepth]);

  const handleRefresh = () => {
    fetchAcRef.current?.abort();
    const ac = new AbortController();
    fetchAcRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
    fetchQueueDepth(ac.signal);
  };

  // Health indicator config
  const healthConfig = {
    healthy: { color: 'bg-emerald-500', label: '正常', textColor: 'text-emerald-600 dark:text-emerald-400' },
    warning: { color: 'bg-amber-500', label: '注意', textColor: 'text-amber-600 dark:text-amber-400' },
    critical: { color: 'bg-red-500', label: '告警', textColor: 'text-red-600 dark:text-red-400' },
  };

  // WS status config
  const wsConfig = {
    connected: { dotColor: 'bg-emerald-500', label: '实时连接', textColor: 'text-emerald-600 dark:text-emerald-400' },
    offline: { dotColor: 'bg-gray-400', label: '离线', textColor: 'text-muted-foreground' },
    reconnecting: { dotColor: 'bg-red-500 cp-dot-pulse', label: '重连中', textColor: 'text-red-600 dark:text-red-400' },
  };

  const hc = healthConfig[summary?.healthStatus || 'healthy'];
  const wc = wsConfig[wsStatus];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回
          </Button>
          <Separator orientation="vertical" className="h-6" />
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">反爬监控大屏</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <MonitorFilters value={eventTypeFilter} onChange={setEventTypeFilter} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading} className="h-8">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {/* Status Summary Header Bar */}
      {summary && (
        <div className="flex items-center gap-3 sm:gap-4 px-4 py-2.5 rounded-lg border bg-muted/30 text-[11px] overflow-x-auto">
          {/* Active Domains */}
          <div className="flex items-center gap-1.5 shrink-0">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">监控域名</span>
            <span className="font-semibold">{summary.activeDomains}</span>
          </div>

          <Separator orientation="vertical" className="h-4 shrink-0" />

          {/* System Health */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`h-2 w-2 rounded-full ${hc.color}`} />
            <span className={hc.textColor}>{hc.label}</span>
          </div>

          <Separator orientation="vertical" className="h-4 shrink-0" />

          {/* Active Proxies */}
          <div className="flex items-center gap-1.5 shrink-0">
            <Server className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">代理</span>
            <span className="font-semibold">{summary.activeProxies}</span>
          </div>

          <Separator orientation="vertical" className="h-4 shrink-0" />

          {/* Queue Depth */}
          <div className="flex items-center gap-1.5 shrink-0">
            <ListOrdered className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">队列</span>
            <span className="font-semibold">{summary.queueDepth}</span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* WebSocket Connection Status */}
          <div className={`flex items-center gap-1.5 shrink-0 ${wc.textColor}`}>
            <span className={`h-2 w-2 rounded-full ${wc.dotColor}`} />
            <span className="hidden sm:inline">{wc.label}</span>
          </div>
        </div>
      )}

      {loading && !stats ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : stats ? (
        <AnimatePresence mode="wait">
          <motion.div
            key="dashboard"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-4"
          >
            {/* Stats */}
            <MonitorStats stats={stats} />

            {/* Quick Stats Overview */}
            <QuickStatsPanel />

            {/* Event Analysis */}
            <EventAnalysisPanel stats={stats} events={events} />

            {/* Recent Events */}
            <Card className="glass-card">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-medium flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5 text-primary" />
                    最近事件
                    <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
                      {events.length} 条
                    </Badge>
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <EventList events={events} />
              </CardContent>
            </Card>

            {/* Priority Queue Management */}
            <PriorityQueuePanel />

            {/* Anti-Crawl Capability Overview */}
            <AntiCrawlCapabilityPanel />

            {/* Fingerprint Health */}
            <FingerprintHealthPanel />

            {/* Adaptive Delay Control */}
            <AdaptiveDelayPanel />

            {/* Rate Limiter */}
            <RateLimiterPanel />

            {/* Cookie Persistence */}
            <CookiePersistPanel />

            {/* Proxy Test */}
            <ProxyTestPanel />

            {/* Session Manager */}
            <SessionManagerPanel />

            {/* Request Fingerprint */}
            <RequestFingerprintPanel />

            {/* Anti-Crawl Simulation Test */}
            <AntiCrawlSimPanel />

            {/* Anti-Crawl Strategy Advisor */}
            <AntiCrawlAdvisorPanel />

            {/* Quality Scoring */}
            <QualityScorePanel />

            {/* Alert Config */}
            <AlertConfigPanel />

            {/* Proxy Pool Management */}
            <ProxyPoolPanel />
          </motion.div>
        </AnimatePresence>
      ) : null}
    </div>
  );
}
