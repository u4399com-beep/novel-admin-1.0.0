'use client';

import { useState, useEffect, useRef } from 'react';
import { BookOpen, Menu } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { NAV_ITEMS } from '@/lib/nav-config';
import { useAppStore } from '@/stores/app-store';

import type { ViewType } from '@/types';

// ─── Keyboard shortcut map (desktop only) ──────────────────────────────────────
const SHORTCUT_KEYS = ['⌘1', '⌘2', '⌘3', '⌘4', '⌘5', '⌘6', '⌘7', '⌘8'] as const;

// ─── Divider after first N items ───────────────────────────────────────────────
const DIVIDER_AFTER_INDEX = 3; // after 4th item (index 3)

// ─── Sidebar Content (shared between desktop & mobile) ───────────────────────

function SidebarContent() {
  const currentView = useAppStore((s) => s.currentView);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const [totalNovels, setTotalNovels] = useState<number | null>(null);
  const [lastRefreshText, setLastRefreshText] = useState('刚刚');
  const lastRefreshStartRef = useRef(Date.now());

  // Fetch total novels count for footer & start refresh timer on mount
  useEffect(() => {
    const controller = new AbortController();

    // Fetch novel count
    (async () => {
      try {
        const res = await fetch('/api/dashboard', { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (typeof data.totalNovels === 'number') {
            setTotalNovels(data.totalNovels);
          }
        }
      } catch {
        // silently fail – footer will show fallback
      }
    })();

    // Update "上次刷新" text every 60 seconds
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastRefreshStartRef.current) / 1000);
      if (elapsed < 60) {
        setLastRefreshText('刚刚');
      } else if (elapsed < 120) {
        setLastRefreshText('1分钟前');
      } else {
        const mins = Math.floor(elapsed / 60);
        setLastRefreshText(`${mins}分钟前`);
      }
    }, 60000);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Header — clickable to go to dashboard */}
      <button
        onClick={() => setCurrentView('dashboard')}
        className="relative overflow-hidden px-6 py-6 pb-5 text-left w-full cursor-pointer"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-violet-600/20 via-purple-600/10 to-transparent transition-opacity hover:opacity-80" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/25 transition-shadow hover:shadow-violet-500/40">
            <BookOpen className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight">小说管理</h1>
            <p className="text-[11px] text-slate-400 tracking-wide">NOVEL MANAGEMENT</p>
          </div>
        </div>
      </button>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item, index) => {
          const isActive = currentView === item.key;
          const Icon = item.icon;

          // Insert divider after first N items
          const showDivider = index === DIVIDER_AFTER_INDEX;

          const navButton = (
            <button
              key={item.key}
              onClick={() => setCurrentView(item.key)}
              className={`
                group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5
                text-sm font-medium transition-all duration-200
                ${
                  isActive
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }
              `}
            >
              {/* Active indicator bar */}
              {isActive && (
                <motion.div
                  layoutId="sidebar-active"
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-violet-400"
                  transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                />
              )}

              <Icon
                className={`h-4.5 w-4.5 shrink-0 transition-colors ${
                  isActive ? 'text-violet-300' : 'text-slate-500 group-hover:text-slate-400'
                }`}
              />

              <span className="flex-1 text-left">{item.label}</span>

              {/* Keyboard shortcut hint — desktop only, visible on hover */}
              <span className="hidden lg:inline-block text-[10px] font-mono text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shrink-0">
                {SHORTCUT_KEYS[index]}
              </span>

              {/* Active hover glow */}
              {isActive && (
                <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-violet-500/10 to-transparent pointer-events-none transition-opacity group-hover:from-violet-500/20 group-hover:via-violet-500/5" />
              )}
            </button>
          );

          // Wrap with tooltip on desktop
          const tooltipContent = (
            <TooltipContent side="right" sideOffset={8}>
              <p className="text-xs text-slate-800 dark:text-slate-200">{item.description}</p>
            </TooltipContent>
          );

          return (
            <div key={item.key}>
              {showDivider && (
                <div className="py-2 px-3">
                  <Separator className="bg-slate-700/50" />
                </div>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  {navButton}
                </TooltipTrigger>
                {tooltipContent}
              </Tooltip>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-700/50 px-6 py-4 space-y-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>{totalNovels !== null ? `${totalNovels} 部小说` : '加载中...'}</span>
        </div>
        <div className="text-[10px] text-slate-600">
          上次刷新: {lastRefreshText}
        </div>
      </div>
    </div>
  );
}

// ─── Desktop Sidebar ─────────────────────────────────────────────────────────

function DesktopSidebar() {
  return (
    <aside className="hidden lg:flex h-screen w-64 flex-col border-r border-slate-800 bg-slate-900 shrink-0 sticky top-0">
      <SidebarContent />
    </aside>
  );
}

// ─── Mobile Sidebar (Sheet) ───────────────────────────────────────────────────

function MobileSidebar() {
  const currentView = useAppStore((s) => s.currentView);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const [open, setOpen] = useState(false);

  const handleNav = (view: ViewType) => {
    setCurrentView(view);
    setOpen(false);
  };

  return (
    <div className="lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="shrink-0">
            <Menu className="h-5 w-5" />
            <span className="sr-only">菜单</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0 bg-slate-900 border-slate-800">
          <SheetTitle className="sr-only">导航菜单</SheetTitle>
          <SidebarContent />
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export { MobileSidebar };
export default function AppSidebar() {
  return <DesktopSidebar />;
}