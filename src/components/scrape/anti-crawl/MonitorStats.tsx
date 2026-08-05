'use client';

import React from 'react';
import { motion } from 'framer-motion';
import {
  Shield, Lock, Server, XCircle,
  TrendingUp, TrendingDown, Minus,
  Clock, Eye, Bot, BarChart3, Globe, Wifi,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime } from '@/lib/format';
import { EVENT_META } from './EventList';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DashboardStats {
  events24h: Record<string, number>;
  events7d: Record<string, number>;
  captchaTrend: Array<{ hour: string; count: number }>;
  topDomains: Array<{ domain: string; count: number }>;
  unresolvedCount: number;
  total24h: number;
  total7d: number;
  proxyStats: {
    totalProxies: number;
    activeProxies: number;
    avgScore: number;
    successRate: number;
    totalRequests: number;
    capturedAt: string | null;
  } | null;
}

// ─── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, trend, color }: {
  icon: typeof Shield;
  label: string;
  value: string | number;
  sub?: string;
  trend?: 'up' | 'down' | 'flat';
  color: string;
}) {
  return (
    <Card className="glass-card">
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className={`rounded-lg p-2 ${color}`}>
            <Icon className="h-4 w-4" />
          </div>
          {trend === 'up' && <TrendingUp className="h-3.5 w-3.5 text-red-500" />}
          {trend === 'down' && <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />}
          {trend === 'flat' && <Minus className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
        <div className="mt-3">
          <p className="text-2xl font-bold tracking-tight stat-value">{value}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
          {sub && <p className="text-[10px] text-muted-foreground/60 mt-0.5">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Mini Bar Chart ────────────────────────────────────────────────────────

function MiniBarChart({ data, maxValue, color }: { data: Array<{ hour: string; count: number }>; maxValue: number; color: string }) {
  return (
    <div className="flex items-end gap-0.5 h-16">
      {data.map((d, i) => {
        const height = maxValue > 0 ? (d.count / maxValue) * 100 : 0;
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group/bar">
            <div className="w-full relative rounded-t-sm overflow-hidden" style={{ height: '48px' }}>
              <div
                className={`absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-500 ${color}`}
                style={{ height: `${Math.max(height, 2)}%` }}
              />
            </div>
            <span className="text-[8px] text-muted-foreground/50 opacity-0 group-hover/bar:opacity-100 transition-opacity">
              {d.count || ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── MonitorStats Props ───────────────────────────────────────────────────────

interface MonitorStatsProps {
  stats: DashboardStats;
}

// ─── MonitorStats Component ──────────────────────────────────────────────────

export function MonitorStats({ stats }: MonitorStatsProps) {
  const captchaCount24h = stats.events24h?.captcha_triggered ?? 0;
  const captchaCount7d = stats.events7d?.captcha_triggered ?? 0;
  const captchaTrend = captchaCount7d > 0
    ? (captchaCount24h / (captchaCount7d / 7) > 1.2 ? 'up' : captchaCount24h / (captchaCount7d / 7) < 0.8 ? 'down' : 'flat')
    : 'flat';
  const maxCaptchaTrend = Math.max(...(stats.captchaTrend?.map(d => d.count) || [1]));

  return (
    <div className="space-y-4">
      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={Shield}
          label="24h 事件总数"
          value={stats.total24h}
          sub={`7天累计 ${stats.total7d}`}
          color="bg-primary/10"
        />
        <StatCard
          icon={Lock}
          label="验证码触发(24h)"
          value={captchaCount24h}
          sub={`7天 ${captchaCount7d}`}
          trend={captchaTrend}
          color="bg-red-500/10"
        />
        <StatCard
          icon={Server}
          label="活跃代理"
          value={stats.proxyStats?.activeProxies ?? '-'}
          sub={`总分 ${stats.proxyStats?.totalProxies ?? '-'}`}
          color="bg-violet-500/10"
        />
        <StatCard
          icon={XCircle}
          label="未解决事件"
          value={stats.unresolvedCount}
          sub="需要关注"
          color="bg-amber-500/10"
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Captcha Trend */}
        <Card className="glass-card">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-medium flex items-center gap-2">
              <BarChart3 className="h-3.5 w-3.5 text-primary" />
              验证码触发趋势（24h）
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {stats.captchaTrend && stats.captchaTrend.length > 0 ? (
              <MiniBarChart data={stats.captchaTrend} maxValue={maxCaptchaTrend} color="bg-red-500/70" />
            ) : (
              <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">
                暂无数据
              </div>
            )}
          </CardContent>
        </Card>

        {/* Event Type Distribution */}
        <Card className="glass-card">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-medium flex items-center gap-2">
              <Eye className="h-3.5 w-3.5 text-primary" />
              事件类型分布（24h）
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="space-y-2">
              {Object.entries(EVENT_META).map(([key, meta]) => {
                const count = stats.events24h?.[key] ?? 0;
                const total = stats.total24h || 1;
                const pct = Math.round((count / total) * 100);
                const Icon = meta.icon;
                return (
                  <div key={key} className="flex items-center gap-2.5">
                    <Icon className={`h-3 w-3 shrink-0 ${meta.color}`} />
                    <span className="text-[11px] w-20 shrink-0 truncate">{meta.label}</span>
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.6, delay: 0.1 }}
                        className={`h-full rounded-full ${meta.bg.replace('/10', '/60')}`}
                      />
                    </div>
                    <span className="text-[11px] font-mono text-muted-foreground w-8 text-right">
                      {count}
                    </span>
                    <span className="text-[9px] text-muted-foreground/50 w-8 text-right">
                      {pct}%
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Proxy Pool + Top Domains */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Proxy Pool */}
        <Card className="glass-card">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-medium flex items-center gap-2">
              <Server className="h-3.5 w-3.5 text-primary" />
              代理池状态
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {stats.proxyStats ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border p-2.5 text-center">
                    <p className="text-lg font-bold stat-value">{stats.proxyStats.activeProxies}</p>
                    <p className="text-[10px] text-muted-foreground">活跃代理</p>
                  </div>
                  <div className="rounded-lg border p-2.5 text-center">
                    <p className="text-lg font-bold stat-value">{stats.proxyStats.avgScore.toFixed(1)}</p>
                    <p className="text-[10px] text-muted-foreground">平均评分</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border p-2.5 text-center">
                    <p className="text-lg font-bold stat-value">{(stats.proxyStats.successRate * 100).toFixed(0)}%</p>
                    <p className="text-[10px] text-muted-foreground">成功率</p>
                  </div>
                  <div className="rounded-lg border p-2.5 text-center">
                    <p className="text-lg font-bold stat-value">{stats.proxyStats.totalRequests}</p>
                    <p className="text-[10px] text-muted-foreground">总请求数</p>
                  </div>
                </div>
                {stats.proxyStats.capturedAt && (
                  <p className="text-[10px] text-muted-foreground/50 text-center">
                    更新于 {formatRelativeTime(stats.proxyStats.capturedAt)}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground gap-2">
                <Wifi className="h-8 w-8 text-muted-foreground/30" />
                <span>代理池未启用或无数据</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Domains */}
        <Card className="glass-card">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-xs font-medium flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 text-primary" />
              高风险域名 TOP 5
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {stats.topDomains && stats.topDomains.length > 0 ? (
              <div className="space-y-2">
                {stats.topDomains.slice(0, 5).map((d, i) => {
                  const maxCount = stats.topDomains![0].count || 1;
                  const pct = Math.round((d.count / maxCount) * 100);
                  return (
                    <div key={d.domain} className="flex items-center gap-2.5">
                      <span className="text-[10px] font-mono text-muted-foreground/50 w-4">#{i + 1}</span>
                      <span className="text-[11px] font-medium truncate max-w-[140px]" title={d.domain}>
                        {d.domain}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.6, delay: i * 0.05 }}
                          className="h-full rounded-full bg-amber-500/60"
                        />
                      </div>
                      <span className="text-[11px] font-mono text-muted-foreground w-6 text-right">
                        {d.count}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 text-xs text-muted-foreground gap-2">
                <Globe className="h-8 w-8 text-muted-foreground/30" />
                <span>暂无域名数据</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
