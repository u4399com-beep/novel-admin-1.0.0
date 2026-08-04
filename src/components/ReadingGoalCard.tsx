'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Target, Clock, CheckCircle2, Settings2, Flame } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useReadingGoal, type ReadingGoal } from '@/lib/use-reading-goal';

// ─── Goal Progress Ring ──────────────────────────────────────────

function GoalRing({ percent, size = 80, strokeWidth = 6, color }: {
  percent: number; size?: number; strokeWidth?: number; color: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(percent, 100) / 100) * circumference;

  return (
    <svg width={size} height={size} className="-rotate-90" viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none"
        stroke="var(--muted)"
        strokeWidth={strokeWidth}
        opacity="0.25"
      />
      <motion.circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 0.8, ease: 'easeOut' as const }}
      />
    </svg>
  );
}

// ─── Main Component ──────────────────────────────────────────────

export function ReadingGoalCard() {
  const {
    goal, setGoal, todayProgress, chapterPercent, minutesPercent, goalCompleted,
  } = useReadingGoal();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tempGoal, setTempGoal] = useState<ReadingGoal>(goal);

  const openSettings = () => {
    setTempGoal(goal);
    setSettingsOpen(true);
  };

  const saveSettings = () => {
    setGoal(tempGoal);
    setSettingsOpen(false);
  };

  if (!goal.enabled) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border bg-card p-4 card-glow card-border-glow"
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">每日阅读目标</span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={openSettings}>
            <Settings2 className="h-3.5 w-3.5 mr-1" />
            设置目标
          </Button>
        </div>
        <p className="text-xs text-muted-foreground text-center py-4">
          设置每日阅读目标，跟踪你的阅读习惯
        </p>
      </motion.div>
    );
  }

  const primaryPercent = chapterPercent;
  const primaryColor = goalCompleted ? 'var(--chart-emerald)' : 'var(--primary)';

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border bg-card p-4 card-glow card-border-glow relative overflow-hidden"
      >
        {goalCompleted && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute top-2 right-2"
          >
            <div className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded-full px-2 py-0.5">
              <CheckCircle2 className="h-3 w-3" />
              已达成
            </div>
          </motion.div>
        )}

        <div className="flex items-center gap-2 mb-4">
          <Target className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">今日目标</span>
          <Button variant="ghost" size="icon" className="h-6 w-6 ml-auto" onClick={openSettings}>
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex items-center gap-5">
          {/* Primary ring - chapters */}
          <div className="relative shrink-0">
            <GoalRing percent={primaryPercent} color={primaryColor} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-bold tabular-nums" style={{ color: primaryColor }}>
                {primaryPercent}%
              </span>
            </div>
          </div>

          <div className="flex-1 space-y-3 min-w-0">
            {/* Chapters progress */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <Flame className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">章节</span>
                </div>
                <span className="text-xs tabular-nums font-medium">
                  {todayProgress.chaptersRead}/{goal.dailyChapters}
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted/50 overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: 'var(--primary)' }}
                  initial={{ width: 0 }}
                  animate={{ width: `${chapterPercent}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' as const }}
                />
              </div>
            </div>

            {/* Minutes progress */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">时长</span>
                </div>
                <span className="text-xs tabular-nums font-medium">
                  {todayProgress.minutesRead}/{goal.dailyMinutes}分钟
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted/50 overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: 'var(--chart-amber)' }}
                  initial={{ width: 0 }}
                  animate={{ width: `${minutesPercent}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' as const, delay: 0.15 }}
                />
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Settings Dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>设置每日阅读目标</DialogTitle>
            <DialogDescription>设定你每天想要达到的阅读量</DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Enable toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">启用目标</p>
                <p className="text-xs text-muted-foreground">开启后将在统计页显示进度</p>
              </div>
              <Switch
                checked={tempGoal.enabled}
                onCheckedChange={(checked) => setTempGoal((prev) => ({ ...prev, enabled: checked }))}
              />
            </div>

            {/* Daily chapters */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-muted-foreground" />
                  <label className="text-sm font-medium">每日章节目标</label>
                </div>
                <span className="text-sm font-bold tabular-nums text-primary">{tempGoal.dailyChapters} 章</span>
              </div>
              <Slider
                value={[tempGoal.dailyChapters]}
                onValueChange={([v]) => setTempGoal((prev) => ({ ...prev, dailyChapters: v }))}
                min={1}
                max={100}
                step={1}
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>1章</span>
                <span>50章</span>
                <span>100章</span>
              </div>
            </div>

            {/* Daily minutes */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <label className="text-sm font-medium">每日时长目标</label>
                </div>
                <span className="text-sm font-bold tabular-nums text-primary">{tempGoal.dailyMinutes} 分钟</span>
              </div>
              <Slider
                value={[tempGoal.dailyMinutes]}
                onValueChange={([v]) => setTempGoal((prev) => ({ ...prev, dailyMinutes: v }))}
                min={5}
                max={180}
                step={5}
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>5分钟</span>
                <span>90分钟</span>
                <span>180分钟</span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>取消</Button>
            <Button onClick={saveSettings}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
