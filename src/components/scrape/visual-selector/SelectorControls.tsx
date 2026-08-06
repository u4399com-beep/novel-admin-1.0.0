'use client';

import { Loader2, Wand2, Check, X, Crosshair, Globe, Eye, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { AiSuggestion } from './types';

interface SelectorControlsProps {
  url: string;
  loading: boolean;
  aiLoading: boolean;
  aiSuggestions: AiSuggestion[];
  error: string | null;
  selectorValue: string;
  onUrlChange: (url: string) => void;
  onFetchPage: () => void;
  onSmartSuggest: () => void;
  onSelectSuggestion: (selector: string) => void;
  onApply: () => void;
  onClose: () => void;
}

export function SelectorControls({
  url,
  loading,
  aiLoading,
  aiSuggestions,
  error,
  selectorValue,
  onUrlChange,
  onFetchPage,
  onSmartSuggest,
  onSelectSuggestion,
  onApply,
  onClose,
}: SelectorControlsProps) {
  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <Crosshair className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold">可视化选择器构建器</h3>
          <p className="text-xs text-muted-foreground">
            获取页面 HTML，测试选择器，智能推荐
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Separator />

      {/* URL Input */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">目标 URL</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Globe className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="https://example.com/novel/list"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              className="pl-9"
              onKeyDown={(e) => {
                if (e.key === 'Enter') onFetchPage();
              }}
            />
          </div>
          <Button
            onClick={onFetchPage}
            disabled={loading || !url.trim()}
            className="gap-1.5 shrink-0"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            获取页面
          </Button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* AI Smart Suggest Section */}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            variant="outline"
            className="w-full justify-between gap-2"
            disabled={aiLoading}
          >
            <span className="flex items-center gap-2">
              {aiLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4 text-primary" />
              )}
              <span className="text-sm">
                {aiLoading ? '正在分析页面...' : 'AI 智能选择器建议'}
              </span>
            </span>
            {!aiLoading && (
              <Badge variant="secondary" className="text-[10px]">
                点击展开
              </Badge>
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3 space-y-3">
          {aiSuggestions.length === 0 && !aiLoading ? (
            <div className="flex flex-col items-center gap-3 py-6">
              <p className="text-xs text-muted-foreground">
                点击下方按钮，AI 将分析页面结构并推荐选择器
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={onSmartSuggest}
                className="gap-1.5"
              >
                <Wand2 className="h-3.5 w-3.5" />
                开始智能分析
              </Button>
            </div>
          ) : (
            <>
              <AiSuggestions
                suggestions={aiSuggestions}
                onSelect={onSelectSuggestion}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={onSmartSuggest}
                className="gap-1.5 text-xs"
              >
                <Wand2 className="h-3 w-3" />
                重新分析
              </Button>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      <Separator />

      {/* Footer Actions */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          onClick={onApply}
          disabled={!selectorValue.trim()}
          className="gap-1.5"
        >
          <Check className="h-4 w-4" />
          应用选择器
        </Button>
      </div>
    </>
  );
}

function AiSuggestions({ suggestions, onSelect }: {
  suggestions: AiSuggestion[];
  onSelect: (selector: string) => void;
}) {
  if (suggestions.length === 0) return null;

  const typeLabels: Record<string, string> = {
    title: '标题',
    author: '作者',
    description: '描述',
    content: '正文内容',
    links: '链接',
    cover: '封面图片',
    status: '状态',
    chapterList: '章节列表',
    chapterTitle: '章节标题',
    chapterLink: '章节链接',
  };

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Wand2 className="h-3 w-3" />
        AI 建议选择器
      </Label>
      <div className="space-y-1.5">
        {suggestions.map((s, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2"
          >
            <Badge variant="outline" className="shrink-0 text-xs">
              {typeLabels[s.type] || s.type}
            </Badge>
            <code className="flex-1 text-xs font-mono truncate text-foreground/70">
              {s.selector}
            </code>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 shrink-0"
              onClick={() => onSelect(s.selector)}
              title="使用此选择器"
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
