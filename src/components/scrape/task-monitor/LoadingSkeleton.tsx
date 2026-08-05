'use client';

import { Activity } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="p-4 pb-0">
            <div className="flex items-start gap-3">
              <Skeleton className="h-4 w-4 mt-0.5" />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-12" />
                </div>
                <Skeleton className="h-4 w-40" />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-3">
            <div className="flex gap-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function EmptyState({ onBack }: { onBack?: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="rounded-full bg-muted p-4">
          <Activity className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <div className="text-center">
          <p className="text-sm text-muted-foreground">暂无采集任务</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            在采集规则列表中执行规则后，任务将显示在此处
          </p>
        </div>
        {onBack && (
          <Button variant="link" size="sm" onClick={onBack} className="gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            创建采集任务
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
