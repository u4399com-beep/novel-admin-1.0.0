'use client';

import { useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  BookOpen,
  FolderTree,
  Tags,
  Bug,
  Download,
  Palette,
  Globe,
  Plus,
} from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppStore } from '@/stores/app-store';
import type { ViewType } from '@/types';

const navItems: {
  view: ViewType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut: string;
}[] = [
  { view: 'dashboard', label: '仪表盘', icon: LayoutDashboard, shortcut: 'G D' },
  { view: 'novels', label: '小说管理', icon: BookOpen, shortcut: 'G N' },
  { view: 'categories', label: '分类管理', icon: FolderTree, shortcut: 'G C' },
  { view: 'tags', label: '标签管理', icon: Tags, shortcut: 'G T' },
  { view: 'scrape', label: '采集管理', icon: Bug, shortcut: 'G S' },
  { view: 'download', label: '下载中心', icon: Download, shortcut: 'G O' },
  { view: 'themes', label: '主题管理', icon: Palette, shortcut: 'G H' },
  { view: 'sites', label: '站群管理', icon: Globe, shortcut: 'G W' },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

export default function CommandPalette() {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);

  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setNovelFormOpen = useAppStore((s) => s.setNovelFormOpen);
  const setEditingNovel = useAppStore((s) => s.setEditingNovel);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setOpen(!open);
    }
  }, [open, setOpen]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleNavSelect = useCallback(
    (view: ViewType) => {
      setCurrentView(view);
      setOpen(false);
    },
    [setCurrentView, setOpen],
  );

  const handleNewNovel = useCallback(() => {
    setEditingNovel(null);
    setNovelFormOpen(true);
    setOpen(false);
  }, [setEditingNovel, setNovelFormOpen, setOpen]);

  const handleViewDashboard = useCallback(() => {
    setCurrentView('dashboard');
    setOpen(false);
  }, [setCurrentView, setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="overflow-hidden p-0 gap-0 max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>命令面板</DialogTitle>
          <DialogDescription>快速导航至各功能页面</DialogDescription>
        </DialogHeader>

        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: [0.23, 1, 0.32, 1] }}
        >
          <Command className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4">
            <CommandInput placeholder="搜索页面或操作..." />
            <CommandList className="max-h-80">
              <CommandEmpty>未找到匹配结果</CommandEmpty>

              <CommandGroup heading="快捷操作">
                <CommandItem onSelect={handleNewNovel}>
                  <Plus className="size-4 text-muted-foreground" />
                  <span>新建小说</span>
                  <span className="ml-auto flex gap-0.5">
                    <Kbd>N</Kbd>
                  </span>
                </CommandItem>
                <CommandItem onSelect={handleViewDashboard}>
                  <LayoutDashboard className="size-4 text-muted-foreground" />
                  <span>查看仪表盘</span>
                  <span className="ml-auto flex gap-0.5">
                    <Kbd>G</Kbd>
                    <Kbd>D</Kbd>
                  </span>
                </CommandItem>
              </CommandGroup>

              <CommandSeparator />

              <CommandGroup heading="页面导航">
                {navItems.map((item) => (
                  <CommandItem
                    key={item.view}
                    onSelect={() => handleNavSelect(item.view)}
                    value={`${item.label} ${item.shortcut}`}
                  >
                    <item.icon className="size-4 text-muted-foreground" />
                    <span>{item.label}</span>
                    <span className="ml-auto flex gap-0.5">
                      {item.shortcut.split(' ').map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>

            {/* Footer hint */}
            <div className="border-t px-4 py-2 text-center text-xs text-muted-foreground">
              按 <Kbd>ESC</Kbd> 关闭
            </div>
          </Command>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}