'use client';

import { useSyncExternalStore } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const shortcuts = [
  { keys: ['⌘K', 'Ctrl+K'], label: '搜索' },
  { keys: ['⌘N', 'Ctrl+N'], label: '新建小说' },
  { keys: ['Esc'], label: '关闭弹窗' },
  { keys: ['↑', '↓'], label: '导航列表' },
  { keys: ['Enter'], label: '选择项目' },
  { keys: ['?'], label: '显示快捷键' },
];

export default function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: KeyboardShortcutsDialogProps) {
  const isMac = useSyncExternalStore(
    () => () => {},
    () => navigator.platform?.includes('Mac') ?? false,
    () => false,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
          <DialogDescription>
            使用以下快捷键可以提升操作效率
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 pt-2">
          {shortcuts.map((shortcut) => {
            const displayKey = shortcut.keys.length === 2
              ? (isMac ? shortcut.keys[0] : shortcut.keys[1])
              : shortcut.keys[0];

            return (
              <div key={shortcut.label} className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">{shortcut.label}</span>
                <div className="flex items-center gap-1">
                  {displayKey.split('+').map((part, i) => (
                    <kbd
                      key={i}
                      className="inline-flex h-5 min-w-5 select-none items-center justify-center rounded border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground"
                    >
                      {part}
                    </kbd>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="pt-3 border-t mt-2">
          <p className="text-xs text-muted-foreground text-center">
            按{' '}
            <kbd className="inline-flex h-5 min-w-5 select-none items-center justify-center rounded border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground">
              ?
            </kbd>{' '}
            随时打开此面板
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}