'use client';

import { motion } from 'framer-motion';
import { BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { NAV_ITEMS } from '@/lib/nav-config';
import type { ViewType } from '@/types';

// ─── Keyboard shortcut keys ─────────────────────────────────────────────────
function getShortcutKeys(count: number, mac: boolean): string[] {
  return Array.from({ length: count }, (_, i) => `${mac ? '\u2318' : '^'}${i + 1}`);
}

interface AdminDesktopSidebarProps {
  collapsed: boolean;
  currentView: string;
  isMac: boolean;
  onToggleCollapse: () => void;
  onViewChange: (view: ViewType) => void;
}

export function AdminDesktopSidebar({ collapsed, currentView, isMac, onToggleCollapse, onViewChange }: AdminDesktopSidebarProps) {
  return (
    <aside className={`hidden lg:flex h-screen flex-col border-r border-slate-800 bg-slate-900 shrink-0 sticky top-0 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] overflow-hidden ${
      collapsed ? 'w-16' : 'w-64'
    }`}>
      {/* Sidebar Header — app brand */}
      <div className={`relative overflow-hidden py-6 pb-5 text-left w-full ${collapsed ? 'px-3' : 'px-6'}`}>
        <div className="absolute inset-0 bg-gradient-to-br from-violet-600/20 via-purple-600/10 to-transparent transition-opacity hover:opacity-80" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg shadow-violet-500/25 transition-shadow hover:shadow-violet-500/40 shrink-0">
            <BookOpen className="h-5 w-5 text-white" />
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <h1 className="text-lg font-bold text-white tracking-tight">小说阁</h1>
              <p className="text-[11px] text-slate-400 tracking-wide">NOVEL MANAGEMENT</p>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Items */}
      <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item, index) => {
          const isActive = currentView === item.key || (item.key === 'novels' && currentView === 'novel-detail');
          const Icon = item.icon;
          const showDivider = index === 3;

          const navButton = (
            <button
              key={item.key}
              onClick={() => onViewChange(item.key as ViewType)}
              className={`
                group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5
                text-sm font-medium transition-all duration-200
                ${
                  isActive
                    ? 'bg-white/10 text-white'
                    : 'text-slate-400 hover:bg-accent/50 hover:text-slate-200'
                }
                ${collapsed ? 'justify-center px-0' : ''}
                tap-feedback
              `}
            >
              {isActive && (
                <motion.div
                  layoutId="sidebar-active-desktop"
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-primary"
                  transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                />
              )}

              <Icon
                className={`h-4.5 w-4.5 shrink-0 transition-colors ${
                  isActive ? 'text-violet-300' : 'text-slate-500 group-hover:text-slate-400'
                }`}
              />

              {!collapsed && (
                <span className="flex-1 text-left">{item.label}</span>
              )}

              {!collapsed && (
                <span className="hidden lg:inline-block text-[10px] font-mono text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shrink-0">
                  {getShortcutKeys(NAV_ITEMS.length, isMac)[index]}
                </span>
              )}

              {isActive && (
                <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-violet-500/10 to-transparent pointer-events-none transition-opacity group-hover:from-violet-500/20 group-hover:via-violet-500/5" />
              )}
            </button>
          );

          if (collapsed) {
            return (
              <div key={item.key}>
                {showDivider && (
                  <div className="py-2">
                    <Separator className="bg-slate-700/50" />
                  </div>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    {navButton}
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8} className="bg-slate-800 text-slate-200 border-slate-700">
                    <p className="text-xs font-medium">{item.label}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{item.description}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          }

          return (
            <div key={item.key}>
              {showDivider && (
                <div className="py-2 px-3">
                  <Separator className="bg-slate-700/50" />
                </div>
              )}
              {navButton}
            </div>
          );
        })}
      </nav>

      {/* Sidebar Footer — collapse toggle */}
      <div className="border-t border-slate-700/50 px-3 py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleCollapse}
              className={`w-full text-slate-400 hover:text-slate-200 hover:bg-white/5 ${collapsed ? 'justify-center px-0' : 'justify-start gap-2'}`}
            >
              {collapsed ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-panel-left-open"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-panel-left-close"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
                  <span className="text-xs">收起菜单</span>
                </>
              )}
            </Button>
          </TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right" sideOffset={8} className="bg-slate-800 text-slate-200 border-slate-700">
              <p className="text-xs">展开菜单</p>
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </aside>
  );
}