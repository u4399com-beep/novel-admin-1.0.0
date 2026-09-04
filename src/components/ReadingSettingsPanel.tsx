'use client';

import { Plus, Minus, Check, AlignVerticalSpaceAround } from 'lucide-react';
import { cn } from '@/lib/utils';
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
  READER_TEMPLATES,
  type ReadingSettings,
} from '@/lib/use-reading-settings';

interface ReadingSettingsPanelProps {
  settings: ReadingSettings;
  onUpdate: (partial: Partial<ReadingSettings>) => void;
}

export function ReadingSettingsPanel({ settings, onUpdate }: ReadingSettingsPanelProps) {
  return (
    <div className="flex flex-col gap-3 max-h-80 overflow-y-auto scrollbar-thin p-1">
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
            <Minus className="h-3 w-3" />
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

      {/* Line height controls */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="减小行距"
            onClick={() => onUpdate({ lineHeight: Math.max(1.2, +(settings.lineHeight - 0.1).toFixed(1)) })}
          >
            <AlignVerticalSpaceAround className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">减小行距 (当前 {settings.lineHeight})</TooltipContent>
      </Tooltip>

      <span className="min-w-[2.5rem] text-center text-xs tabular-nums text-muted-foreground">
        {settings.lineHeight}
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="增大行距"
            onClick={() => onUpdate({ lineHeight: Math.min(3.0, +(settings.lineHeight + 0.1).toFixed(1)) })}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">增大行距</TooltipContent>
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
                className={cn(
                  'relative h-5 w-5 rounded-full border-2 transition-all duration-200 hover:scale-125 active:scale-95',
                  settings.themeKey === theme.key
                    ? 'border-primary ring-2 ring-primary/40 shadow-sm shadow-primary/20'
                    : 'border-muted-foreground/30 hover:border-muted-foreground/60 hover:shadow-sm'
                )}
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
                className={cn(
                  'px-1.5 py-0.5 rounded text-[11px] transition-colors',
                  settings.fontFamily === font.key
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
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
      {/* Reader template selector */}
      <div className="flex items-center gap-1 mt-2">
        <span className="text-[11px] text-muted-foreground mr-1 shrink-0">阅读模版</span>
        {READER_TEMPLATES.map((template) => (
          <Tooltip key={template.key}>
            <TooltipTrigger asChild>
              <button
                onClick={() => onUpdate({ readerTemplate: template.key })}
                aria-label={`阅读模版: ${template.label}`}
                className={cn(
                  'px-2 py-0.5 rounded-md text-[11px] transition-all duration-200',
                  settings.readerTemplate === template.key
                    ? 'bg-primary text-primary-foreground font-medium shadow-sm shadow-primary/20'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/80 active:scale-95'
                )}
              >
                {template.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{template.description}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-border/30 bg-muted/20 -mx-1 px-3 py-2 rounded-md">
        <p className="text-[10px] text-muted-foreground/50 mb-1.5">快捷键</p>
        <div className="grid grid-cols-2 gap-1 text-[10px] text-muted-foreground/60">
          <span><kbd className="px-1 py-0.5 rounded bg-muted/80 text-[9px] font-mono border border-border/50">↑↓</kbd> 翻页</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted/80 text-[9px] font-mono border border-border/50">B</kbd> 书签</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted/80 text-[9px] font-mono border border-border/50">F</kbd> 全屏</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted/80 text-[9px] font-mono border border-border/50">Esc</kbd> 关闭</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted/80 text-[9px] font-mono border border-border/50">S</kbd> 目录</span>
          <span><kbd className="px-1 py-0.5 rounded bg-muted/80 text-[9px] font-mono border border-border/50">Ctrl+F</kbd> 搜索</span>
        </div>
      </div>
    </div>
  );
}
