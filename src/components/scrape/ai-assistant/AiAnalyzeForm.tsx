'use client';

import { Globe, Check, AlertTriangle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles } from 'lucide-react';
import { SITE_TYPES } from './helpers';

interface AiAnalyzeFormProps {
  url: string;
  onUrlChange: (url: string) => void;
  siteType: string;
  onSiteTypeChange: (type: string) => void;
  onGenerate: () => void;
  generating: boolean;
  error: string | null;
}

export function AiAnalyzeForm({
  url,
  onUrlChange,
  siteType,
  onSiteTypeChange,
  onGenerate,
  generating,
  error,
}: AiAnalyzeFormProps) {
  return (
    <div className="px-6 py-8 space-y-6">
      {/* URL input */}
      <div className="space-y-3">
        <Label className="text-sm font-medium flex items-center gap-1.5">
          <Globe className="h-4 w-4 text-primary" />
          目标网站 URL
          <span className="text-destructive">*</span>
        </Label>
        <div className="relative">
          <Input
            placeholder="https://www.example.com/novel/list"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            className="text-sm pl-4 pr-4 h-11"
            aria-label="目标网站 URL"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onGenerate();
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          请输入小说列表页的完整 URL，AI 将分析该页面并自动生成所有需要的选择器
        </p>
      </div>

      {/* Site type selection */}
      <div className="space-y-3">
        <Label className="text-sm font-medium">网站类型（可选）</Label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {SITE_TYPES.map((type) => (
            <button
              key={type.value}
              role="radio"
              aria-checked={siteType === type.value}
              className={`relative flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 transition-all hover:bg-muted/40 ${
                siteType === type.value
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border'
              }`}
              onClick={() =>
                onSiteTypeChange(siteType === type.value ? '' : type.value)
              }
            >
              <type.icon className="h-6 w-6" />
              <span className="text-sm font-medium">{type.label}</span>
              <span className="text-[10px] text-muted-foreground text-center">
                {type.description}
              </span>
              {siteType === type.value && (
                <div className="absolute top-2 right-2">
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3 w-3" />
                  </div>
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-destructive">{error}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              请检查 URL 是否正确，或稍后重试
            </p>
          </div>
        </div>
      )}

      {/* Generate button */}
      <div className="flex justify-center">
        <Button
          onClick={onGenerate}
          disabled={!url.trim() || generating}
          size="lg"
          className="gap-2 px-8 h-12 text-sm"
        >
          {generating ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Sparkles className="h-5 w-5" />
          )}
          开始 AI 分析
        </Button>
      </div>
    </div>
  );
}
