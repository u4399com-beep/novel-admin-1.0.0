'use client';

import { useState } from 'react';
import { BookOpen, Menu } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { NAV_ITEMS } from '@/lib/nav-config';
import { useAppStore } from '@/stores/app-store';

// ─── Nav Items ────────────────────────────────────────────────────────────────

import type { ViewType } from '@/types';

// ─── Sidebar Content (shared between desktop & mobile) ───────────────────────

function SidebarContent() {
  const currentView = useAppStore((s) => s.currentView);
  const setCurrentView = useAppStore((s) => s.setCurrentView);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="relative overflow-hidden px-6 py-6 pb-5">
        <div className="absolute inset-0 bg-gradient-to-br from-violet-600/20 via-purple-600/10 to-transparent" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/25">
            <BookOpen className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight">小说管理</h1>
            <p className="text-[11px] text-slate-400 tracking-wide">NOVEL MANAGEMENT</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = currentView === item.key;
          const Icon = item.icon;

          return (
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

              <span>{item.label}</span>

              {/* Hover glow effect */}
              {isActive && (
                <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-violet-500/10 to-transparent pointer-events-none" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-700/50 px-6 py-4 space-y-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>系统运行中</span>
        </div>
        <div className="text-[10px] text-slate-600">
          v1.0.0
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