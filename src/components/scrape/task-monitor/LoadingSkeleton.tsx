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
    <Card className="animate-fade-in">
      <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
        {/* Animated SVG illustration */}
        <div className="relative">
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none" className="text-muted-foreground/30">
            {/* Document/clipboard shape */}
            <rect x="16" y="12" width="48" height="56" rx="6" stroke="currentColor" strokeWidth="2" fill="none" />
            {/* Lines representing content */}
            <line x1="26" y1="28" x2="54" y2="28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-fade-in" style={{ animationDelay: '0.1s' }} />
            <line x1="26" y1="36" x2="48" y2="36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-fade-in" style={{ animationDelay: '0.2s' }} />
            <line x1="26" y1="44" x2="44" y2="44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="animate-fade-in" style={{ animationDelay: '0.3s' }} />
            {/* Magnifying glass */}
            <circle cx="52" cy="52" r="10" stroke="currentColor" strokeWidth="2" fill="none" className="animate-slide-up" style={{ animationDelay: '0.2s' }} />
            <line x1="59" y1="59" x2="66" y2="66" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="animate-slide-up" style={{ animationDelay: '0.3s' }} />
          </svg>
          {/* Subtle sparkle dots */}
          <span className="absolute -top-1 right-0 h-2 w-2 rounded-full bg-primary/30 status-dot-pulse" />
          <span className="absolute bottom-2 -left-1 h-1.5 w-1.5 rounded-full bg-chart-amber/40 status-dot-pulse" style={{ animationDelay: '1s' }} />
        </div>
        <div className="text-center max-w-xs">
          <p className="text-sm font-medium text-foreground">暂无采集任务</p>
          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
            在采集规则列表中执行规则后，任务将显示在此处。您也可以创建新的采集规则来开始。
          </p>
        </div>
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack} className="gap-1.5 mt-1">
            <Activity className="h-3.5 w-3.5" />
            创建采集任务
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
