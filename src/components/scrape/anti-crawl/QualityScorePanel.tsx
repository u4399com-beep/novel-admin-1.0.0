'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Award, Loader2, RefreshCw,
  CircleCheck, CircleX, ChevronUp, ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';
import { CollapsiblePanel } from './CollapsiblePanel';

// ─── Types ───────────────────────────────────────────────────────────────────

interface QualityCheck {
  name: string;
  passed: boolean;
  score: number;
  message: string;
}

interface QualityReport {
  taskId: string;
  overallScore: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  checks: QualityCheck[];
  summary: string;
  timestamp: string;
}

interface QualityStats {
  avgScore: number;
  totalReports: number;
  gradeDistribution: Record<string, number>;
  recentReports: QualityReport[];
  serviceReachable: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GRADE_COLORS: Record<string, string> = {
  A: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  B: 'bg-sky-500/10 text-sky-600 border-sky-500/20',
  C: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
  D: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
  F: 'bg-red-500/10 text-red-600 border-red-500/20',
};

const GRADE_BAR_COLORS: Record<string, string> = {
  A: 'bg-emerald-500',
  B: 'bg-sky-500',
  C: 'bg-amber-500',
  D: 'bg-orange-500',
  F: 'bg-red-500',
};

const SCORE_COLOR: (score: number) => string = (score) => {
  if (score > 80) return 'text-emerald-600';
  if (score > 60) return 'text-amber-600';
  if (score > 40) return 'text-orange-600';
  return 'text-red-600';
};

const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F'];

// ─── Animated SVG Ring Gauge ────────────────────────────────────────────────

function AnimatedScoreGauge({ score, size = 40, animate = false }: { score: number; size?: number; animate?: boolean }) {
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const targetOffset = circumference - progress;
  const color = score > 80 ? 'text-emerald-500' : score > 60 ? 'text-amber-500' : score > 40 ? 'text-orange-500' : 'text-red-500';

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        className="-rotate-90"
      >
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/30"
        />
        {/* Progress circle - animated */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray={`${circumference}`}
          strokeDashoffset={animate ? targetOffset : circumference}
          strokeLinecap="round"
          className={`${color} ${animate ? 'cp-ring-animate' : 'transition-all duration-500'}`}
          style={animate ? {
            '--ring-circumference': circumference,
            '--ring-target-offset': targetOffset,
          } as React.CSSProperties : { strokeDashoffset: targetOffset }}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-[10px] font-bold ${SCORE_COLOR(score)}`}>
        {Math.round(score)}
      </span>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function QualityScorePanel() {
  const [stats, setStats] = useState<QualityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [ringKey, setRingKey] = useState(0); // key to re-trigger ring animation

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<QualityStats>('/api/admin/scraper/quality-stats', {
        signal,
        timeout: 8000,
        silent: true,
      });
      if (!signal?.aborted) {
        setStats(data);
        setRingKey(k => k + 1); // re-trigger animation
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
    return () => { abortRef.current?.abort(); abortRef.current = null; };
  }, [fetchStats]);

  const handleRefresh = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchStats(ac.signal);
  };

  const avgScore = stats?.avgScore || 0;
  const totalReports = stats?.totalReports || 0;
  const gradeDistribution = stats?.gradeDistribution || {};
  const recentReports = stats?.recentReports || [];

  // Latest grade
  const latestGrade = recentReports.length > 0 ? recentReports[0].grade : null;

  // Grade pulse class
  const gradePulseClass = latestGrade === 'A' || latestGrade === 'B'
    ? 'cp-grade-pulse-green'
    : latestGrade === 'F' || latestGrade === 'D'
      ? 'cp-grade-pulse-red'
      : '';

  // Total for distribution bar
  const distTotal = useMemo(() =>
    GRADE_ORDER.reduce((sum, g) => sum + (gradeDistribution[g] || 0), 0),
    [gradeDistribution],
  );

  return (
    <CollapsiblePanel
      icon={Award}
      title="采集数据质量"
      loading={loading}
      expanded={expanded}
      onExpandedChange={setExpanded}
      badges={totalReports > 0 ? (
        <Badge variant="secondary" className={`text-[9px] px-1.5 py-0 font-normal ${SCORE_COLOR(avgScore)}`}>
          {avgScore.toFixed(1)}
        </Badge>
      ) : undefined}
    >
      {/* Summary cards 2x2 */}
      {totalReports > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {/* Average score */}
          <div className="rounded-lg border bg-muted/20 px-3 py-2">
            <p className="text-[10px] text-muted-foreground">平均评分</p>
            <p className={`text-lg font-bold ${SCORE_COLOR(avgScore)}`}>
              {avgScore.toFixed(1)}
            </p>
            <p className="text-[9px] text-muted-foreground/60">满分 100</p>
          </div>

          {/* Total reports */}
          <div className="rounded-lg border bg-muted/20 px-3 py-2">
            <p className="text-[10px] text-muted-foreground">报告总数</p>
            <p className="text-lg font-bold">{totalReports}</p>
            <p className="text-[9px] text-muted-foreground/60">累计评分</p>
          </div>

          {/* Grade distribution */}
          <div className="rounded-lg border bg-muted/20 px-3 py-2">
            <p className="text-[10px] text-muted-foreground">等级分布</p>
            <div className="mt-1 flex h-3 rounded-sm overflow-hidden bg-muted/30">
              {GRADE_ORDER.map((grade) => {
                const count = gradeDistribution[grade] || 0;
                if (count === 0) return null;
                const pct = distTotal > 0 ? (count / distTotal) * 100 : 0;
                return (
                  <div
                    key={grade}
                    className={`${GRADE_BAR_COLORS[grade]} transition-all`}
                    style={{ width: `${pct}%` }}
                    title={`${grade}: ${count}`}
                  />
                );
              })}
            </div>
            <div className="mt-1 flex gap-1.5">
              {GRADE_ORDER.map((grade) => (
                <span key={grade} className={`text-[8px] font-medium ${gradeDistribution[grade] ? '' : 'opacity-30'}`}>
                  {grade}:{gradeDistribution[grade] || 0}
                </span>
              ))}
            </div>
          </div>

          {/* Latest grade with pulse */}
          <div className="rounded-lg border bg-muted/20 px-3 py-2 flex flex-col items-center justify-center">
            <p className="text-[10px] text-muted-foreground">最近等级</p>
            {latestGrade ? (
              <Badge
                variant="outline"
                className={`text-sm font-bold px-2.5 py-0.5 mt-0.5 ${GRADE_COLORS[latestGrade]} ${gradePulseClass}`}
              >
                {latestGrade}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground/60">-</span>
            )}
          </div>
        </div>
      ) : null}

      {/* Refresh button */}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px] px-2"
          onClick={handleRefresh}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          <span className="ml-1">刷新</span>
        </Button>
      </div>

      {/* Recent reports list */}
      {recentReports.length > 0 ? (
        <div className="space-y-1 max-h-64 overflow-y-auto scrollbar-thin">
          {recentReports.map((report, reportIdx) => {
            const isExpanded = expandedReport === report.taskId;
            return (
              <div
                key={report.taskId}
                className="rounded-md border bg-background/50 overflow-hidden group/report hover:border-muted-foreground/20 transition-colors"
              >
                {/* Report header */}
                <button
                  onClick={() => setExpandedReport(isExpanded ? null : report.taskId)}
                  className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted/30 transition-colors text-left"
                >
                  <AnimatedScoreGauge score={report.overallScore} size={40} animate={reportIdx === 0 && expanded} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`text-[9px] px-1 py-0 font-medium ${GRADE_COLORS[report.grade]}`}
                      >
                        {report.grade}
                      </Badge>
                      <span className="text-[11px] font-mono truncate" title={report.taskId}>
                        {report.taskId.slice(0, 8)}…
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                      {report.summary}
                    </p>
                  </div>
                  <div className="flex flex-col items-end shrink-0 gap-1">
                    <span className="text-[9px] text-muted-foreground/60 font-mono">
                      {new Date(report.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    {isExpanded
                      ? <ChevronUp className="h-3 w-3 text-muted-foreground" />
                      : <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    }
                  </div>
                </button>

                {/* Expanded checks - CSS grid transition */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateRows: isExpanded ? '1fr' : '0fr',
                    transition: 'grid-template-rows 0.2s ease-out',
                  }}
                >
                  <div className="overflow-hidden">
                    <div className={`border-t px-3 py-2 space-y-1 ${isExpanded ? 'cp-fade-in' : ''}`}>
                      {/* Summary on hover (always visible but more prominent on hover) */}
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-muted-foreground">
                          {report.checks.filter(c => c.passed).length}/{report.checks.length} 项通过
                        </span>
                        <span className={`text-[10px] font-mono ${SCORE_COLOR(report.overallScore)}`}>
                          总分 {report.overallScore}
                        </span>
                      </div>
                      {report.checks.map((check, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 text-[11px] py-0.5"
                        >
                          {check.passed ? (
                            <CircleCheck className="h-3 w-3 text-emerald-500 shrink-0" />
                          ) : (
                            <CircleX className="h-3 w-3 text-red-500 shrink-0" />
                          )}
                          <span className="font-medium shrink-0 w-16">{check.name}</span>
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1 py-0 font-mono shrink-0 ${
                              check.score >= 10
                                ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                                : 'bg-red-500/10 text-red-600 border-red-500/20'
                            }`}
                          >
                            {check.score}/15
                          </Badge>
                          <span className="text-muted-foreground truncate">{check.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Award className="h-6 w-6 mb-1.5 opacity-40" />
          <p className="text-[11px]">暂无质量报告，完成采集任务后自动生成</p>
        </div>
      )}
    </CollapsiblePanel>
  );
}
