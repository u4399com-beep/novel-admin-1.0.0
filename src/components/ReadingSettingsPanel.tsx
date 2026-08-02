'use client';

import { Plus, Type, Palette, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  READING_THEMES,
  FONT_FAMILIES,
  type ReadingSettings,
} from '@/lib/use-reading-settings';

interface ReadingSettingsPanelProps {
  settings: ReadingSettings;
  onUpdate: (partial: Partial<ReadingSettings>) => void;
}

export function ReadingSettingsPanel({ settings, onUpdate }: ReadingSettingsPanelProps) {
  return (
    <div className="flex items-center gap-1">
      {/* Font size controls */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="缩小字号"
            onClick={() => onUpdate({ fontSize: Math.max(12, settings.fontSize - 1) })}
          >
            <Type className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">缩小字号 (当前 {settings.fontSize}px)</TooltipContent>
      </Tooltip>

      <span className="min-w-[3rem] text-center text-xs tabular-nums text-muted-foreground">
        {settings.fontSize}px
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="放大字号"
            onClick={() => onUpdate({ fontSize: Math.min(28, settings.fontSize + 1) })}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">放大字号</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="mx-1 h-4" />

      {/* Reading theme selector */}
      <div className="flex items-center gap-1">
        {READING_THEMES.map((theme) => (
          <Tooltip key={theme.key}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onUpdate({ themeKey: theme.key })}
                aria-label={`阅读主题: ${theme.label}`}
                className={
                  'relative h-5 w-5 rounded-full border-2 transition-all duration-150 hover:scale-110 ' +
                  (settings.themeKey === theme.key
                    ? 'border-primary ring-1 ring-primary/30'
                    : 'border-muted-foreground/30 hover:border-muted-foreground/60')
                }
                style={{ backgroundColor: theme.preview }}
              >
                {settings.themeKey === theme.key && (
                  <Check className={`absolute inset-0 m-auto h-3 w-3 ${
                    theme.key === 'dark' ? 'text-zinc-300' : 'text-zinc-700'
                  }`} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{theme.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <Separator orientation="vertical" className="mx-1 h-4" />

      {/* Font family selector */}
      <div className="flex items-center gap-0.5">
        {FONT_FAMILIES.map((font) => (
          <Tooltip key={font.key}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onUpdate({ fontFamily: font.key })}
                aria-label={`字体: ${font.label}`}
                className={
                  'px-1.5 py-0.5 rounded text-[11px] transition-colors ' +
                  (settings.fontFamily === font.key
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted')
                }
                style={{ fontFamily: font.key === 'serif' ? 'serif' : font.key === 'mono' ? 'monospace' : 'sans-serif' }}
              >
                {font.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{font.label}字体</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
