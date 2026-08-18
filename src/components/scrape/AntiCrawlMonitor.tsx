'use client';

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, ArrowLeft, RefreshCw, Loader2, Clock, Globe, Server, ListOrdered, AlertTriangle } from 'lucide-react';
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

// ─── Lazy-loaded panels (only mounted when their tab is active) ──────────────

const QuickStatsPanel = lazy(() => import('./anti-crawl/QuickStatsPanel').then(m => ({ default: m.QuickStatsPanel })));
const EventAnalysisPanel = lazy(() => import('./anti-crawl/EventAnalysisPanel').then(m => ({ default: m.EventAnalysisPanel })));
const AlertConfigPanel = lazy(() => import('./anti-crawl/AlertConfigPanel').then(m => ({ default: m.AlertConfigPanel })));
const CookieManagerPanel = lazy(() => import('./anti-crawl/CookieManagerPanel').then(m => ({ default: m.CookieManagerPanel })));
const AntiCrawlCapabilityPanel = lazy(() => import('./anti-crawl/AntiCrawlCapabilityPanel').then(m => ({ default: m.AntiCrawlCapabilityPanel })));
const ProxyPoolPanel = lazy(() => import('./anti-crawl/ProxyPoolPanel').then(m => ({ default: m.ProxyPoolPanel })));
const FingerprintHealthPanel = lazy(() => import('./anti-crawl/FingerprintHealthPanel').then(m => ({ default: m.FingerprintHealthPanel })));
const AdaptiveDelayPanel = lazy(() => import('./anti-crawl/AdaptiveDelayPanel').then(m => ({ default: m.AdaptiveDelayPanel })));
const RateLimiterPanel = lazy(() => import('./anti-crawl/RateLimiterPanel').then(m => ({ default: m.RateLimiterPanel })));
const CookiePersistPanel = lazy(() => import('./anti-crawl/CookiePersistPanel').then(m => ({ default: m.CookiePersistPanel })));
const ProxyTestPanel = lazy(() => import('./anti-crawl/ProxyTestPanel').then(m => ({ default: m.ProxyTestPanel })));
const SessionManagerPanel = lazy(() => import('./anti-crawl/SessionManagerPanel').then(m => ({ default: m.SessionManagerPanel })));
const RequestFingerprintPanel = lazy(() => import('./anti-crawl/RequestFingerprintPanel').then(m => ({ default: m.RequestFingerprintPanel })));
const AntiCrawlSimPanel = lazy(() => import('./anti-crawl/AntiCrawlSimPanel').then(m => ({ default: m.AntiCrawlSimPanel })));
const AntiCrawlAdvisorPanel = lazy(() => import('./anti-crawl/AntiCrawlAdvisorPanel').then(m => ({ default: m.AntiCrawlAdvisorPanel })));
const PriorityQueuePanel = lazy(() => import('./anti-crawl/PriorityQueuePanel').then(m => ({ default: m.PriorityQueuePanel })));
const QualityScorePanel = lazy(() => import('./anti-crawl/QualityScorePanel').then(m => ({ default: m.QualityScorePanel })));

// ─── Tab definitions ──────────────────────────────────────────────────────────

interface TabDef {
  key: string;
  label: string;
}

const TABS: TabDef[] = [
  { key: 'overview', label: '概览' },
  { key: 'strategy', label: '策略' },
  { key: 'session', label: '会话' },
  { key: 'proxy', label: '代理' },
  { key: 'tools', label: '工具' },
];

// ─── Panel loading fallback ───────────────────────────────────────────────────

function PanelSkeleton() {
  return (
    <div className="rounded-lg border bg-muted/30 p-6 flex items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

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
  const [error, setError] = useState<string | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState('overview');
  const fetchAcRef = useRef<AbortController | null>(null);

  // Summary bar state
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('offline');

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
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
        queueDepth: 0,
      });

      setWsStatus('connected');
    } catch {
      if (!signal?.aborted) {
        setError('无法加载监控数据');
        setWsStatus(prev => prev === 'connected' ? 'reconnecting' : 'offline');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [eventTypeFilter]);

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
          <div className="flex items-center gap-1.5 shrink-0">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">监控域名</span>
            <span className="font-semibold">{summary.activeDomains}</span>
          </div>
          <Separator orientation="vertical" className="h-4 shrink-0" />
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`h-2 w-2 rounded-full ${hc.color}`} />
            <span className={hc.textColor}>{hc.label}</span>
          </div>
          <Separator orientation="vertical" className="h-4 shrink-0" />
          <div className="flex items-center gap-1.5 shrink-0">
            <Server className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">代理</span>
            <span className="font-semibold">{summary.activeProxies}</span>
          </div>
          <Separator orientation="vertical" className="h-4 shrink-0" />
          <div className="flex items-center gap-1.5 shrink-0">
            <ListOrdered className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">队列</span>
            <span className="font-semibold">{summary.queueDepth}</span>
          </div>
          <div className="flex-1" />
          <div className={`flex items-center gap-1.5 shrink-0 ${wc.textColor}`}>
            <span className={`h-2 w-2 rounded-full ${wc.dotColor}`} />
            <span className="hidden sm:inline">{wc.label}</span>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && !stats ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error && !stats ? (
        /* Error state with retry */
        <Card className="glass-card">
          <CardContent className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <AlertTriangle className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">{error}</p>
            <p className="text-xs">请检查 scraper-service 是否运行，或稍后重试</p>
            <Button variant="outline" size="sm" className="mt-2 text-xs" onClick={handleRefresh}>
              <RefreshCw className="h-3 w-3 mr-1.5" />重试
            </Button>
          </CardContent>
        </Card>
      ) : stats ? (
        <AnimatePresence mode="wait">
          <motion.div
            key="dashboard"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-4"
          >
            {/* Always-visible stats */}
            <MonitorStats stats={stats} />

            {/* Tab bar */}
            <div className="flex items-center gap-1 border-b pb-px">
              {TABS.map(tab => (
                <Button
                  key={tab.key}
                  variant="ghost"
                  size="sm"
                  className={`h-8 text-xs px-3 rounded-none border-b-2 transition-colors ${
                    activeTab === tab.key
                      ? 'border-primary text-foreground font-medium'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>

            {/* Tab content — only the active tab renders */}
            <Suspense fallback={<PanelSkeleton />}>
              {activeTab === 'overview' && (
                <div className="space-y-4">
                  <QuickStatsPanel />
                  <EventAnalysisPanel stats={stats} events={events} />
                  <PriorityQueuePanel />
                </div>
              )}
              {activeTab === 'strategy' && (
                <div className="space-y-4">
                  <AntiCrawlCapabilityPanel />
                  <FingerprintHealthPanel />
                  <AdaptiveDelayPanel />
                  <RateLimiterPanel />
                  <CookiePersistPanel />
                </div>
              )}
              {activeTab === 'session' && (
                <div className="space-y-4">
                  <SessionManagerPanel />
                  <RequestFingerprintPanel />
                  <CookieManagerPanel />
                </div>
              )}
              {activeTab === 'proxy' && (
                <div className="space-y-4">
                  <ProxyPoolPanel />
                  <ProxyTestPanel />
                </div>
              )}
              {activeTab === 'tools' && (
                <div className="space-y-4">
                  <AntiCrawlSimPanel />
                  <AntiCrawlAdvisorPanel />
                  <QualityScorePanel />
                  <AlertConfigPanel />
                </div>
              )}
            </Suspense>

            {/* Always-visible recent events */}
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
          </motion.div>
        </AnimatePresence>
      ) : null}
    </div>
  );
}
