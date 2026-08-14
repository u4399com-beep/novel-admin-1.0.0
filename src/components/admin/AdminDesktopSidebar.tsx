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
    <aside className={`hidden lg:flex h-screen flex-col border-r border-border bg-card shrink-0 sticky top-0 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] overflow-hidden shadow-sm ${
      collapsed ? 'w-16' : 'w-64'
    }`}>
      {/* Sidebar Header — app brand */}
      <div className={`relative overflow-hidden py-6 pb-5 text-left w-full ${collapsed ? 'px-3' : 'px-6'}`}>
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-primary/10 to-transparent transition-opacity hover:opacity-80" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 transition-shadow hover:shadow-primary/40 shrink-0">
            <BookOpen className="h-5 w-5 text-primary-foreground" />
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <h1 className="text-lg font-bold text-foreground tracking-tight">小说阁</h1>
              <p className="text-[11px] text-muted-foreground tracking-wide">NOVEL MANAGEMENT</p>
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
              aria-label={item.label}
              onClick={() => onViewChange(item.key as ViewType)}
              className={`
                group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5
                text-sm font-medium transition-colors duration-150
                ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }
                ${collapsed ? 'justify-center px-0' : ''}
                tap-feedback
              `}
            >
              {isActive && (
                <motion.div
                  layoutId="sidebar-active-desktop"
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-primary-foreground/40"
                  transition={{ type: 'spring', stiffness: 350, damping: 30 }}
                />
              )}

              <Icon
                className={`h-[1.125rem] w-[1.125rem] shrink-0 transition-colors duration-150 ${
                  isActive ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-foreground'
                }`}
              />

              {!collapsed && (
                <span className="flex-1 text-left">{item.label}</span>
              )}

              {!collapsed && (
                <span className="hidden lg:inline-block text-[10px] font-mono text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shrink-0">
                  {getShortcutKeys(NAV_ITEMS.length, isMac)[index]}
                </span>
              )}

              {isActive && (
                <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-primary-foreground/5 to-transparent pointer-events-none transition-opacity group-hover:from-primary-foreground/10 group-hover:via-primary-foreground/[0.02]" />
              )}
            </button>
          );

          if (collapsed) {
            return (
              <div key={item.key}>
                {showDivider && (
                  <div className="py-2">
                    <Separator />
                  </div>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    {navButton}
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    <p className="text-xs font-medium">{item.label}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{item.description}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          }

          return (
            <div key={item.key}>
              {showDivider && (
                <div className="py-2 px-3">
                  <Separator />
                </div>
              )}
              {navButton}
            </div>
          );
        })}
      </nav>

      {/* Sidebar Footer — collapse toggle */}
      <div className="border-t border-border px-3 py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleCollapse}
              className={`w-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors duration-150 ${collapsed ? 'justify-center px-0' : 'justify-start gap-2'}`}
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
            <TooltipContent side="right" sideOffset={8}>
              <p className="text-xs">展开菜单</p>
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </aside>
  );
}