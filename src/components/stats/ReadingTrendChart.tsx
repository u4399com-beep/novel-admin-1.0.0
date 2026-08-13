'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Activity, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// ─── Types ─────────────────────────────────────────────────────────

interface TrendPoint {
  date: string;
  chapters: number;
  words: number;
}

interface TrendData {
  trend: TrendPoint[];
}

// ─── Constants ──────────────────────────────────────────────────────

const CHART_H = 180;
const PAD = { top: 10, right: 12, bottom: 28, left: 36 };
const PLOT_W = 100 - PAD.left - PAD.right; // percentage
const PLOT_H = CHART_H - PAD.top - PAD.bottom;

// ─── Helpers ───────────────────────────────────────────────────────

function formatDateLabel(dateStr: string): string {
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  return `${m}/${d}`;
}

function formatWordsShort(w: number): string {
  return (w / 1000).toFixed(1);
}

// ─── Loading Skeleton ──────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Skeleton className="h-4 w-20 rounded" />
      </div>
      <Skeleton className="w-full rounded-lg" style={{ height: `${CHART_H}px` }} />
    </div>
  );
}

// ─── Error State ───────────────────────────────────────────────────

function ErrorState({ message }: { message?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/10">
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          </div>
          <span className="text-sm font-semibold">阅读趋势</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {message || '无法加载阅读趋势数据'}
        </p>
      </div>
    </motion.div>
  );
}

// ─── Empty State ───────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <span className="text-sm font-semibold link-underline inline-block">阅读趋势</span>
      </div>
      <div className="flex items-center justify-center" style={{ height: `${CHART_H}px` }}>
        <p className="text-sm text-muted-foreground/60">暂无阅读趋势数据</p>
      </div>
    </div>
  );
}

// ─── Area Chart (pure SVG) ─────────────────────────────────────────

