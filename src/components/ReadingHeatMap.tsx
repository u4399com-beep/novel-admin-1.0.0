'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Loader2 } from 'lucide-react';

interface HeatMapProps {
  sessionId: string;
  days?: number;
  className?: string;
}

interface HeatMapData {
  dates: Record<string, number>;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function getIntensity(count: number, max: number): string {
  if (count === 0) return 'bg-muted/30';
  const ratio = max > 0 ? count / max : 0;
  if (ratio <= 0.25) return 'bg-primary/20';
  if (ratio <= 0.5) return 'bg-primary/40';
  if (ratio <= 0.75) return 'bg-primary/60';
  return 'bg-primary';
}

function getDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function ReadingHeatMap({ sessionId, days = 84, className = '' }: HeatMapProps) {
  const [data, setData] = useState<HeatMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<{ date: string; count: number; x: number; y: number } | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await apiFetch<HeatMapData>(
        `/api/public/reading-heatMap?sessionId=${encodeURIComponent(sessionId)}`,
        { signal, timeout: 10000, silent: true }
      );
      if (!signal?.aborted) setData(result);
    } catch {
      // silent
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) { setLoading(false); return; }
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData, sessionId]);

  // Build grid: rows = weekdays (Mon-Sun), cols = weeks
  const grid = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Align to Monday
    const startDay = new Date(today);
    startDay.setDate(startDay.getDate() - (days - 1));
    // Go back to previous Monday
    const dayOfWeek = startDay.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startDay.setDate(startDay.getDate() - diff);

    const cells: Array<{ date: string; count: number; row: number; col: number; isFuture: boolean }> = [];
    const current = new Date(startDay);
    let col = 0;
    while (current <= today || current.getDay() !== 1) {
      if (current.getDay() === 1 && col > 0 && current > today) break;
      const dateStr = getDateStr(current);
      const isFuture = current > today;
      const count = isFuture ? 0 : (data?.dates?.[dateStr] || 0);
      const row = current.getDay() === 0 ? 6 : current.getDay() - 1;
      cells.push({ date: dateStr, count, row, col, isFuture });
      current.setDate(current.getDate() + 1);
      if (current.getDay() === 1) col++;
    }
    return { cells, totalCols: col + 1 };
  }, [data, days]);

  const maxCount = Math.max(1, ...Object.values(data?.dates || {}));

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-8 ${className}`}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalChapters = Object.values(data?.dates || {}).reduce((s, c) => s + c, 0);
  const activeDays = Object.values(data?.dates || {}).filter(c => c > 0).length;

  return (
    <div className={className}>
      {/* Summary */}
      <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground">
        <span>过去 {days} 天阅读 <strong className="text-foreground">{totalChapters}</strong> 章</span>
        <span className="dot-sep"></span>
        <span>活跃 <strong className="text-foreground">{activeDays}</strong> 天</span>
        <span className="dot-sep"></span>
        <span>日均 <strong className="text-foreground">{activeDays > 0 ? (totalChapters / Math.min(days, activeDays) || 0).toFixed(1) : '0'}</strong> 章</span>
      </div>

      {/* Heatmap grid */}
      <div className="relative overflow-x-auto">
        <div className="inline-flex gap-[3px]" onMouseLeave={() => setTooltip(null)}>
          {/* Weekday labels */}
          <div className="flex flex-col gap-[3px] mr-1">
            {[1, 3, 5].map(row => (
              <div
                key={row}
                className="w-4 h-[11px] text-[9px] text-muted-foreground/60 flex items-center justify-end"
                style={{ gridRow: row + 1 }}
              >
                {WEEKDAYS[row - 1]}
              </div>
            ))}
          </div>

          {/* Grid columns (weeks) */}
          {Array.from({ length: grid.totalCols }, (_, colIdx) => (
            <div key={colIdx} className="flex flex-col gap-[3px]">
              {Array.from({ length: 7 }, (_, rowIdx) => {
                const cell = grid.cells.find(c => c.row === rowIdx && c.col === colIdx);
                if (!cell) return <div key={rowIdx} className="w-[11px] h-[11px] rounded-sm" />;
                return (
                  <div
                    key={rowIdx}
                    className={`w-[11px] h-[11px] rounded-sm transition-colors ${
                      cell.isFuture ? 'bg-transparent' : getIntensity(cell.count, maxCount)
                    }`}
                    onMouseEnter={(e) => {
                      if (!cell.isFuture) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setTooltip({
                          date: cell.date,
                          count: cell.count,
                          x: rect.left + rect.width / 2,
                          y: rect.top,
                        });
                      }
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* Tooltip */}
        {tooltip && (
          <div
            className="fixed z-50 px-2 py-1.5 text-[11px] rounded-md bg-popover text-popover-foreground border shadow-md pointer-events-none"
            style={{
              left: tooltip.x,
              top: tooltip.y - 8,
              transform: 'translate(-50%, -100%)',
            }}
          >
            <div className="font-medium">{tooltip.date}</div>
            <div className="text-muted-foreground">{tooltip.count} 章已读</div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-1.5 mt-3 text-[10px] text-muted-foreground">
        <span>少</span>
        <div className="w-[11px] h-[11px] rounded-sm bg-muted/30" />
        <div className="w-[11px] h-[11px] rounded-sm bg-primary/20" />
        <div className="w-[11px] h-[11px] rounded-sm bg-primary/40" />
        <div className="w-[11px] h-[11px] rounded-sm bg-primary/60" />
        <div className="w-[11px] h-[11px] rounded-sm bg-primary" />
        <span>多</span>
      </div>
    </div>
  );
}


