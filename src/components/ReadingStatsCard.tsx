'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BookOpen, CalendarDays, Flame, Hash } from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────

interface ReadingStatsCardProps {
  className?: string;
}

interface HeatmapData {
  [date: string]: number; // date string -> chapter count
}

// ─── Helpers ─────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Calculate the longest consecutive reading streak from heatmap data.
 */
function calcLongestStreak(data: Record<string, number>): number {
  const dates = Object.keys(data)
    .filter((k) => data[k] > 0)
    .sort();

  if (dates.length === 0) return 0;

  let maxStreak = 1;
  let currentStreak = 1;

  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1] + 'T00:00:00');
    const curr = new Date(dates[i] + 'T00:00:00');
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 1) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }

  return maxStreak;
}

// ─── Component ───────────────────────────────────────────────────────

export function ReadingStatsCard({ className }: ReadingStatsCardProps) {
  const stats = useMemo(() => {
    let data: HeatmapData = {};
    try {
      const raw = localStorage.getItem('reading-heatmap');
      if (raw) data = JSON.parse(raw) as HeatmapData;
    } catch {
      // ignore
    }

    const entries = Object.entries(data);
    const totalReadingDays = entries.filter(([, v]) => v > 0).length;
    const totalChapters = entries.reduce((sum, [, v]) => sum + v, 0);
    const longestStreak = calcLongestStreak(data);

    // Calculate this month's chapters
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const monthChapters = entries
      .filter(([date]) => date.startsWith(monthPrefix))
      .reduce((sum, [, v]) => sum + v, 0);

    return { totalReadingDays, totalChapters, longestStreak, monthChapters };
  }, []);

  const items = [
    {
      icon: CalendarDays,
      label: '总阅读天数',
      value: stats.totalReadingDays,
    },
    {
      icon: Hash,
      label: '总阅读章节',
      value: stats.totalChapters,
    },
    {
      icon: Flame,
      label: '最长连续天数',
      value: stats.longestStreak,
    },
    {
      icon: BookOpen,
      label: '本月阅读章节',
      value: stats.monthChapters,
    },
  ];

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">阅读统计</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="flex flex-col items-center gap-1.5 py-3 rounded-lg bg-muted/40">
                <Icon className="h-5 w-5 text-muted-foreground" />
                <span
                  className="text-2xl font-bold tabular-nums count-animate stat-number text-gradient"
                >
                  {item.value.toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">{item.label}</span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
