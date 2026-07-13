'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sparkles, Crosshair, Cloud, Brain } from 'lucide-react';
import type { FormValues } from './schema';
import type { EditorFormAccess } from './types';

interface StrategyTabProps extends EditorFormAccess {
  onOpenAiAssistant: () => void;
  onOpenVisualSelector: (fieldName: string, currentUrl?: string) => void;
}

export function StrategyTab({ form, onOpenAiAssistant, onOpenVisualSelector }: StrategyTabProps) {
  const { register, setValue, watch } = form;
  const currentEngine = watch('engine');
  const threadCount = watch('threadCount');

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">采集引擎</Label>
        <Select
          value={watch('engine')}
          onValueChange={(v) => {
            setValue('engine', v as FormValues['engine'], { shouldDirty: true });
            // Auto-set useJsRender when playwright/cloud-browser selected
            if (v === 'playwright' || v === 'cloud-browser') {
              setValue('antiCrawlConfig.useJsRender', true, { shouldDirty: true });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-[280px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cheerio">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-green-500" />
                <div>
                  <span className="font-medium">Cheerio</span>
                  <span className="ml-1 text-xs text-muted-foreground">快速HTTP采集</span>
                </div>
              </div>
            </SelectItem>
            <SelectItem value="playwright">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-blue-500" />
                <div>
                  <span className="font-medium">Playwright</span>
                  <span className="ml-1 text-xs text-muted-foreground">JS渲染引擎</span>
                </div>
              </div>
            </SelectItem>
            <SelectItem value="firecrawl">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-orange-500" />
                <div>
                  <span className="font-medium">Firecrawl</span>
                  <span className="ml-1 text-xs text-muted-foreground">AI增强采集</span>
                </div>
              </div>
            </SelectItem>
            <SelectItem value="agentql">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-purple-500" />
                <div>
                  <span className="font-medium">AgentQL</span>
                  <span className="ml-1 text-xs text-muted-foreground">自然语言提取</span>
                </div>
              </div>
            </SelectItem>
            <SelectItem value="cloud-browser">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-cyan-500" />
                <div>
                  <span className="font-medium">云端浏览器</span>
                  <span className="ml-1 text-xs text-muted-foreground">Browserless/Steel</span>
                </div>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Cheerio: 最快 | Playwright: JS渲染 | Firecrawl: AI增强 | AgentQL: 自然语言 | 云端浏览器: 反检测
        </p>
      </div>

      {/* AgentQL Config - shown when agentql engine selected */}
      {currentEngine === 'agentql' && (
        <>
          <Separator />
          <Card className="border-purple-200 bg-purple-50/50 dark:border-purple-800 dark:bg-purple-950/20">
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Brain className="h-4 w-4 text-purple-600" />
                AgentQL 自然语言查询
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <p className="text-xs text-muted-foreground mb-3">
                使用自然语言描述要提取的数据，无需编写CSS选择器
              </p>
              <Textarea
                placeholder={'{\n  "title": "小说的标题",\n  "author": "作者名字",\n  "description": "小说简介描述",\n  "chapters": "章节目录列表，包含标题和链接",\n  "content": "章节正文内容"\n}'}
                rows={10}
                value={watch('agentqlQueries')}
                onChange={(e) => setValue('agentqlQueries', e.target.value, { shouldDirty: true })}
                className="font-mono text-sm"
              />
            </CardContent>
          </Card>
        </>
      )}

      {/* Cloud Browser Config - shown when cloud-browser engine selected */}
      {currentEngine === 'cloud-browser' && (
        <>
          <Separator />
          <Card className="border-cyan-200 bg-cyan-50/50 dark:border-cyan-800 dark:bg-cyan-950/20">
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Cloud className="h-4 w-4 text-cyan-600" />
                云端浏览器配置 (Browserless / Steel)
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0 space-y-3">
              <p className="text-xs text-muted-foreground">
                适用于Cloudflare等高防护站点，通过云端无头浏览器绕过反爬检测
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">服务提供商</Label>
                  <Select
                    value={watch('cloudBrowserProvider')}
                    onValueChange={(v) => setValue('cloudBrowserProvider', v as 'browserless' | 'steel', { shouldDirty: true })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="browserless">Browserless</SelectItem>
                      <SelectItem value="steel">Steel</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">API地址</Label>
                  <Input
                    placeholder="https://chrome.browserless.io"
                    value={watch('cloudBrowserUrl')}
                    onChange={(e) => setValue('cloudBrowserUrl', e.target.value, { shouldDirty: true })}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Badge variant="outline" className="text-xs">自动处理JS Challenge</Badge>
                <Badge variant="outline" className="text-xs">支持Cloudflare</Badge>
                <Badge variant="outline" className="text-xs">支持验证码绕过</Badge>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* AI Assist Buttons */}
      <Separator />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          className="h-auto py-3 gap-2 border-dashed"
          onClick={() => onOpenAiAssistant()}
        >
          <Sparkles className="h-4 w-4 text-purple-600" />
          <div className="text-left">
            <p className="text-sm font-medium">AI 智能生成规则</p>
            <p className="text-[11px] text-muted-foreground">输入URL，AI自动分析页面结构生成采集规则</p>
          </div>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-auto py-3 gap-2 border-dashed"
          onClick={() => onOpenVisualSelector('bookTitleSelector', watch('listUrl'))}
        >
          <Crosshair className="h-4 w-4 text-emerald-600" />
          <div className="text-left">
            <p className="text-sm font-medium">可视化选择器</p>
            <p className="text-[11px] text-muted-foreground">预览页面，点击元素自动生成选择器</p>
          </div>
        </Button>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">采集模式</Label>
        <Select
          value={watch('scrapeMode')}
          onValueChange={(v) => setValue('scrapeMode', v as 'incremental' | 'full', { shouldDirty: true })}
        >
          <SelectTrigger className="w-full sm:w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="incremental">增量更新</SelectItem>
            <SelectItem value="full">完全覆盖</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          增量模式仅采集新增内容，完全覆盖会重新采集所有内容
        </p>
      </div>

      <Separator />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">并发线程数</Label>
          <span className="text-sm font-mono text-primary">{threadCount}</span>
        </div>
        <Slider
          value={[threadCount]}
          onValueChange={([v]) => setValue('threadCount', v, { shouldDirty: true })}
          min={1}
          max={10}
          step={1}
        />
        <p className="text-xs text-muted-foreground">
          过高的并发可能导致被目标网站封禁，建议1-5
        </p>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">请求间隔</Label>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">最小间隔</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                {...register('minDelay', { valueAsNumber: true })}
              />
              <span className="text-sm text-muted-foreground shrink-0">ms</span>
            </div>
          </div>
          <span className="mt-5 text-muted-foreground">-</span>
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">最大间隔</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                {...register('maxDelay', { valueAsNumber: true })}
              />
              <span className="text-sm text-muted-foreground shrink-0">ms</span>
            </div>
          </div>
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">目录乱序</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-muted-foreground">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-circle-help"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
              </span>
            </TooltipTrigger>
            <TooltipContent>随机打乱章节目录采集顺序</TooltipContent>
          </Tooltip>
        </div>
        <Switch
          checked={watch('enableShuffle')}
          onCheckedChange={(v) => setValue('enableShuffle', v, { shouldDirty: true })}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">去重模式</Label>
        <Select
          value={watch('dedupMode')}
          onValueChange={(v) => setValue('dedupMode', v as 'url' | 'title' | 'both', { shouldDirty: true })}
        >
          <SelectTrigger className="w-full sm:w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="url">URL去重</SelectItem>
            <SelectItem value="title">章节名去重</SelectItem>
            <SelectItem value="both">两者都用</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}