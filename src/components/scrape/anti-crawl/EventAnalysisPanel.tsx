'use client';

import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart3, CheckCircle, AlertTriangle,
  Lock, Shield, Wifi, XCircle, Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';
import { formatRelativeTime } from '@/lib/format';
import { type DashboardStats } from './MonitorStats';
import { type AntiCrawlEvent, EVENT_META } from './EventList';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AlertThresholds {
  captchaPerHour: number;
  blockRate: number;
  consecutiveFails: number;
  proxyFailRate: number;
}

interface EventAnalysisPanelProps {
  stats: DashboardStats;
  events: AntiCrawlEvent[];
}

interface Recommendation {
  icon: typeof AlertTriangle;
  color: string;
  bg: string;
  message: string;
}

// ─── Hourly Bar Chart (Pure CSS) ─────────────────────────────────────────────

function HourlyBarChart({ data }: { data: Array<{ hour: string; count: number }> }) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="flex items-end gap-[3px] h-24 px-1">
      {data.map((d, i) => {
        const height = (d.count / maxCount) * 100;
        const hourLabel = d.hour.slice(11, 13);
        const showLabel = i % 3 === 0;
        return (
          <div
            key={d.hour}
            className="flex-1 flex flex-col items-center gap-1 group/hbar relative"
          >
            {/* Tooltip */}
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-popover border rounded px-1.5 py-0.5 text-[10px] font-mono opacity-0 group-hover/hbar:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
              {hourLabel}:00 — {d.count} 次
            </div>
            <div
              className="w-full rounded-t-sm bg-primary/60 hover:bg-primary/80 transition-colors"
              style={{ height: `${Math.max(height, 3)}%` }}
            />
            {showLabel && (
              <span className="text-[8px] text-muted-foreground/50">{hourLabel}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Recommendations ─────────────────────────────────────────────────────────

function Recommendations({
  stats,
  thresholds,
}: {
  stats: DashboardStats;
  thresholds: AlertThresholds;
}) {
  const recs: Recommendation[] = [];

  const captchaCount = stats.events24h?.captcha_triggered ?? 0;
  if (captchaCount > thresholds.captchaPerHour) {
    recs.push({
      icon: Lock,
      color: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-500/10',
      message: '验证码触发频繁，建议：增加请求间隔、启用代理轮换、考虑使用Playwright引擎',
    });
  }

  // Block rate = unresolved / total24h
  const blockRate = stats.total24h > 0
    ? Math.round((stats.unresolvedCount / stats.total24h) * 100)
    : 0;
  if (blockRate > thresholds.blockRate) {
    recs.push({
      icon: Shield,
      color: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-500/10',
      message: '封锁率过高，建议：更换代理池、降低并发数、添加随机延迟',
    });
  }

  // Proxy fail rate
  const proxyFailRate = stats.proxyStats
    ? Math.round((1 - stats.proxyStats.successRate) * 100)
    : 0;
  if (proxyFailRate > thresholds.proxyFailRate && stats.proxyStats) {
    recs.push({
      icon: Wifi,
      color: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-500/10',
      message: '代理失败率高，建议：检查代理配置、更换代理供应商',
    });
  }

  if (recs.length === 0) {
    recs.push({
      icon: CheckCircle,
      color: 'text-emerald-600 dark:text-emerald-400',
      bg: 'bg-emerald-500/10',
      message: '当前反爬状态良好，无需调整',
    });
  }

  return (
    <div className="space-y-2">
      {recs.map((rec, i) => {
        const Icon = rec.icon;
        return (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            className="flex items-start gap-2.5 rounded-lg border p-3"
          >
            <div className={`rounded-md p-1.5 shrink-0 mt-0.5 ${rec.bg}`}>
              <Icon className={`h-3.5 w-3.5 ${rec.color}`} />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{rec.message}</p>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Event Timeline ──────────────────────────────────────────────────────────

function EventTimeline({ events }: { events: AntiCrawlEvent[] }) {
  const timelineEvents = events.slice(0, 10);

  if (timelineEvents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground gap-2">
        <XCircle className="h-6 w-6 text-muted-foreground/30" />
        <span>暂无事件</span>
      </div>
    );
  }

  return (
    <div className="relative space-y-0">
      {/* Vertical line */}
      <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" />
      {timelineEvents.map((event, i) => {
        const meta = EVENT_META[event.eventType] || {
          label: event.eventType,
          icon: AlertTriangle,
          color: 'text-muted-foreground',
          bg: 'bg-muted',
        };
        const Icon = meta.icon;
        return (
          <motion.div
            key={event.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className="flex items-start gap-3 py-2 relative"
          >
            {/* Dot on the timeline */}
            <div className={`relative z-10 rounded-full p-[3px] shrink-0 mt-0.5 ${meta.bg}`}>
              <Icon className={`h-2.5 w-2.5 ${meta.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium">{meta.label}</span>
                <Badge
                  variant={event.level >= 3 ? 'destructive' : 'outline'}
                  className="text-[9px] px-1 py-0 font-normal"
                >
                  Lv.{event.level}
                </Badge>
              </div>
              {event.detail && (
                <p className="text-[10px] text-muted-foreground/60 mt-0.5 truncate">
                  {event.detail}
                </p>
              )}
              {event.domain && (
                <p className="text-[10px] text-muted-foreground/40 mt-0.5 truncate">
                  {event.domain}
                </p>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground/50 shrink-0 whitespace-nowrap">
              {formatRelativeTime(event.createdAt)}
            </span>
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Main EventAnalysisPanel ─────────────────────────────────────────────────

const FALLBACK_THRESHOLDS: AlertThresholds = {
  captchaPerHour: 10,
  blockRate: 30,
  consecutiveFails: 5,
  proxyFailRate: 50,
};

export function EventAnalysisPanel({ stats, events }: EventAnalysisPanelProps) {
  const [thresholds, setThresholds] = useState<AlertThresholds | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    apiFetch<{
      thresholds: AlertThresholds;
      enabled: boolean;
    }>('/api/admin/anti-crawl/alert-config', { silent: true })
      .then((data) => {
        if (!cancelled && mountedRef.current) setThresholds(data.thresholds);
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setThresholds(FALLBACK_THRESHOLDS);
      });
    return () => { cancelled = true; mountedRef.current = false; };
  }, []);

  // Build hourly distribution from captchaTrend (already has 24h hourly buckets)
  const hourlyData = stats.captchaTrend || [];

  return (
    <div className="space-y-3">
      {/* Section 1: 事件时间分布 */}
      <Card className="glass-card">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-xs font-medium flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-primary" />
            事件时间分布（24h）
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {hourlyData.length > 0 ? (
            <HourlyBarChart data={hourlyData} />
          ) : (
            <div className="flex items-center justify-center h-24 text-xs text-muted-foreground">
              暂无数据
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: 响应建议 */}
      <Card className="glass-card">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-xs font-medium flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-primary" />
            响应建议
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {thresholds ? (
            <Recommendations stats={stats} thresholds={thresholds} />
          ) : (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 3: 最近事件时间线 */}
      <Card className="glass-card">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-xs font-medium flex items-center gap-2">
            <Shield className="h-3.5 w-3.5 text-primary" />
            最近事件时间线
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 max-h-80 overflow-y-auto scrollbar-thin">
          <EventTimeline events={events} />
        </CardContent>
      </Card>
    </div>
  );
}
