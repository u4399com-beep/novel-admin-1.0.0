'use client';

import React from 'react';
import { motion } from 'framer-motion';
import {
  Shield, Lock, Fingerprint, Type, Wifi,
  Activity, MousePointer, AlertTriangle,
  CheckCircle, XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/format';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AntiCrawlEvent {
  id: string;
  taskId: string | null;
  ruleId: string | null;
  eventType: string;
  level: number;
  detail: string | null;
  domain: string | null;
  proxyIp: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

export const EVENT_META: Record<string, { label: string; icon: typeof Shield; color: string; bg: string }> = {
  captcha_triggered: { label: '验证码触发', icon: Lock, color: 'text-destructive', bg: 'bg-destructive/10' },
  proxy_exhausted: { label: '代理耗尽', icon: Wifi, color: 'text-orange-500', bg: 'bg-orange-500/10' },
  font_updated: { label: '字体更新', icon: Type, color: 'text-sky-500', bg: 'bg-sky-500/10' },
  tls_blocked: { label: 'TLS拦截', icon: Fingerprint, color: 'text-chart-amber', bg: 'bg-chart-amber/10' },
  rate_limited: { label: '频率限制', icon: Activity, color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
  behavior_flagged: { label: '行为标记', icon: MousePointer, color: 'text-violet-500', bg: 'bg-violet-500/10' },
};

// ─── Event Row ───────────────────────────────────────────────────────────────

const EventRow = React.memo(function EventRow({ event }: { event: AntiCrawlEvent }) {
  const meta = EVENT_META[event.eventType] || {
    label: event.eventType,
    icon: AlertTriangle,
    color: 'text-muted-foreground',
    bg: 'bg-muted',
  };
  const Icon = meta.icon;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2.5 hover:bg-muted/30 transition-colors group/ev"
    >
      <div className={`rounded-md p-1.5 shrink-0 ${meta.bg}`}>
        <Icon className={`h-3.5 w-3.5 ${meta.color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{meta.label}</span>
          <Badge variant="outline" className="text-[9px] px-1 py-0 font-normal">
            Lv.{event.level}
          </Badge>
          {event.resolved ? (
            <CheckCircle className="h-3 w-3 text-chart-emerald" />
          ) : (
            <XCircle className="h-3 w-3 text-destructive" />
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
          {event.domain && (
            <span className="truncate max-w-[160px]" title={event.domain}>{event.domain}</span>
          )}
          {event.proxyIp && (
            <Badge variant="secondary" className="text-[9px] px-1 py-0 font-mono">
              {event.proxyIp}
            </Badge>
          )}
        </div>
        {event.detail && (
          <p className="text-[10px] text-muted-foreground/60 mt-0.5 truncate">{event.detail}</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeTime(event.createdAt)}
        </span>
      </div>
    </motion.div>
  );
});

// ─── EventList Props ───────────────────────────────────────────────────────────

interface EventListProps {
  events: AntiCrawlEvent[];
}

// ─── EventList Component ──────────────────────────────────────────────────────

export function EventList({ events }: EventListProps) {
  return (
    <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1 scrollbar-thin">
      {events.length > 0 ? (
        events.map((event) => <EventRow key={event.id} event={event} />)
      ) : (
        <div className="flex flex-col items-center justify-center py-8 text-xs text-muted-foreground gap-2">
          <XCircle className="h-8 w-8 text-muted-foreground/30" />
          <span>暂无反爬事件记录</span>
        </div>
      )}
    </div>
  );
}
