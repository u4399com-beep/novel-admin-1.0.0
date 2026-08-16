'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, ArrowLeft, RefreshCw, Loader2, Clock } from 'lucide-react';
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
    } catch {
      // handled by apiFetch
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [eventTypeFilter]);

  useEffect(() => {
    fetchAcRef.current?.abort();
    const ac = new AbortController();
    fetchAcRef.current = ac;
    fetchData(ac.signal);
    return () => { fetchAcRef.current?.abort(); fetchAcRef.current = null; };
  }, [fetchData]);

  const handleRefresh = () => {
    fetchAcRef.current?.abort();
    const ac = new AbortController();
    fetchAcRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
  };

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

            {/* Anti-Crawl Capability Overview */}
            <AntiCrawlCapabilityPanel />

            {/* Fingerprint Health */}
            <FingerprintHealthPanel />

            {/* Alert Config */}
            <AlertConfigPanel />

            {/* Proxy Pool Management */}
            <ProxyPoolPanel />

            {/* Cookie Manager */}
            <CookieManagerPanel />
          </motion.div>
        </AnimatePresence>
      ) : null}
    </div>
  );
}
