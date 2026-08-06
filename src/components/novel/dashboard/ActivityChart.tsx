'use client';

import { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';

// ─── Chart config constants ────────────────────────────────────────────────
const activityChartConfig: ChartConfig = {
  chaptersCreated: {
    label: '章节更新',
    color: '#a78bfa',
  },
  novelsCreated: {
    label: '新增小说',
    color: '#10b981',
  },
  scrapeRuns: {
    label: '采集任务',
    color: '#f59e0b',
  },
};

// ─── Types ────────────────────────────────────────────────────────────────
interface DailyActivity {
  date: string;
  novelsCreated: number;
  chaptersCreated: number;
  scrapeRuns: number;
}

interface ActivityChartProps {
  dailyActivity: DailyActivity[];
  loading: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────
export function ActivityChart({ dailyActivity, loading }: ActivityChartProps) {
  const chartData = useMemo(() => {
    if (!dailyActivity.length) return [];
    return dailyActivity.map((d) => {
      const date = new Date(d.date + 'T00:00:00Z');
      const month = date.getUTCMonth() + 1;
      const day = date.getUTCDate();
      return {
        name: `${month}/${day}`,
        novelsCreated: d.novelsCreated,
        chaptersCreated: d.chaptersCreated,
        scrapeRuns: d.scrapeRuns,
      };
    });
  }, [dailyActivity]);

  return (
    <Card className="card-glass">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          近 7 天活动
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-4">
            <div className="flex items-end justify-between gap-2">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} className="h-[120px] flex-1 rounded-t-md" style={{ height: `${60 + Math.sin(i * 1.5) * 30 + 30}px` }} />
              ))}
            </div>
            <div className="flex justify-between">
              {Array.from({ length: 7 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-8" />
              ))}
            </div>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-[250px] items-center justify-center text-sm text-muted-foreground">
            <div className="text-center">
              <BarChart3 className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
              <p>暂无数据</p>
            </div>
          </div>
        ) : (
          <ChartContainer config={activityChartConfig} className="h-[250px] w-full">
            <AreaChart data={chartData} margin={{ left: 0, right: 10, top: 5, bottom: 0 }}>
              <defs>
                <linearGradient id="chapterGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#a78bfa" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="novelGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="scrapeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} strokeOpacity={0.15} />
              <XAxis
                dataKey="name"
                tickLine={false}
                axisLine={false}
                fontSize={12}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                fontSize={12}
                allowDecimals={false}
                label={{
                  value: '数量',
                  angle: -90,
                  position: 'insideLeft',
                  offset: -2,
                  style: { fontSize: 12, fill: 'var(--muted-foreground)' },
                }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend
                content={<ChartLegendContent />}
              />
              <Area
                type="monotone"
                dataKey="scrapeRuns"
                stroke="#f59e0b"
                strokeWidth={1.5}
                fill="url(#scrapeGradient)"
                dot={false}
                activeDot={{ r: 4, fill: '#f59e0b', strokeWidth: 2, stroke: 'var(--background)' }}
              />
              <Area
                type="monotone"
                dataKey="novelsCreated"
                stroke="#10b981"
                strokeWidth={1.5}
                fill="url(#novelGradient)"
                dot={false}
                activeDot={{ r: 4, fill: '#10b981', strokeWidth: 2, stroke: 'var(--background)' }}
              />
              <Area
                type="monotone"
                dataKey="chaptersCreated"
                stroke="#a78bfa"
                strokeWidth={2}
                fill="url(#chapterGradient)"
                dot={{ r: 4, fill: '#a78bfa', strokeWidth: 2, stroke: 'var(--background)' }}
                activeDot={{ r: 6, fill: '#a78bfa', strokeWidth: 2, stroke: 'var(--background)' }}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
