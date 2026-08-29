'use client';

import { useCallback } from 'react';
import { LayoutGrid, Rows3, Newspaper, BookOpen } from 'lucide-react';
import { useLayoutTheme, type LayoutTheme, LAYOUT_META } from '@/lib/use-layout-theme';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';

const ICON_MAP: Record<LayoutTheme, React.ComponentType<{ className?: string }>> = {
  grid: LayoutGrid,
  magazine: Newspaper,
  list: Rows3,
  'novel-site': BookOpen,
};

export function LayoutSwitcher() {
  const { theme, setTheme } = useLayoutTheme();

  const handleSelect = useCallback((t: LayoutTheme) => {
    setTheme(t);
  }, [setTheme]);

  const CurrentIcon = ICON_MAP[theme];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hover-scale"
          aria-label="切换布局主题"
        >
          <CurrentIcon className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="end">
        <p className="text-xs font-medium text-muted-foreground px-2 mb-1.5">布局风格</p>
        <div className="flex flex-col gap-0.5">
          {(Object.entries(LAYOUT_META) as [LayoutTheme, typeof LAYOUT_META[LayoutTheme]][]).map(([key, meta]) => {
            const Icon = ICON_MAP[key];
            const isActive = key === theme;
            return (
              <button
                key={key}
                onClick={() => handleSelect(key)}
                className={`flex items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                <div className={`flex h-8 w-8 items-center justify-center rounded-md shrink-0 ${
                  isActive ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-tight">{meta.label}</p>
                  <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{meta.description}</p>
                </div>
                {isActive && (
                  <div className="ml-auto h-2 w-2 rounded-full bg-primary shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
