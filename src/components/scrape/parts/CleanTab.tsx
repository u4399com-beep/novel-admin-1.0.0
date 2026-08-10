'use client';

import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Info, Shield, Eraser, Sparkles } from 'lucide-react';
import type { EditorFormAccess } from './types';

export function CleanTab({ form }: EditorFormAccess) {
  const { setValue, watch } = form;
  const cleanCfg = watch('cleanConfig');

  // Count active rules for display
  const selectorCount = (cleanCfg.removeSelectors || '').split('\n').filter(Boolean).length;
  const patternCount = (cleanCfg.removePatterns || '').split('\n').filter(Boolean).length;
  const adCount = (cleanCfg.adPatterns || '').split('\n').filter(Boolean).length;
  const totalRules = selectorCount + patternCount + adCount;

  return (
    <div className="space-y-5">
      {/* Status Overview */}
      <div className="flex items-center justify-between rounded-lg border bg-gradient-to-r from-emerald-50/50 to-teal-50/50 dark:from-emerald-950/20 dark:to-teal-950/20 px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-medium">内容清洗</span>
        </div>
        <div className="flex items-center gap-1.5">
          {cleanCfg.removeAds !== false && (
            <Badge variant="secondary" className="text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              <Shield className="mr-1 h-3 w-3" />
              广告移除
            </Badge>
          )}
          {totalRules > 0 && (
            <Badge variant="secondary" className="text-xs">
              {totalRules} 条规则
            </Badge>
          )}
        </div>
      </div>

      {/* Toggle switches */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
          <div>
            <Label className="text-sm font-medium">移除广告</Label>
            <p className="text-xs text-muted-foreground">自动移除常见广告元素</p>
          </div>
          <Switch
            checked={cleanCfg.removeAds}
            onCheckedChange={(v) =>
              setValue('cleanConfig', { ...cleanCfg, removeAds: v }, { shouldDirty: true })
            }
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
          <div>
            <Label className="text-sm font-medium">HTML规范化</Label>
            <p className="text-xs text-muted-foreground">清理多余标签和属性</p>
          </div>
          <Switch
            checked={cleanCfg.cleanHtml}
            onCheckedChange={(v) =>
              setValue('cleanConfig', { ...cleanCfg, cleanHtml: v }, { shouldDirty: true })
            }
          />
        </div>
      </div>

      <Separator />

      {/* CSS Selectors for HTML-level removal */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium flex items-center gap-1.5">
            <Eraser className="h-4 w-4 text-orange-500" />
            CSS选择器移除
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-xs">在提取文本前，从HTML中移除匹配的元素。适合移除广告容器、导航栏、评论区等。</p>
            </TooltipContent>
          </Tooltip>
          {selectorCount > 0 && (
            <Badge variant="outline" className="text-xs h-5">{selectorCount}</Badge>
          )}
        </div>
        <Textarea
          placeholder={'.ad-container\n.sidebar\n.comments-area\nnav.navigation\n.recommend-box\n.footer-links'}
          rows={4}
          value={cleanCfg.removeSelectors || ''}
          onChange={(e) =>
            setValue('cleanConfig', { ...cleanCfg, removeSelectors: e.target.value }, { shouldDirty: true })
          }
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          每行一个CSS选择器，匹配的HTML元素将在文本提取前移除
        </p>
      </div>

      {/* Regex patterns (dual: CSS + text) */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium flex items-center gap-1.5">
            正则/混合规则
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-xs">双重用途：先作为CSS选择器尝试移除元素，再作为正则表达式移除匹配文本。</p>
            </TooltipContent>
          </Tooltip>
          {patternCount > 0 && (
            <Badge variant="outline" className="text-xs h-5">{patternCount}</Badge>
          )}
        </div>
        <Textarea
          placeholder={'.gsc-\n.sharedaddy\nins.adsbygoogle\n[class*="advert"]'}
          rows={4}
          value={cleanCfg.removePatterns || ''}
          onChange={(e) =>
            setValue('cleanConfig', { ...cleanCfg, removePatterns: e.target.value }, { shouldDirty: true })
          }
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          每行一条，可作CSS选择器或正则表达式。建议CSS选择器放上方「选择器移除」
        </p>
      </div>

      {/* Ad text patterns */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium flex items-center gap-1.5">
            <Shield className="h-4 w-4 text-red-500" />
            广告文本识别
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              <p className="text-xs">文本级别的广告行检测。匹配到的行在剩余文本少于20字符时整行移除。</p>
            </TooltipContent>
          </Tooltip>
          {adCount > 0 && (
            <Badge variant="outline" className="text-xs h-5">{adCount}</Badge>
          )}
        </div>
        <Textarea
          placeholder={'请记住本书首发域名\n手机用户请浏览\n本章未完，点击下一页继续\n5165.org'}
          rows={4}
          value={cleanCfg.adPatterns || ''}
          onChange={(e) =>
            setValue('cleanConfig', { ...cleanCfg, adPatterns: e.target.value }, { shouldDirty: true })
          }
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          每行一条关键词或正则表达式，匹配到的广告行将被过滤
        </p>
      </div>

      {/* Built-in cleaning info */}
      <div className="rounded-lg border border-dashed bg-muted/20 p-3">
        <p className="text-xs text-muted-foreground leading-relaxed">
          <span className="font-medium text-foreground">内置清洗：</span>
          系统已内置 50+ 条水印/广告正则（网址水印、推广文本、导航残留、版权声明等）
          和 30+ 条CSS广告选择器，即使不配置自定义规则也会自动生效。
        </p>
      </div>
    </div>
  );
}
