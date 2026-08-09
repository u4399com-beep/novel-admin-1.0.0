'use client';

import { useState, useId, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PieChart } from 'lucide-react';
import { getGenreColor } from '@/lib/cover-gradient';

// ─── Types ──────────────────────────────────────────────────────────

interface DonutData {
  name: string;
  count: number;
  color?: string;
}

interface CategoryDonutProps {
  data: DonutData[];
}

// ─── Constants ──────────────────────────────────────────────────────

const VIEWBOX = 200;
const STROKE_WIDTH = 28;
const RADIUS = (VIEWBOX - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP_DEGREES = 4;
const GAP_LENGTH = (GAP_DEGREES / 360) * CIRCUMFERENCE;
const CENTER = VIEWBOX / 2;

// ─── Component ──────────────────────────────────────────────────────

export function CategoryDonut({ data }: CategoryDonutProps) {
  const descId = useId();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [drawn, setDrawn] = useState(false);

  // Trigger the CSS drawing animation after the initial paint
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setDrawn(true)),
    );
    return () => cancelAnimationFrame(id);
  }, []);

  const total = useMemo(
    () => data.reduce((sum, d) => sum + d.count, 0),
    [data],
  );

  const segments = useMemo(() => {
    if (total === 0 || data.length === 0) return [];

    const totalGap = GAP_LENGTH * data.length;
    const available = CIRCUMFERENCE - totalGap;
    let cumulative = 0;

    return data.map((d) => {
      const pct = d.count / total;
      const segLen = pct * available;
      const color = d.color || getGenreColor(d.name);
      // Positive offset rotates the dash start counter-clockwise.
      // C/4 shifts from 3-o'clock (SVG default) to 12-o'clock.
      const dashOffset = CIRCUMFERENCE / 4 - cumulative;
      cumulative += segLen + GAP_LENGTH;

      return { ...d, color, segLen, dashOffset, pct };
    });
  }, [data, total]);

  // ── Empty state ──────────────────────────────────────────────────

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="h-12 w-12 rounded-full bg-muted/50 flex items-center justify-center mb-3">
          <PieChart className="h-5 w-5 text-muted-foreground/40" />
        </div>
        <p className="text-sm text-muted-foreground">暂无分类数据</p>
      </div>
    );
  }

  // ── Donut ────────────────────────────────────────────────────────

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="flex flex-col items-center"
    >
      {/* SVG donut */}
      <div className="relative w-[180px] h-[180px] sm:w-[220px] sm:h-[220px]">
        <svg
          viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
          width="100%"
          height="100%"
          role="img"
          aria-describedby={descId}
        >
          <desc id={descId}>
            {`分类分布图：${segments.map((s) => `${s.name} ${s.count}本`).join('、')}，共${total}本`}
          </desc>

          {/* Background track */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={STROKE_WIDTH}
            opacity={0.12}
          />

          {/* Donut segments */}
          {segments.map((seg, i) => (
            <circle
              key={seg.name}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke={seg.color}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="butt"
              strokeDasharray={
                drawn
                  ? `${seg.segLen} ${CIRCUMFERENCE - seg.segLen}`
                  : `0 ${CIRCUMFERENCE}`
              }
              strokeDashoffset={seg.dashOffset}
              style={{
                cursor: 'pointer',
                transition: [
                  `stroke-dasharray 0.8s cubic-bezier(0.25,0.46,0.45,0.94) ${i * 0.06}s`,
                  'opacity 0.2s ease',
                ].join(', '),
                opacity:
                  drawn && hoveredIndex !== null && hoveredIndex !== i
                    ? 0.3
                    : 1,
              }}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <title>{`${seg.name}：${seg.count} 本（${(seg.pct * 100).toFixed(1)}%）`}</title>
            </circle>
          ))}
        </svg>

        {/* Center text overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
          <AnimatePresence mode="wait">
            {hoveredIndex !== null && segments[hoveredIndex] ? (
              <motion.div
                key={`h-${hoveredIndex}`}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.15 }}
                className="text-center"
              >
                <p
                  className="text-xl sm:text-2xl font-bold tabular-nums leading-none"
                  style={{ color: segments[hoveredIndex].color }}
                >
                  {segments[hoveredIndex].count}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1 leading-none truncate max-w-[80px]">
                  {segments[hoveredIndex].name}
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="total"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.15 }}
                className="text-center"
              >
                <p className="text-2xl sm:text-3xl font-bold tabular-nums leading-none">
                  {total}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1 leading-none">
                  总计
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-1.5 mt-4 max-w-full px-1">
        {segments.map((seg, i) => (
          <button
            key={seg.name}
            type="button"
            className={[
              'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -mx-1.5',
              'transition-colors duration-200',
              hoveredIndex === i ? 'bg-muted/60' : 'hover:bg-muted/30',
            ].join(' ')}
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
            aria-label={`${seg.name}：${seg.count} 本`}
          >
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{
                backgroundColor: seg.color,
                transform: hoveredIndex === i ? 'scale(1.4)' : 'scale(1)',
                transition: 'transform 0.2s ease',
              }}
            />
            <span className="text-xs text-muted-foreground truncate max-w-[64px]">
              {seg.name}
            </span>
            <span className="text-[11px] font-medium tabular-nums text-muted-foreground/60">
              {seg.count}
            </span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
