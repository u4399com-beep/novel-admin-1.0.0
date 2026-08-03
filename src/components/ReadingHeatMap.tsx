'use client';

import { useMemo } from 'react';
import { Flame } from 'lucide-react';

interface ReadingHeatMapProps {
  data: Record<string, number>;
}

const CELL_SIZE = 12;
const GAP = 2;
const COLS = 13;
const ROWS = 7;
const DAY_LABELS = ['一', '', '三', '', '五', '', '日'];
const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

function getLevel(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  return 3;
}

function getCellColor(level: number): string {
  switch (level) {
    case 0: return 'var(--border)';
    case 1: return 'oklch(0.72 0.19 142)';
    case 2: return 'oklch(0.6 0.24 142)';
    case 3: return 'oklch(0.45 0.24 142)';
    default: return 'var(--border)';
  }
}

export default function ReadingHeatMap({ data }: ReadingHeatMapProps) {
  // Build grid: 13 columns (weeks) × 7 rows (Mon-Sun)
  const { cells, monthLabels, totalChapters } = useMemo(() => {
    const today = new Date();
    // Align to Monday of the current week
    const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ...
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() - mondayOffset); // this week's Monday

    // We want exactly 13 weeks (91 days) ending at this week's Monday
    // But we only display 90 days, so start from 90 days ago
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 89); // 90 days including today

    // Align start to Monday
    const startDay = startDate.getDay();
    const startMondayOffset = startDay === 0 ? 6 : startDay - 1;
    const gridStart = new Date(startDate);
    gridStart.setDate(gridStart.getDate() - startMondayOffset);

    // Build cells: 13 weeks × 7 days
    const gridCells: { date: string; count: number; inRange: boolean }[] = [];
    const d = new Date(gridStart);
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const dateStr = d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
        const inRange = d >= startDate && d <= today;
        gridCells.push({
          date: dateStr,
          count: inRange ? (data[dateStr] ?? 0) : 0,
          inRange,
        });
        d.setDate(d.getDate() + 1);
      }
    }

    // Month labels: show month when the first day of month falls in that week column
    const labels: { col: number; text: string }[] = [];
    const labelSet = new Set<string>();
    for (let col = 0; col < COLS; col++) {
      // Check Monday of this column
      const monIdx = col * 7; // Monday is row 0
      const cell = gridCells[monIdx];
      if (!cell.inRange) continue;
      // Check if any day in this week is the 1st
      for (let row = 0; row < ROWS; row++) {
        const c = gridCells[col * 7 + row];
        if (!c.inRange) continue;
        const parts = c.date.split('-');
        if (parts[2] === '01') {
          const monthText = MONTH_NAMES[parseInt(parts[1]) - 1];
          if (!labelSet.has(monthText)) {
            labelSet.add(monthText);
            labels.push({ col, text: monthText });
          }
          break;
        }
      }
    }

    // Total chapters in range
    let total = 0;
    for (const [date, count] of Object.entries(data)) {
      const dParts = date.split('-');
      const dDate = new Date(parseInt(dParts[0]), parseInt(dParts[1]) - 1, parseInt(dParts[2]));
      if (dDate >= startDate && dDate <= today) {
        total += count;
      }
    }

    return { cells: gridCells, monthLabels: labels, totalChapters: total };
  }, [data]);

  return (
    <div className="rounded-xl border bg-card p-5 card-glow card-border-glow inset-shadow">
      <div className="flex items-center gap-2 mb-4">
        <Flame className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold link-underline inline-block">阅读活跃度</h2>
        {totalChapters > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">
            过去 90 天共读 <span className="stat-value font-medium text-foreground">{totalChapters}</span> 章
          </span>
        )}
      </div>

      <div className="overflow-x-auto pb-2 -mx-1 px-1">
        <div className="inline-flex flex-col gap-0" style={{ minWidth: 'fit-content' }}>
          {/* Month labels row */}
          <div className="flex gap-0" style={{ paddingLeft: `${CELL_SIZE + 8}px` }}>
            {Array.from({ length: COLS }).map((_, col) => {
              const label = monthLabels.find(l => l.col === col);
              return (
                <div
                  key={`month-${col}`}
                  className="text-[10px] text-muted-foreground truncate"
                  style={{ width: CELL_SIZE, minWidth: CELL_SIZE, marginRight: GAP }}
                >
                  {label ? label.text : ''}
                </div>
              );
            })}
          </div>

          {/* Grid rows with day labels */}
          {Array.from({ length: ROWS }).map((_, row) => (
            <div key={`row-${row}`} className="flex items-center gap-0">
              {/* Day label */}
              <div
                className="text-[10px] text-muted-foreground pr-2 text-right"
                style={{ width: CELL_SIZE + 6 }}
              >
                {DAY_LABELS[row]}
              </div>

              {/* Cells */}
              {Array.from({ length: COLS }).map((_, col) => {
                const cell = cells[col * 7 + row];
                const level = cell.inRange ? getLevel(cell.count) : -1;
                const bgColor = level === -1 ? 'transparent' : getCellColor(level);
                const opacity = level === 0 ? 0.3 : level === -1 ? 0 : 1;
                return (
                  <div
                    key={`cell-${col}-${row}`}
                    title={cell.inRange ? `${cell.date}：${cell.count > 0 ? `${cell.count} 章` : '无记录'}` : ''}
                    className="rounded-sm"
                    style={{
                      width: CELL_SIZE,
                      height: CELL_SIZE,
                      minWidth: CELL_SIZE,
                      minHeight: CELL_SIZE,
                      marginRight: GAP,
                      marginBottom: GAP,
                      backgroundColor: bgColor,
                      opacity,
                      border: level === 0 && cell.inRange ? '1px solid var(--border)' : 'none',
                      transition: 'transform 0.1s ease',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.3)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                  />
                );
              })}
            </div>
          ))}

          {/* Legend */}
          <div className="flex items-center gap-1.5 mt-2" style={{ paddingLeft: `${CELL_SIZE + 8}px` }}>
            <span className="text-[10px] text-muted-foreground">少</span>
            {[0, 1, 2, 3].map((level) => (
              <div
                key={`legend-${level}`}
                className="rounded-sm"
                style={{
                  width: CELL_SIZE,
                  height: CELL_SIZE,
                  backgroundColor: getCellColor(level),
                  opacity: level === 0 ? 0.3 : 1,
                  border: level === 0 ? '1px solid var(--border)' : 'none',
                }}
              />
            ))}
            <span className="text-[10px] text-muted-foreground">多</span>
          </div>
        </div>
      </div>
    </div>
  );
}
