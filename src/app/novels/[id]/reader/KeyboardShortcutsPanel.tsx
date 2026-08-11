'use client';

import { Keyboard } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ShortcutEntry {
  keys: string[];
  label: string;
}

const SHORTCUTS: ShortcutEntry[] = [
  { keys: ['←', '→'], label: '上一章/下一章' },
  { keys: ['J', 'K'], label: '下一章/上一章' },
  { keys: ['↑', '↓'], label: '向上/下滚动' },
  { keys: ['B'], label: '书签面板' },
  { keys: ['F'], label: '全屏切换' },
  { keys: ['Ctrl+F'], label: '搜索内容' },
  { keys: ['?'], label: '本帮助面板' },
  { keys: ['Esc'], label: '关闭面板' },
];

export interface KeyboardShortcutsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsPanel({
  open,
  onOpenChange,
}: KeyboardShortcutsPanelProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            阅读器快捷键
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 pt-1">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{s.label}</span>
              <div className="flex items-center gap-0.5">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="inline-flex h-5 min-w-5 select-none items-center justify-center rounded kbd-styled px-1.5 font-mono text-[10px] font-medium text-muted-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