function AreaChart({
  data,
  showWords,
}: {
  data: TrendPoint[];
  showWords: boolean;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const values = useMemo(
    () => data.map((d) => (showWords ? d.words / 1000 : d.chapters)),
    [data, showWords],
  );

  const maxVal = useMemo(() => Math.max(1, ...values), [values]);

  // Build path data
  const { linePath, areaPath } = useMemo(() => {
    if (data.length < 2) return { linePath: '', areaPath: '' };

    const points = values.map((v, i) => {
      const x = PAD.left + (i / (data.length - 1)) * PLOT_W;
      const y = PAD.top + PLOT_H - (v / maxVal) * PLOT_H;
      return { x, y };
    });

    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const area =
      line +
      ` L ${points[points.length - 1].x} ${PAD.top + PLOT_H}` +
      ` L ${points[0].x} ${PAD.top + PLOT_H} Z`;

    return { linePath: line, areaPath: area };
  }, [data.length, values, maxVal]);

  // Y-axis tick values (4 ticks)
  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let i = 0; i <= 3; i++) {
      ticks.push(Math.round((maxVal / 3) * i));
    }
    return ticks;
  }, [maxVal]);

  // X-axis labels (every 5 days)
  const xLabels = useMemo(() => {
    const labels: { text: string; x: number }[] = [];
    for (let i = 0; i < data.length; i += 5) {
      labels.push({
        text: formatDateLabel(data[i].date),
        x: PAD.left + (i / Math.max(data.length - 1, 1)) * PLOT_W,
      });
    }
    // Always include last point
    const lastIdx = data.length - 1;
    if (lastIdx > 0 && lastIdx % 5 !== 0) {
      labels.push({
        text: formatDateLabel(data[lastIdx].date),
        x: PAD.left + (lastIdx / (data.length - 1)) * PLOT_W,
      });
    }
    return labels;
  }, [data]);

  const yUnit = showWords ? '千字' : '章';

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const mouseX = ((e.clientX - rect.left) / rect.width) * 100;

      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < data.length; i++) {
        const px = PAD.left + (i / Math.max(data.length - 1, 1)) * PLOT_W;
        const dist = Math.abs(mouseX - px);
        if (dist < closestDist) {
          closestDist = dist;
          closestIdx = i;
        }
      }
      setHoveredIndex(closestIdx);
    },
    [data.length],
  );

  const handlePointerLeave = useCallback(() => setHoveredIndex(null), []);

  // Compute line length for animation (approximate)
  const pathLength = useMemo(() => {
    if (data.length < 2) return 0;
    let len = 0;
    for (let i = 1; i < values.length; i++) {
      const x1 = PAD.left + ((i - 1) / (data.length - 1)) * PLOT_W;
      const x2 = PAD.left + (i / (data.length - 1)) * PLOT_W;
      const y1 = PAD.top + PLOT_H - (values[i - 1] / maxVal) * PLOT_H;
      const y2 = PAD.top + PLOT_H - (values[i] / maxVal) * PLOT_H;
      len += Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    }
    return len;
  }, [data.length, values, maxVal]);

  return (
    <svg
      viewBox={`0 0 100 ${CHART_H}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height: `${CHART_H}px` }}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <defs>
        <linearGradient id="trend-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Y-axis grid lines & labels */}
      {yTicks.map((tick, i) => {
        const y = PAD.top + PLOT_H - (tick / maxVal) * PLOT_H;
        return (
          <g key={`ytick-${i}`}>
            <line
              x1={PAD.left}
              y1={y}
              x2={PAD.left + PLOT_W}
              y2={y}
              stroke="var(--muted)"
              strokeOpacity={0.3}
              strokeWidth="0.3"
            />\n            <text
              x={PAD.left - 3}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--muted-foreground)"
              fontSize="4.5"
              className="select-none"
            >
              {tick}
              {i === 3 && <tspan fontSize="3" opacity="0.6"> {yUnit}</tspan>}
            </text>
          </g>
        );
      })}

      {/* X-axis labels */}
      {xLabels.map((lbl, i) => (
        <text
          key={`xlabel-${i}`}
          x={lbl.x}
          y={CHART_H - 6}
          textAnchor="middle"
          fill="var(--muted-foreground)"
          fontSize="4"
          className="select-none"
        >
          {lbl.text}
        </text>
      ))}

      {/* Area fill */}
      {areaPath && (
        <motion.path
          d={areaPath}
          fill="url(#trend-gradient)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.3 }}
        />
      )}

      {/* Line */}
      {linePath && (
        <motion.path
          d={linePath}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="0.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={pathLength}
          initial={{ strokeDashoffset: pathLength }}
          animate={{ strokeDashoffset: 0 }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
        />
      )}

      {/* Data points & hover tooltip */}
      {data.map((d, i) => {
        const cx = PAD.left + (i / Math.max(data.length - 1, 1)) * PLOT_W;
        const cy = PAD.top + PLOT_H - (values[i] / maxVal) * PLOT_H;
        const isHovered = hoveredIndex === i;

        return (
          <g key={d.date}>
            {/* Hover vertical guide line */}
            {isHovered && (
              <line
                x1={cx}
                y1={PAD.top}
                x2={cx}
                y2={PAD.top + PLOT_H}
                stroke="var(--primary)"
                strokeOpacity={0.15}
                strokeWidth="0.4"
              />
            )}
            {/* Dot */}
            <circle
              cx={cx}
              cy={cy}
              r={isHovered ? 1.8 : 0.9}
              fill={isHovered ? 'var(--primary)' : 'var(--background)'}
              stroke="var(--primary)"
              strokeWidth="0.5"
              className="transition-all duration-150"
            />
            {/* Tooltip */}
            {isHovered && (
              <g>
                {/* Tooltip background */}
                <rect
                  x={cx - 14}
                  y={cy - 16}
                  width={28}
                  height={12}
                  rx="2"
                  fill="var(--popover)"
                  stroke="var(--border)"
                  strokeWidth="0.3"
                />
                <text
                  x={cx}
                  y={cy - 11}
                  textAnchor="middle"
                  fill="var(--popover-foreground)"
                  fontSize="3.5"
                  className="select-none pointer-events-none"
                >
                  {formatDateLabel(d.date)}
                </text>
                <text
                  x={cx}
                  y={cy - 7}
                  textAnchor="middle"
                  fill="var(--primary)"
                  fontSize="3.2"
                  fontWeight="bold"
                  className="select-none pointer-events-none"
                >
                  {showWords
                    ? `${formatWordsShort(d.words)}千字`
                    : `${d.chapters}章`}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function ReadingTrendChart() {
  const [data, setData] = useState<TrendPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWords, setShowWords] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    apiFetch<TrendData>('/api/stats/reading-trend', {
      signal: ac.signal,
      silent: true,
    })
      .then((res) => {
        if (!ac.signal.aborted) {
          setData(res.trend);
          setError(null);
        }
      })
      .catch((err) => {
        if (!ac.signal.aborted) {
          setError(err instanceof Error ? err.message : '加载失败');
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, []);

  if (loading) return <LoadingSkeleton />;
  if (error) return <ErrorState message={error} />;
  if (!data || data.length === 0) return <EmptyState />;

  return (
    <ErrorBoundary name="stats-reading-trend">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' as const }}
      >
        <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
          {/* Title row */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <h2 className="text-sm font-semibold link-underline inline-block">
                阅读趋势
              </h2>
            </div>
            <button
              type="button"
              onClick={() => setShowWords((v) => !v)}
              className={
                'text-[11px] px-2.5 py-1 rounded-md border transition-colors ' +
                (showWords
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/50 text-muted-foreground border-transparent hover:bg-muted')
              }
            >
              {showWords ? '千字' : '章节'}
            </button>
          </div>

          {/* Chart */}
          <AreaChart data={data} showWords={showWords} />
        </div>
      </motion.div>
    </ErrorBoundary>
  );
}
