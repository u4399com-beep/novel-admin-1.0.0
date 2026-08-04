'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface KeyboardShortcutsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShortcutEntry {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutEntry[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '阅读器',
    shortcuts: [
      { keys: ['←', '→'], description: '上一章 / 下一章' },
      { keys: ['J', 'K'], description: '下一章 / 上一章' },
      { keys: ['↑', '↓'], description: '向上 / 向下滚动' },
      { keys: ['Esc'], description: '关闭面板 / 退出阅读器' },
      { keys: ['F'], description: '全屏切换' },
      { keys: ['+', '-'], description: '增大 / 减小字号' },
      { keys: ['B'], description: '书签面板' },
      { keys: ['Ctrl', 'F'], description: '搜索内容' },
      { keys: ['?'], description: '快捷键帮助' },
    ],
  },
  {
    title: '全局',
    shortcuts: [
      { keys: ['Ctrl', 'K'], description: '命令面板' },
      { keys: ['Ctrl', '/'], description: '显示快捷键' },
    ],
  },
  {
    title: '导航',
    shortcuts: [
      { keys: ['1'], description: '切换到小说列表' },
      { keys: ['2'], description: '切换到分类管理' },
      { keys: ['3'], description: '切换到数据统计' },
      { keys: ['4'], description: '切换到主题设置' },
      { keys: ['5'], description: '切换到系统管理' },
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 select-none items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

export function KeyboardShortcuts({ open, onOpenChange }: KeyboardShortcutsProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 pt-1">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {group.title}
              </h3>
              <div className="divide-y divide-border rounded-lg border">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between px-3 py-2 last:pb-2"
                  >
                    <span className="text-sm text-foreground">
                      {shortcut.description}
                    </span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && (
                            <span className="text-[10px] text-muted-foreground">+</span>
                          )}
                          <Kbd>{key}</Kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default KeyboardShortcuts;
