'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  ShieldAlert, RefreshCw, Loader2, Search, Filter,
  AlertTriangle, Clock, Shield, WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DetectionSignal {
  type: 'captcha' | 'block' | 'rate_limit' | 'redirect' | 'empty_content' | 'slow_response' | 'fingerprint_detect' | 'js_challenge';
  domain: string;
  count: number;
  lastSeen: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details?: string;
}

interface DomainSignalsResponse {
  domain: string;
  signals: DetectionSignal[];
  serviceReachable: boolean;
}

interface CaptchaEvent {
  id: string;
  domain: string;
  type: 'cloudflare' | 'geetest' | 'recaptcha' | 'custom';
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  timestamp: number;
  details?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const CAPTCHA_TYPE_CONFIG: Record<string, { label: string; bg: string; text: string; dot: string; bar: string }> = {
  cloudflare: { label: 'Cloudflare', bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400', dot: 'bg-orange-500', bar: 'bg-orange-500' },
  geetest:    { label: 'GeeTest',    bg: 'bg-red-100 dark:bg-red-900/30',       text: 'text-red-700 dark:text-red-400',       dot: 'bg-red-500', bar: 'bg-red-500' },
  recaptcha:  { label: 'reCAPTCHA',  bg: 'bg-sky-100 dark:bg-sky-900/30',       text: 'text-sky-700 dark:text-sky-400',       dot: 'bg-sky-500', bar: 'bg-sky-500' },
  custom:     { label: '通用',     bg: 'bg-gray-100 dark:bg-gray-900/30',     text: 'text-gray-700 dark:text-gray-400',     dot: 'bg-gray-500', bar: 'bg-gray-500' },
};

const SEVERITY_CONFIG: Record<string, { label: string; bg: string; text: string }> = {
  low:      { label: '低',   bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400' },
  medium:   { label: '中',   bg: 'bg-yellow-100 dark:bg-yellow-900/30',   text: 'text-yellow-700 dark:text-yellow-400' },
  high:     { label: '高',   bg: 'bg-orange-100 dark:bg-orange-900/30',   text: 'text-orange-700 dark:text-orange-400' },
  critical: { label: '严重', bg: 'bg-red-100 dark:bg-red-900/30',       text: 'text-red-700 dark:text-red-400' },
};

// ─── Mock / Fallback Data ────────────────────────────────────────────────────

function generateMockEvents(): CaptchaEvent[] {
  const types: CaptchaEvent['type'][] = ['cloudflare', 'geetest', 'recaptcha', 'custom'];
  const domains = ['example.com', 'api.target.com', 'shop.demo.cn', 'data.test.org', 'cdn.static.net'];
  const severities: CaptchaEvent['severity'][] = ['low', 'medium', 'high', 'critical'];
  const now = Date.now();
  return Array.from({ length: 8 }, (_, i) => ({
    id: `mock-${i}`,
    domain: domains[i % domains.length],
    type: types[i % types.length],
    severity: severities[Math.floor(Math.random() * 4)],
    confidence: 40 + Math.floor(Math.random() * 60),
    timestamp: now - (i * 3 + Math.floor(Math.random() * 3)) * 60_000,
    details: i % 2 === 0 ? '检测到验证码页面 (85%)' : undefined,
  }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCaptchaType(detail?: string): CaptchaEvent['type'] {
  if (!detail) return 'custom';
  const lower = detail.toLowerCase();
  if (lower.includes('cloudflare') || lower.includes('cf') || lower.includes('challenge')) return 'cloudflare';
  if (lower.includes('geetest') || lower.includes('gee')) return 'geetest';
  if (lower.includes('recaptcha') || lower.includes('re-captcha') || lower.includes('google')) return 'recaptcha';
  return 'custom';
}

function parseConfidence(detail?: string): number {
  if (!detail) return 50;
  const match = detail.match(/(\d+)%/);
  return match ? Math.min(100, Math.max(0, parseInt(match[1], 10))) : 50;
}

function formatTimeAgo(ts: number): string {
  if (!ts) return '未知';
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function confidenceBarColor(confidence: number): string {
  if (confidence >= 80) return 'bg-red-500';
  if (confidence >= 60) return 'bg-orange-500';
  if (confidence >= 40) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

// ─── Confidence Bar ───────────────────────────────────────────────────────────

function ConfidenceBar({ confidence }: { confidence: number }) {
  return (
    <div className="flex items-center gap-1.5 w-24">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${confidenceBarColor(confidence)}`}
          style={{ width: `${confidence}%` }}
        />
      </div>
      <span className="text-[9px] font-mono text-muted-foreground w-7 text-right">
        {confidence}%
      </span>
    </div>
  );
}

// ─── Summary Row (enhanced) ──────────────────────────────────────────────────

function CaptchaSummaryRow({ events }: { events: CaptchaEvent[] }) {
  const totalCount = events.length;
  const cloudflareCount = events.filter(e => e.type === 'cloudflare').length;
  const geetestCount = events.filter(e => e.type === 'geetest').length;
  const recaptchaCount = events.filter(e => e.type === 'recaptcha').length;
  const customCount = events.filter(e => e.type === 'custom').length;
  const highSevCount = events.filter(e => e.severity === 'high' || e.severity === 'critical').length;

  const types = [
    { label: 'Cloudflare', count: cloudflareCount, config: CAPTCHA_TYPE_CONFIG.cloudflare },
    { label: 'GeeTest', count: geetestCount, config: CAPTCHA_TYPE_CONFIG.geetest },
    { label: 'reCAPTCHA', count: recaptchaCount, config: CAPTCHA_TYPE_CONFIG.recaptcha },
    { label: '通用', count: customCount, config: CAPTCHA_TYPE_CONFIG.custom },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2.5">
      {/* Total */}
      <div className="rounded-lg border bg-background/50 backdrop-blur-sm p-3">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          <ShieldAlert className="h-3.5 w-3.5" />
          <span className="text-[10px]">CAPTCHA 总计</span>
        </div>
        <p className="text-xl font-bold">{totalCount}</p>
      </div>

      {/* Type breakdown */}
      {types.map(t => (
        <div key={t.label} className="rounded-lg border bg-background/50 backdrop-blur-sm p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <div className={`h-2 w-2 rounded-full ${t.config.dot}`} />
            <span className={`text-[10px] ${t.config.text}`}>{t.label}</span>
          </div>
          <p className={`text-xl font-bold ${t.config.text}`}>{t.count}</p>
        </div>
      ))}

      {/* High severity */}
      <div className="rounded-lg border bg-background/50 backdrop-blur-sm p-3">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span className="text-[10px]">高危事件</span>
        </div>
        <p className="text-xl font-bold text-red-600 dark:text-red-400">{highSevCount}</p>
      </div>
    </div>
  );
}

// ─── Horizontal Timeline ─────────────────────────────────────────────────────

function CaptchaTimeline({ events }: { events: CaptchaEvent[] }) {
  const timelineEvents = events.slice(0, 20);

  if (timelineEvents.length === 0) {
    return (
      <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">
        暂无 CAPTCHA 事件
      </div>
    );
  }

  // Calculate time range
  const timestamps = timelineEvents.map(e => e.timestamp).filter(Boolean);
  const timeMin = Math.min(...timestamps);
  const timeMax = Math.max(...timestamps);
  const timeRange = timeMax - timeMin || 1;

  const severityDotSize: Record<string, string> = {
    low: 'h-2.5 w-2.5',
    medium: 'h-3 w-3',
    high: 'h-3.5 w-3.5',
    critical: 'h-4 w-4',
  };

  return (
    <div className="ct-timeline-fade">
      {/* Timeline track */}
      <div className="relative px-2 py-3">
        {/* Base line */}
        <div className="absolute top-1/2 left-2 right-2 h-px bg-border -translate-y-1/2" />

        {/* Time range labels */}
        <div className="flex justify-between mb-1">
          <span className="text-[9px] text-muted-foreground/50">{formatTimeAgo(timeMax)}</span>
          <span className="text-[9px] text-muted-foreground/50">{formatTimeAgo(timeMin)}</span>
        </div>

        {/* Dots */}
        <div className="relative flex items-center justify-between h-8">
          {timelineEvents.map((event, i) => {
            const typeConfig = CAPTCHA_TYPE_CONFIG[event.type] || CAPTCHA_TYPE_CONFIG.custom;
            const pos = timeRange > 0 ? ((event.timestamp - timeMin) / timeRange) * 100 : 50;
            const dotSize = severityDotSize[event.severity] || severityDotSize.medium;
            const isCritical = event.severity === 'critical';

            return (
              <div
                key={event.id}
                className={`absolute flex flex-col items-center ct-dot-appear ${isCritical ? 'animate-pulse' : ''}`}
                style={{
                  left: `${Math.max(Math.min(pos, 98), 2)}%`,
                  animationDelay: `${i * 50}ms`,
                }}
                title={`${event.domain} - ${typeConfig.label} - ${formatTimeAgo(event.timestamp)}`}
              >
                <div
                  className={`${dotSize} rounded-full ${typeConfig.dot} cursor-pointer transition-transform hover:scale-150 border-2 border-background shadow-sm`}
                />
                {/* Show domain label for first and every 5th */}
                {(i === 0 || i === timelineEvents.length - 1 || i % 5 === 0) && (
                  <span className="text-[7px] text-muted-foreground/50 mt-1 whitespace-nowrap max-w-[60px] truncate">
                    {event.domain.replace(/^www\./, '')}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-4 mt-1">
          {Object.entries(CAPTCHA_TYPE_CONFIG).map(([key, config]) => (
            <div key={key} className="flex items-center gap-1">
              <div className={`h-2 w-2 rounded-full ${config.dot}`} />
              <span className="text-[9px] text-muted-foreground">{config.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Captcha Event Row ───────────────────────────────────────────────────────

function CaptchaEventRow({ event }: { event: CaptchaEvent }) {
  const typeConfig = CAPTCHA_TYPE_CONFIG[event.type] || CAPTCHA_TYPE_CONFIG.custom;
  const severityConfig = SEVERITY_CONFIG[event.severity] || SEVERITY_CONFIG.medium;

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-background/50 backdrop-blur-sm px-3 py-2.5 hover:bg-muted/20 transition-all duration-200 group/ev">
      {/* Type badge */}
      <div className={`shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium ${typeConfig.bg} ${typeConfig.text}`}>
        <div className={`h-1.5 w-1.5 rounded-full ${typeConfig.dot}`} />
        {typeConfig.label}
      </div>

      {/* Domain */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate" title={event.domain}>
            {event.domain}
          </span>
          <Badge variant="outline" className={`text-[9px] px-1 py-0 font-normal shrink-0 ${severityConfig.bg} ${severityConfig.text}`}>
            {severityConfig.label}
          </Badge>
        </div>
        {event.details && (
          <p className="text-[10px] text-muted-foreground/60 mt-0.5 truncate">
            {event.details}
          </p>
        )}
      </div>

      {/* Confidence bar */}
      <ConfidenceBar confidence={event.confidence} />

      {/* Timestamp */}
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
        <Clock className="h-3 w-3" />
        <span className="whitespace-nowrap">{formatTimeAgo(event.timestamp)}</span>
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 15_000;

export function CaptchaEventsPanel() {
  const [events, setEvents] = useState<CaptchaEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [unreachable, setUnreachable] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEvents = useCallback(async (signal?: AbortSignal) => {
    let success = false;
    try {
      // Fetch rate-limit-stats to get domain list, then fetch signals for each domain
      const rateData = await apiFetch<{ domains: Array<{ domain: string }> }>(
        '/api/admin/scraper/rate-limit-stats',
        { signal, timeout: 8000, silent: true }
      );

      if (signal?.aborted) return;

      const domains = rateData?.domains?.map(d => d.domain) || [];

      // Also fetch delay stats to get additional domains
      let delayDomains: string[] = [];
      try {
        const delayData = await apiFetch<{ domains: Array<{ domain: string }> }>(
          '/api/admin/scraper/delay-stats',
          { signal, timeout: 8000, silent: true }
        );
        if (delayData?.domains) {
          const existingSet = new Set(domains);
          for (const d of delayData.domains) {
            if (!existingSet.has(d.domain)) {
              domains.push(d.domain);
            }
          }
        }
      } catch { /* ignore */ }

      // Fetch signals for each domain
      const allEvents: CaptchaEvent[] = [];
      const signalPromises = domains.map(async (domain) => {
        try {
          const data = await apiFetch<DomainSignalsResponse>(
            `/api/admin/anti-crawl/domain-signals?domain=${encodeURIComponent(domain)}`,
            { signal, timeout: 6000, silent: true }
          );
          if (!data?.signals) return;
          for (const sig of data.signals) {
            if (sig.type === 'captcha' || sig.type === 'js_challenge') {
              allEvents.push({
                id: `${domain}-${sig.type}-${sig.lastSeen}`,
                domain: sig.domain || domain,
                type: parseCaptchaType(sig.details),
                severity: sig.severity,
                confidence: parseConfidence(sig.details),
                timestamp: sig.lastSeen,
                details: sig.details,
              });
            }
          }
        } catch { /* skip this domain */ }
      });

      await Promise.allSettled(signalPromises);

      if (!signal?.aborted) {
        // Sort by timestamp descending
        allEvents.sort((a, b) => b.timestamp - a.timestamp);
        setEvents(allEvents);
        setUnreachable(false);
        success = true;
      }
    } catch {
      if (!signal?.aborted) {
        setUnreachable(true);
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setLastRefresh(new Date());
        if (!success) {
          // Use mock data when unreachable
          setUnreachable(true);
        }
      }
    }
  }, []);

  // Initial fetch + auto-refresh
  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchEvents(ac.signal);

    timerRef.current = setInterval(() => {
      abortRef.current?.abort();
      const newAc = new AbortController();
      abortRef.current = newAc;
      fetchEvents(newAc.signal);
    }, REFRESH_INTERVAL);

    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [fetchEvents]);

  const handleRefresh = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchEvents(ac.signal);
  };

  // Filter events
  const filteredEvents = events.filter(ev => {
    const matchesSearch = !searchQuery || ev.domain.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = typeFilter === 'all' || ev.type === typeFilter;
    return matchesSearch && matchesType;
  });

  // Use mock data when unreachable and no real events (single source via useMemo)
  const mockEventCount = (unreachable && events.length === 0) ? 8 : 0;
  const mockEvents = useMemo(() => generateMockEvents(), [mockEventCount]);
  const displayEvents = mockEventCount > 0 ? mockEvents : events;
  const displayFiltered = mockEventCount > 0
    ? mockEvents.filter(ev => {
        const matchesSearch = !searchQuery || ev.domain.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesType = typeFilter === 'all' || ev.type === typeFilter;
        return matchesSearch && matchesType;
      })
    : filteredEvents;

  return (
    <div className="space-y-4">
      {/* Unreachable banner */}
      {unreachable && events.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>服务不可达，显示模拟数据</span>
        </div>
      )}

      {/* Enhanced Summary Row */}
      <CaptchaSummaryRow events={displayEvents} />

      {/* Timeline Visualization */}
      <div className="rounded-lg border bg-background/50 backdrop-blur-sm">
        <div className="flex items-center justify-between px-4 py-2.5 border-b">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium">CAPTCHA 事件时间线</span>
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
              最近 {Math.min(displayEvents.length, 20)} 条
            </Badge>
          </div>
          {lastRefresh && (
            <span className="text-[9px] text-muted-foreground/50">
              {lastRefresh.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
        <div className="px-3 py-2">
          <CaptchaTimeline events={displayEvents} />
        </div>
      </div>

      {/* Search and filter bar */}
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
        <div className="flex items-center gap-1">
          <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
          {(['all', 'cloudflare', 'geetest', 'recaptcha', 'custom'] as const).map((t) => {
            const config = t === 'all'
              ? { label: '全部', bg: 'bg-muted', text: 'text-foreground' }
              : CAPTCHA_TYPE_CONFIG[t];
            const isActive = typeFilter === t;
            return (
              <Button
                key={t}
                variant={isActive ? 'default' : 'outline'}
                size="sm"
                className={`h-7 text-[10px] px-2 ${!isActive ? `${config.bg} ${config.text} hover:${config.bg}` : ''}`}
                onClick={() => setTypeFilter(t)}
              >
                {config.label}
              </Button>
            );
          })}
        </div>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-normal gap-1 hidden sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          15s
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

      {/* Events list */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-xs">加载 CAPTCHA 事件...</span>
        </div>
      ) : displayFiltered.length > 0 ? (
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1 scrollbar-thin">
          {displayFiltered.map((event) => (
            <CaptchaEventRow key={event.id} event={event} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
          <Shield className="h-8 w-8 opacity-30" />
          <p className="text-xs">
            {searchQuery || typeFilter !== 'all' ? '无匹配的 CAPTCHA 事件' : '暂无 CAPTCHA 检测记录'}
          </p>
        </div>
      )}
    </div>
  );
}
