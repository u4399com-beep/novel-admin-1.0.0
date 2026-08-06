'use client';

import { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
} from 'recharts';
import { NOVEL_STATUS_MAP } from '@/lib/constants';

// ─── Chart config constants ────────────────────────────────────────────────
const statusChartColors: Record<string, string> = {
  ongoing: '#10b981',
  completed: '#f59e0b',
  hiatus: '#94a3b8',
};

const statusChartConfig: ChartConfig = {
  count: {
    label: '数量',
    color: '#10b981',
  },
};

// ─── Types ────────────────────────────────────────────────────────────────
interface StatusEntry {
  status: string;
  count: number;
}

interface StatusChartProps {
  statusDistribution: StatusEntry[];
  loading: boolean;
  onClick: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────
export function StatusChart({ statusDistribution, loading, onClick }: StatusChartProps) {
  const chartData = useMemo(
    () =>
      statusDistribution.map((item) => ({
        name: NOVEL_STATUS_MAP[item.status]?.label ?? item.status,
        status: item.status,
        count: item.count,
        fill: statusChartColors[item.status] ?? '#94a3b8',
      })),
    [statusDistribution],
  );

  return (
    <Card
      className="cursor-pointer transition-all duration-200 hover:shadow-md hover:border-primary/20 card-glass hover-scale"
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-5 w-5 text-muted-foreground" />
          状态分布
          <span className="ml-auto text-xs font-normal text-muted-foreground">点击查看详情</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-6 flex-1 rounded-full" />
                <Skeleton className="h-4 w-8" />
              </div>
            ))}
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            暂无数据
          </div>
        ) : (
          <ChartContainer config={statusChartConfig} className="h-[200px] w-full">
            <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 20, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <YAxis
                dataKey="name"
                type="category"
                tickLine={false}
                axisLine={false}
                width={60}
                fontSize={12}
              />
              <XAxis type="number" tickLine={false} axisLine={false} fontSize={12} />
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={28} cursor="pointer">
                {chartData.map((entry, index) => (
                  <Cell key={index} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
