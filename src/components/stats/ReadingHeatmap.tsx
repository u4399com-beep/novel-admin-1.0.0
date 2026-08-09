'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { getSessionId } from '@/lib/reading-session';
import { Skeleton } from '@/components/ui/skeleton';
import { Flame } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────

interface DailyStat {
  date: string;
  wordsRead: number;
  chaptersRead: number;
  readingTimeMinutes: number;
}

interface HeatmapApiResponse {
  dailyStats?: DailyStat[];
  heatmap?: Array<{ date: string; count: number }>;
}

interface TooltipInfo {
  date: string;
  chapters: number;
  words: number;
  minutes: number;
  x: number;
  y: number;
}

interface CellData {
  date: string;
  chapters: number;
  words: number;
  minutes: number;
  row: number;
  col: number;
  isFuture: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

const TOTAL_DAYS = 183; // ~6 months
const CELL_SIZE = 11;
const CELL_GAP = 3;
const DAY_LABELS = ['Mon', 'Wed', 'Fri'];
const DAY_LABEL_ROWS = [1, 3, 5]; // Mon=1, Wed=3, Fri=5 (0-indexed rows)
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// GitHub-style green color scale
const GREEN_SCALE = [
  '#ebedf0', // Level 0: no activity (gray)
  '#9be9a8', // Level 1: light green
  '#40c463', // Level 2: medium green
  '#30a14e', // Level 3: dark green
  '#216e39', // Level 4: darkest green
];

// ─── Helpers ─────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getIntensityLevel(count: number, max: number): number {
  if (count === 0 || max === 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.2) return 1;
  if (ratio <= 0.45) return 2;
  if (ratio <= 0.7) return 3;
  return 4;
}

function getDayOfWeekMondayBased(date: Date): number {
  // Returns 0=Mon, 1=Tue, ..., 6=Sun
  const dow = date.getDay();
  return dow === 0 ? 6 : dow - 1;
}

// ─── Component ───────────────────────────────────────────────────────

