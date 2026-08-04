'use client';

import { useMemo, useState } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// ─── Types ─────────────────────────────────────────────────────────────

interface HeatmapDay {
  date: string; // YYYY-MM-DD
  count: number; // 阅读章节数
}

// ─── Helpers ───────────────────────────────────────────────────────────

const DAYS_TO_SHOW = 90;
const WEEK_LABELS = ['', '一', '', '三', '', '五', ''] as const;

/** Format a date string YYYY-MM-DD to a friendly Chinese display */
function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${month}月${day}日 周${weekDays[d.getDay()]}`;
}

/** Get the level (0-3) based on chapter count */
function getLevel(count: number): 0 | 1 | 2 | 3 {
  if (count === 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  return 3;
}

/** Get cell background color class based on level */
function getLevelColor(level: 0 | 1 | 2 | 3): string {
  switch (level) {
    case 0:
      return 'bg-muted';
    case 1:
      return 'bg-primary/25';
    case 2:
      return 'bg-primary/50';
    case 3:
      return 'bg-primary/80';
  }
}

/** Generate date string YYYY-MM-DD */
function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Component ─────────────────────────────────────────────────────────

export function ReadingHeatmap({ className }: { className?: string }) {
  const [data] = useState<Record<string, number>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const raw = localStorage.getItem('reading-heatmap');
      if (raw) return JSON.parse(raw) as Record<string, number>;
    } catch {
      // ignore parse errors
    }
    return {};
  });

  // Build the grid data: 7 rows (Mon-Sun) x N columns (weeks)
  const { weeks, monthLabels } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find the start date: go back DAYS_TO_SHOW days, then align to Monday
    const startOffset = today.getDay() === 0 ? 6 : today.getDay() - 1; // days since Monday
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (DAYS_TO_SHOW - 1) - startOffset);

    // Build week columns
    const weekCount = Math.ceil((DAYS_TO_SHOW + startOffset) / 7);
    const weeks: HeatmapDay[][] = [];

    for (let w = 0; w < weekCount; w++) {
      const week: HeatmapDay[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + w * 7 + d);
        const dateStr = toDateStr(date);
        const count = data[dateStr] ?? 0;
        week.push({ date: dateStr, count });
      }
      weeks.push(week);
    }

    // Build month labels — show when month changes at the first non-empty row
    const monthLabels: { col: number; label: string }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < weekCount; w++) {
      // Check first row that has a valid date within the 90-day window
      for (let d = 0; d < 7; d++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + w * 7 + d);
        const dateStr = toDateStr(date);
        const month = new Date(dateStr + 'T00:00:00').getMonth();
        if (month !== lastMonth) {
          const monthNames = [
            '1月', '2月', '3月', '4月', '5月', '6月',
            '7月', '8月', '9月', '10月', '11月', '12月',
          ];
          monthLabels.push({ col: w, label: monthNames[month] });
          lastMonth = month;
        }
        break;
      }
    }

    return { weeks, monthLabels };
  }, [data]);

  // Summary stats
  const totalDays = useMemo(
    () => Object.values(data).filter((v) => v > 0).length,
    [data],
  );
  const totalChapters = useMemo(
    () => Object.values(data).reduce((a, b) => a + b, 0),
    [data],
  );

  return (
    <div className={`rounded-lg border bg-card p-4 ${className ?? ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">
          阅读热力图
        </div>
        <div className="text-xs text-muted-foreground">
          {totalDays} 天阅读 · {totalChapters} 章
        </div>
      </div>

      {/* Heatmap grid */}
      <div className="overflow-x-auto scrollbar-none">
        <div className="inline-flex flex-col gap-[2px] min-w-fit">
          {/* Month labels row */}
          <div className="flex gap-[2px]" style={{ paddingLeft: '24px' }}>
            {weeks.map((_, colIdx) => {
              const monthLabel = monthLabels.find((m) => m.col === colIdx);
              return (
                <div
                  key={`month-${colIdx}`}
                  className="text-[10px] text-muted-foreground whitespace-nowrap"
                  style={{
                    width: 'var(--cell-size, 12px)',
                  }}
                >
                  {monthLabel?.label ?? ''}
                </div>
              );
            })}
          </div>

          {/* Grid rows */}
          {weeks[0]?.map((_, rowIdx) => (
            <div key={`row-${rowIdx}`} className="flex items-center gap-[2px]">
              {/* Day-of-week label */}
              <div
                className="text-[10px] text-muted-foreground shrink-0 w-6 text-right pr-1"
              >
                {WEEK_LABELS[rowIdx]}
              </div>

              {/* Cells */}
              {weeks.map((week, colIdx) => {
                const day = week[rowIdx];
                if (!day) return null;
                const level = getLevel(day.count);

                return (
                  <Tooltip key={day.date}>
                    <TooltipTrigger asChild>
                      <div
                        className={
                          'heatmap-cell ' + getLevelColor(level) +
                          ' w-[10px] h-[10px] sm:w-[12px] sm:h-[12px]'
                        }
                        style={{ '--cell-size': '12px' } as React.CSSProperties}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      <p>{formatDate(day.date)}</p>
                      <p>{day.count > 0 ? `阅读 ${day.count} 章` : '无阅读记录'}</p>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-1.5 mt-3 text-[10px] text-muted-foreground">
        <span>少</span>
        {[0, 1, 2, 3].map((level) => (
          <div
            key={level}
            className={`${getLevelColor(level as 0 | 1 | 2 | 3)} w-[10px] h-[10px] sm:w-[12px] sm:h-[12px] rounded-[2px]`}
          />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