export default function ReadingHeatmap() {
  const [data, setData] = useState<Map<string, DailyStat>>(new Map());
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [hasData, setHasData] = useState(false);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Fetch data
  useEffect(() => {
    const sessionId = getSessionId();
    if (!sessionId) {
      // No session — set loading to false via microtask to avoid sync setState in effect
      queueMicrotask(() => setLoading(false));
      return;
    }

    const ac = new AbortController();

    const fetchData = async () => {
      try {
        const res = await apiFetch<HeatmapApiResponse>(
          `/api/public/reading-stats?sessionId=${encodeURIComponent(sessionId)}`,
          { signal: ac.signal, silent: true, timeout: 15000 },
        );
        if (ac.signal.aborted) return;

        const map = new Map<string, DailyStat>();

        // Prefer dailyStats if available (full data)
        if (res.dailyStats && res.dailyStats.length > 0) {
          for (const stat of res.dailyStats) {
            map.set(stat.date, {
              date: stat.date,
              wordsRead: stat.wordsRead ?? 0,
              chaptersRead: stat.chaptersRead ?? 0,
              readingTimeMinutes: stat.readingTimeMinutes ?? 0,
            });
          }
          setHasData(true);
        }
        // Fallback: use heatmap data (count-only)
        else if (res.heatmap && res.heatmap.length > 0) {
          for (const entry of res.heatmap) {
            if (entry.count > 0) {
              map.set(entry.date, {
                date: entry.date,
                wordsRead: 0,
                chaptersRead: entry.count,
                readingTimeMinutes: 0,
              });
            }
          }
          setHasData(res.heatmap.some((e) => e.count > 0));
        }

        setData(map);
      } catch {
        // silent — don't show error for non-critical component
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    };

    fetchData();

    return () => {
      ac.abort();
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    };
  }, []);

  // Build the grid
  const grid = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Start: TOTAL_DAYS ago, aligned to Monday
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (TOTAL_DAYS - 1));
    const dow = getDayOfWeekMondayBased(startDate);
    startDate.setDate(startDate.getDate() - dow);

    const cells: CellData[] = [];
    const current = new Date(startDate);
    let col = 0;

    // Loop until we've covered all weeks up to today
    while (current <= today || getDayOfWeekMondayBased(current) !== 0) {
      // Stop condition: we've passed today and reached a new Monday
      if (current > today && getDayOfWeekMondayBased(current) === 0 && col > 0) {
        break;
      }

      const dateStr = toDateStr(current);
      const isFuture = current > today;
      const stat = data.get(dateStr);

      cells.push({
        date: dateStr,
        chapters: isFuture ? 0 : (stat?.chaptersRead ?? 0),
        words: isFuture ? 0 : (stat?.wordsRead ?? 0),
        minutes: isFuture ? 0 : (stat?.readingTimeMinutes ?? 0),
        row: getDayOfWeekMondayBased(current),
        col,
        isFuture,
      });

      current.setDate(current.getDate() + 1);
      if (getDayOfWeekMondayBased(current) === 0 && current > startDate) {
        col++;
      }
    }

    return { cells, totalCols: col + 1 };
  }, [data]);

  // Build a lookup map for grid cells
  const cellMap = useMemo(() => {
    const map = new Map<string, CellData>();
    for (const cell of grid.cells) {
      map.set(`${cell.row}-${cell.col}`, cell);
    }
    return map;
  }, [grid.cells]);

  // Calculate max chapters for intensity scaling
  const maxChapters = useMemo(() => {
    let max = 0;
    for (const cell of grid.cells) {
      if (cell.chapters > max) max = cell.chapters;
    }
    return max;
  }, [grid.cells]);

  // Calculate month label positions
  const monthLabels = useMemo(() => {
    const labels: Array<{ label: string; col: number }> = [];
    let lastMonth = -1;

    for (const cell of grid.cells) {
      const d = new Date(cell.date + 'T00:00:00');
      const month = d.getMonth();
      if (month !== lastMonth) {
        labels.push({ label: MONTH_NAMES[month], col: cell.col });
        lastMonth = month;
      }
    }
    return labels;
  }, [grid.cells]);

  // Calculate summary stats
  const summary = useMemo(() => {
    let totalChapters = 0;
    let activeDays = 0;
    for (const cell of grid.cells) {
      if (cell.chapters > 0) {
        totalChapters += cell.chapters;
        activeDays++;
      }
    }
    return { totalChapters, activeDays };
  }, [grid.cells]);

  // Tooltip handlers
  const handleCellEnter = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, cell: CellData) => {
      if (cell.isFuture) return;
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
      const rect = e.currentTarget.getBoundingClientRect();
      setTooltip({
        date: cell.date,
        chapters: cell.chapters,
        words: cell.words,
        minutes: cell.minutes,
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    },
    [],
  );

  const handleGridLeave = useCallback(() => {
    tooltipTimerRef.current = setTimeout(() => setTooltip(null), 100);
  }, []);

  // ─── Loading Skeleton ──────────────────────────────────────────────

  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-4 sm:p-5 card-glow card-border-glow">
        <div className="flex items-center gap-2 mb-4">
          <Flame className="h-4 w-4 text-muted-foreground" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-3 w-48 mb-3" />
        <div className="overflow-x-auto">
          <Skeleton className="h-[110px] w-full min-w-[600px]" />
        </div>
        <div className="flex items-center gap-1.5 mt-3">
          <Skeleton className="h-3 w-6" />
          <Skeleton className="h-[11px] w-[11px] rounded-sm" />
          <Skeleton className="h-[11px] w-[11px] rounded-sm" />
          <Skeleton className="h-[11px] w-[11px] rounded-sm" />
          <Skeleton className="h-[11px] w-[11px] rounded-sm" />
          <Skeleton className="h-[11px] w-[11px] rounded-sm" />
          <Skeleton className="h-3 w-6" />
        </div>
      </div>
    );
  }

  // ─── Empty State ───────────────────────────────────────────────────

  if (!hasData) {
    return (
      <div className="rounded-xl border bg-card p-4 sm:p-5 card-glow card-border-glow">
        <div className="flex items-center gap-2 mb-4">
          <Flame className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">阅读热力图</h2>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="h-12 w-12 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
            <Flame className="h-6 w-6 text-muted-foreground/40" />
          </div>
          <p className="text-xs text-muted-foreground">
            开始阅读后，这里将展示你的每日阅读热力图
          </p>
        </div>
      </div>
    );
  }

  // ─── Heatmap ───────────────────────────────────────────────────────

  const colWidth = CELL_SIZE;
  const rowHeight = CELL_SIZE;
  const step = CELL_SIZE + CELL_GAP;

  return (
    <div className="rounded-xl border bg-card p-4 sm:p-5 card-glow card-border-glow focus-ring-soft">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <Flame className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">阅读热力图</h2>
      </div>

      {/* Summary */}
      <div className="flex items-center gap-3 mb-3 text-xs text-muted-foreground">
        <span>
          过去 6 个月阅读{' '}
          <strong className="text-foreground">{summary.totalChapters}</strong> 章
        </span>
        <span className="text-muted-foreground/30">·</span>
        <span>
          活跃{' '}
          <strong className="text-foreground">{summary.activeDays}</strong> 天
        </span>
      </div>

      {/* Heatmap Grid */}
      <div className="relative overflow-x-auto">
        <div className="inline-flex flex-col" onMouseLeave={handleGridLeave}>
          {/* Month labels row */}
          <div
            className="flex ml-[22px] sm:ml-[26px] mb-1"
            style={{ gap: `${CELL_GAP}px` }}
          >
            {monthLabels.map((m, i) => {
              const colSpan = i === monthLabels.length - 1
                ? grid.totalCols - m.col
                : monthLabels[i + 1].col - m.col;

              return (
                <div
                  key={`${m.label}-${m.col}`}
                  className="text-[10px] text-muted-foreground/70 shrink-0"
                  style={{
                    width: colSpan * step - CELL_GAP,
                  }}
                >
                  {m.label}
                </div>
              );
            })}
          </div>

          {/* Grid: day labels + cells */}
          <div className="flex">
            {/* Day-of-week labels (hidden on mobile) */}
            <div
              className="hidden sm:flex flex-col mr-1.5 shrink-0"
              style={{ gap: `${CELL_GAP}px` }}
            >
              {Array.from({ length: 7 }, (_, rowIdx) => (
                <div
                  key={rowIdx}
                  className="flex items-center justify-end text-[10px] text-muted-foreground/60"
                  style={{
                    width: '18px',
                    height: `${rowHeight}px`,
                    visibility: DAY_LABEL_ROWS.includes(rowIdx) ? 'visible' : 'hidden',
                  }}
                >
                  {DAY_LABELS[DAY_LABEL_ROWS.indexOf(rowIdx)]}
                </div>
              ))}
            </div>

            {/* Cell columns (weeks) */}
            <div className="flex" style={{ gap: `${CELL_GAP}px` }}>
              {Array.from({ length: grid.totalCols }, (_, colIdx) => (
                <div
                  key={colIdx}
                  className="flex flex-col shrink-0"
                  style={{ gap: `${CELL_GAP}px` }}
                >
                  {Array.from({ length: 7 }, (_, rowIdx) => {
                    const cell = cellMap.get(`${rowIdx}-${colIdx}`);
                    if (!cell) {
                      return (
                        <div
                          key={rowIdx}
                          style={{
                            width: `${colWidth}px`,
                            height: `${rowHeight}px`,
                          }}
                        />
                      );
                    }

                    const level = cell.isFuture
                      ? -1
                      : getIntensityLevel(cell.chapters, maxChapters);

                    return (
                      <div
                        key={rowIdx}
                        role="gridcell"
                        aria-label={
                          cell.isFuture
                            ? undefined
                            : `${cell.date}: ${cell.chapters} chapters read`
                        }
                        className="rounded-sm transition-transform hover:scale-110"
                        style={{
                          width: `${colWidth}px`,
                          height: `${rowHeight}px`,
                          backgroundColor:
                            level === -1
                              ? 'transparent'
                              : GREEN_SCALE[level],
                        }}
                        onMouseEnter={(e) => handleCellEnter(e, cell)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Tooltip (fixed positioning) */}
        {tooltip && (
          <div
            role="tooltip"
            className="fixed z-50 pointer-events-none rounded-md bg-popover text-popover-foreground border shadow-lg px-2.5 py-2 text-xs"
            style={{
              left: tooltip.x,
              top: tooltip.y - 6,
              transform: 'translate(-50%, -100%)',
            }}
          >
            <div className="font-medium mb-1">{tooltip.date}</div>
            {tooltip.chapters > 0 && (
              <div className="text-muted-foreground">
                {tooltip.chapters} 章已读
              </div>
            )}
            {tooltip.words > 0 && (
              <div className="text-muted-foreground">
                {tooltip.words.toLocaleString()} 字
              </div>
            )}
            {tooltip.minutes > 0 && (
              <div className="text-muted-foreground">
                {tooltip.minutes} 分钟
              </div>
            )}
            {tooltip.chapters === 0 && tooltip.words === 0 && tooltip.minutes === 0 && (
              <div className="text-muted-foreground">无阅读记录</div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-1.5 mt-3 text-[10px] text-muted-foreground">
        <span>少</span>
        {GREEN_SCALE.map((color, i) => (
          <div
            key={i}
            className="rounded-sm"
            style={{
              width: `${CELL_SIZE}px`,
              height: `${CELL_SIZE}px`,
              backgroundColor: color,
            }}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
