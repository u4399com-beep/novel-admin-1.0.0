'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod/v4';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';

// ==================== Types ====================

interface SelectorRule {
  type: 'css' | 'xpath' | 'regex';
  value: string;
}

interface PaginationConfig {
  type: 'next' | 'page';
  selector: string;
  maxPage: number;
}

interface AntiCrawlConfig {
  useJsRender: boolean;
  uaRotation: boolean;
  cookies: string;
  minDelay: number;
  maxDelay: number;
}

interface CleanConfig {
  removeAds: boolean;
  cleanHtml: boolean;
  removePatterns: string;
  adPatterns: string;
}

export interface ScrapeRuleFormData {
  // Basic
  name: string;
  description: string;
  enabled: boolean;

  // List page
  listUrl: string;
  listSelector: SelectorRule;
  listPagination: PaginationConfig;

  // Book info
  bookTitleSelector: SelectorRule;
  bookAuthorSelector: SelectorRule;
  bookCategorySelector: SelectorRule;
  bookKeywordsSelector: SelectorRule;
  bookDescriptionSelector: SelectorRule;
  bookCoverSelector: SelectorRule;
  bookStatusSelector: SelectorRule;

  // Chapter directory
  chapterListUrl: string;
  chapterListSelector: SelectorRule;
  chapterTitleSelector: SelectorRule;
  chapterLinkSelector: SelectorRule;
  chapterPagination: PaginationConfig;

  // Chapter content
  contentTitleSelector: SelectorRule;
  contentSelector: SelectorRule;
  contentPagination: PaginationConfig;

  // Anti-crawl
  antiCrawlConfig: AntiCrawlConfig;

  // Storage
  storageMode: 'database' | 'file';
  filePath: string;
  coverSavePath: string;

  // Scrape strategy
  scrapeMode: 'incremental' | 'full';
  engine: 'cheerio' | 'playwright' | 'firecrawl';
  threadCount: number;
  minDelay: number;
  maxDelay: number;
  enableShuffle: boolean;
  dedupMode: 'url' | 'title' | 'both';

  // Content cleaning
  cleanConfig: CleanConfig;
}

// ==================== Schema ====================

const selectorSchema = z.object({
  type: z.enum(['css', 'xpath', 'regex']),
  value: z.string(),
});

const paginationSchema = z.object({
  type: z.enum(['next', 'page']),
  selector: z.string(),
  maxPage: z.number().int().min(1).max(9999),
});

const defaultSelector: SelectorRule = { type: 'css', value: '' };
const defaultPagination: PaginationConfig = { type: 'next', selector: '', maxPage: 100 };

export const scrapeRuleSchema = z.object({
  name: z.string().min(1, '规则名称不能为空').max(200),
  description: z.string(),
  enabled: z.boolean(),

  listUrl: z.string(),
  listSelector: selectorSchema,
  listPagination: paginationSchema,

  bookTitleSelector: selectorSchema,
  bookAuthorSelector: selectorSchema,
  bookCategorySelector: selectorSchema,
  bookKeywordsSelector: selectorSchema,
  bookDescriptionSelector: selectorSchema,
  bookCoverSelector: selectorSchema,
  bookStatusSelector: selectorSchema,

  chapterListUrl: z.string(),
  chapterListSelector: selectorSchema,
  chapterTitleSelector: selectorSchema,
  chapterLinkSelector: selectorSchema,
  chapterPagination: paginationSchema,

  contentTitleSelector: selectorSchema,
  contentSelector: selectorSchema,
  contentPagination: paginationSchema,

  antiCrawlConfig: z.object({
    useJsRender: z.boolean(),
    uaRotation: z.boolean(),
    cookies: z.string(),
    minDelay: z.number().int().min(0),
    maxDelay: z.number().int().min(0),
  }),

  storageMode: z.enum(['database', 'file']),
  filePath: z.string(),
  coverSavePath: z.string(),

  scrapeMode: z.enum(['incremental', 'full']),
  engine: z.enum(['cheerio', 'playwright', 'firecrawl']),
  threadCount: z.number().int().min(1).max(10),
  minDelay: z.number().int().min(0),
  maxDelay: z.number().int().min(0),
  enableShuffle: z.boolean(),
  dedupMode: z.enum(['url', 'title', 'both']),

  cleanConfig: z.object({
    removeAds: z.boolean(),
    cleanHtml: z.boolean(),
    removePatterns: z.string(),
    adPatterns: z.string(),
  }),
});

type FormValues = z.infer<typeof scrapeRuleSchema>;

// ==================== Sub-components ====================

interface SelectorFieldProps {
  label: string;
  required?: boolean;
  value: SelectorRule;
  onChange: (val: SelectorRule) => void;
  errors?: { type?: { message?: string }; value?: { message?: string } };
}

function SelectorField({ label, required, value, onChange, errors }: SelectorFieldProps) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      <div className="flex gap-2">
        <Select
          value={value.type}
          onValueChange={(t) => onChange({ ...value, type: t as 'css' | 'xpath' | 'regex' })}
        >
          <SelectTrigger className="w-[120px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="css">CSS选择器</SelectItem>
            <SelectItem value="xpath">XPath</SelectItem>
            <SelectItem value="regex">正则表达式</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="flex-1"
          placeholder={value.type === 'css' ? '.class-name' : value.type === 'xpath' ? '//div[@class="x"]' : '正则表达式'}
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
      </div>
      {errors?.type?.message && (
        <p className="text-xs text-destructive">{errors.type.message}</p>
      )}
      {errors?.value?.message && (
        <p className="text-xs text-destructive">{errors.value.message}</p>
      )}
    </div>
  );
}

interface PaginationFieldProps {
  label?: string;
  value: PaginationConfig;
  onChange: (val: PaginationConfig) => void;
  errors?: {
    type?: { message?: string };
    selector?: { message?: string };
    maxPage?: { message?: string };
  };
}

function PaginationField({ label = '分页配置', value, onChange, errors }: PaginationFieldProps) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <p className="text-sm font-medium">{label}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">分页类型</Label>
          <Select
            value={value.type}
            onValueChange={(t) => onChange({ ...value, type: t as 'next' | 'page' })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="next">下一页按钮</SelectItem>
              <SelectItem value="page">页码URL模板</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-1">
          <Label className="text-xs text-muted-foreground">
            {value.type === 'next' ? '下一页选择器' : 'URL模板'}
          </Label>
          <Input
            placeholder={value.type === 'next' ? 'a.next-page' : 'https://.../list/{page}'}
            value={value.selector}
            onChange={(e) => onChange({ ...value, selector: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">最大页数</Label>
          <Input
            type="number"
            min={1}
            max={9999}
            value={value.maxPage}
            onChange={(e) => onChange({ ...value, maxPage: parseInt(e.target.value) || 1 })}
          />
        </div>
      </div>
      {errors?.type?.message && <p className="text-xs text-destructive">{errors.type.message}</p>}
      {errors?.selector?.message && <p className="text-xs text-destructive">{errors.selector.message}</p>}
      {errors?.maxPage?.message && <p className="text-xs text-destructive">{errors.maxPage.message}</p>}
    </div>
  );
}

// ==================== Main Editor ====================

interface ScrapeRuleEditorProps {
  ruleId: string | null;
  onSuccess: () => void;
  onCancel: () => void;
}

export function ScrapeRuleEditor({ ruleId, onSuccess, onCancel }: ScrapeRuleEditorProps) {
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(scrapeRuleSchema),
    defaultValues: {
      name: '',
      description: '',
      enabled: true,

      listUrl: '',
      listSelector: { ...defaultSelector },
      listPagination: { ...defaultPagination },

      bookTitleSelector: { ...defaultSelector },
      bookAuthorSelector: { ...defaultSelector },
      bookCategorySelector: { ...defaultSelector },
      bookKeywordsSelector: { ...defaultSelector },
      bookDescriptionSelector: { ...defaultSelector },
      bookCoverSelector: { ...defaultSelector },
      bookStatusSelector: { ...defaultSelector },

      chapterListUrl: '',
      chapterListSelector: { ...defaultSelector },
      chapterTitleSelector: { ...defaultSelector },
      chapterLinkSelector: { ...defaultSelector },
      chapterPagination: { ...defaultPagination },

      contentTitleSelector: { ...defaultSelector },
      contentSelector: { ...defaultSelector },
      contentPagination: { ...defaultPagination },

      antiCrawlConfig: {
        useJsRender: false,
        uaRotation: false,
        cookies: '',
        minDelay: 500,
        maxDelay: 2000,
      },

      storageMode: 'database',
      filePath: './data/novels',
      coverSavePath: './data/covers',

      scrapeMode: 'incremental',
      engine: 'cheerio',
      threadCount: 3,
      minDelay: 1000,
      maxDelay: 3000,
      enableShuffle: false,
      dedupMode: 'url',

      cleanConfig: {
        removeAds: true,
        cleanHtml: true,
        removePatterns: '',
        adPatterns: '',
      },
    },
  });

  const enabled = watch('enabled');
  const storageMode = watch('storageMode');
  const threadCount = watch('threadCount');
  const antiCrawl = watch('antiCrawlConfig');
  const cleanCfg = watch('cleanConfig');

  // Load existing rule
  useEffect(() => {
    if (!ruleId) {
      reset();
      return;
    }

    async function loadRule() {
      try {
        const res = await fetch(`/api/scrape-rules/${ruleId}`);
        if (!res.ok) throw new Error('Failed to load');
        const rule = await res.json();

        const parseJSON = (str: string | null, fallback: unknown) => {
          if (!str) return fallback;
          try { return JSON.parse(str); } catch { return fallback; }
        };

        reset({
          name: rule.name || '',
          description: rule.description || '',
          enabled: rule.enabled ?? true,

          listUrl: rule.listUrl || '',
          listSelector: parseJSON(rule.listSelector, defaultSelector),
          listPagination: parseJSON(rule.listPagination, defaultPagination),

          bookTitleSelector: parseJSON(rule.bookTitleSelector, defaultSelector),
          bookAuthorSelector: parseJSON(rule.bookAuthorSelector, defaultSelector),
          bookCategorySelector: parseJSON(rule.bookCategorySelector, defaultSelector),
          bookKeywordsSelector: parseJSON(rule.bookKeywordsSelector, defaultSelector),
          bookDescriptionSelector: parseJSON(rule.bookDescriptionSelector, defaultSelector),
          bookCoverSelector: parseJSON(rule.bookCoverSelector, defaultSelector),
          bookStatusSelector: parseJSON(rule.bookStatusSelector, defaultSelector),

          chapterListUrl: rule.chapterListUrl || '',
          chapterListSelector: parseJSON(rule.chapterListSelector, defaultSelector),
          chapterTitleSelector: parseJSON(rule.chapterTitleSelector, defaultSelector),
          chapterLinkSelector: parseJSON(rule.chapterLinkSelector, defaultSelector),
          chapterPagination: parseJSON(rule.chapterPagination, defaultPagination),

          contentTitleSelector: parseJSON(rule.contentTitleSelector, defaultSelector),
          contentSelector: parseJSON(rule.contentSelector, defaultSelector),
          contentPagination: parseJSON(rule.contentPagination, defaultPagination),

          antiCrawlConfig: parseJSON(rule.antiCrawlConfig, {
            useJsRender: false,
            uaRotation: false,
            cookies: '',
            minDelay: 500,
            maxDelay: 2000,
          }),

          storageMode: rule.storageMode || 'database',
          filePath: rule.filePath || './data/novels',
          coverSavePath: rule.coverSavePath || './data/covers',

          scrapeMode: rule.scrapeMode || 'incremental',
          engine: (rule.engine as 'cheerio' | 'playwright' | 'firecrawl') || 'cheerio',
          threadCount: rule.threadCount || 3,
          minDelay: rule.minDelay ?? 1000,
          maxDelay: rule.maxDelay ?? 3000,
          enableShuffle: rule.enableShuffle ?? false,
          dedupMode: rule.dedupMode || 'url',

          cleanConfig: parseJSON(rule.cleanConfig, {
            removeAds: true,
            cleanHtml: true,
            removePatterns: '',
            adPatterns: '',
          }),
        });
      } catch {
        toast.error('加载规则失败');
      }
    }

    loadRule();
  }, [ruleId, reset]);

  const setSelector = useCallback(
    (field: keyof FormValues, val: SelectorRule) => {
      setValue(field, val as never, { shouldDirty: true });
    },
    [setValue]
  );

  const setPagination = useCallback(
    (field: keyof FormValues, val: PaginationConfig) => {
      setValue(field, val as never, { shouldDirty: true });
    },
    [setValue]
  );

  const onSubmit = async (data: FormValues) => {
    try {
      const payload = {
        ...data,
      };

      const url = ruleId ? `/api/scrape-rules/${ruleId}` : '/api/scrape-rules';
      const method = ruleId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '操作失败');
      }

      toast.success(ruleId ? '规则已更新' : '规则已创建');
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <Tabs defaultValue="basic" className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="basic" className="text-xs">基本信息</TabsTrigger>
          <TabsTrigger value="list" className="text-xs">列表页规则</TabsTrigger>
          <TabsTrigger value="book" className="text-xs">书籍信息规则</TabsTrigger>
          <TabsTrigger value="chapter-dir" className="text-xs">章节目录规则</TabsTrigger>
          <TabsTrigger value="chapter-content" className="text-xs">章节内容规则</TabsTrigger>
          <TabsTrigger value="anti-crawl" className="text-xs">反爬策略</TabsTrigger>
          <TabsTrigger value="storage" className="text-xs">存储策略</TabsTrigger>
          <TabsTrigger value="strategy" className="text-xs">采集策略</TabsTrigger>
          <TabsTrigger value="clean" className="text-xs">内容清洗</TabsTrigger>
        </TabsList>

        {/* Tab 1: Basic Info */}
        <TabsContent value="basic">
          <div className="space-y-4 rounded-lg border p-4">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm font-medium">
                规则名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                placeholder="如：笔趣阁采集规则"
                {...register('name')}
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="description" className="text-sm font-medium">描述</Label>
              <Textarea
                id="description"
                placeholder="简要描述该规则适用范围..."
                rows={3}
                {...register('description')}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
              <div>
                <Label className="text-sm font-medium">启用状态</Label>
                <p className="text-xs text-muted-foreground">关闭后该规则不会被执行</p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={(v) => setValue('enabled', v, { shouldDirty: true })}
              />
            </div>
          </div>
        </TabsContent>

        {/* Tab 2: List Page Rules */}
        <TabsContent value="list">
          <div className="space-y-4 rounded-lg border p-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">列表页URL模板</Label>
              <Input
                placeholder="https://example.com/list/{page}"
                {...register('listUrl')}
              />
              <p className="text-xs text-muted-foreground">
                使用 {'{page}'} 作为页码占位符
              </p>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label className="text-sm font-medium">采集方式</Label>
              <p className="text-xs text-muted-foreground">选择提取书籍链接的选择器类型和表达式</p>
              <SelectorField
                label="书籍链接选择器"
                value={watch('listSelector')}
                onChange={(v) => setSelector('listSelector', v)}
                errors={errors.listSelector as SelectorFieldProps['errors']}
              />
            </div>

            <Separator />

            <PaginationField
              value={watch('listPagination')}
              onChange={(v) => setPagination('listPagination', v)}
              errors={errors.listPagination as PaginationFieldProps['errors']}
            />
          </div>
        </TabsContent>

        {/* Tab 3: Book Info Rules */}
        <TabsContent value="book">
          <div className="space-y-4 rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              配置从书籍详情页提取各字段信息的规则
            </p>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <SelectorField
                label="书名"
                required
                value={watch('bookTitleSelector')}
                onChange={(v) => setSelector('bookTitleSelector', v)}
                errors={errors.bookTitleSelector as SelectorFieldProps['errors']}
              />
              <SelectorField
                label="作者"
                value={watch('bookAuthorSelector')}
                onChange={(v) => setSelector('bookAuthorSelector', v)}
                errors={errors.bookAuthorSelector as SelectorFieldProps['errors']}
              />
              <SelectorField
                label="分类"
                value={watch('bookCategorySelector')}
                onChange={(v) => setSelector('bookCategorySelector', v)}
                errors={errors.bookCategorySelector as SelectorFieldProps['errors']}
              />
              <SelectorField
                label="关键词"
                value={watch('bookKeywordsSelector')}
                onChange={(v) => setSelector('bookKeywordsSelector', v)}
                errors={errors.bookKeywordsSelector as SelectorFieldProps['errors']}
              />
              <SelectorField
                label="简介"
                value={watch('bookDescriptionSelector')}
                onChange={(v) => setSelector('bookDescriptionSelector', v)}
                errors={errors.bookDescriptionSelector as SelectorFieldProps['errors']}
              />
              <SelectorField
                label="封面图"
                value={watch('bookCoverSelector')}
                onChange={(v) => setSelector('bookCoverSelector', v)}
                errors={errors.bookCoverSelector as SelectorFieldProps['errors']}
              />
            </div>

            <SelectorField
              label="状态"
              value={watch('bookStatusSelector')}
              onChange={(v) => setSelector('bookStatusSelector', v)}
              errors={errors.bookStatusSelector as SelectorFieldProps['errors']}
            />
          </div>
        </TabsContent>

        {/* Tab 4: Chapter Directory Rules */}
        <TabsContent value="chapter-dir">
          <div className="space-y-4 rounded-lg border p-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">目录页URL</Label>
              <Input
                placeholder="https://example.com/book/{bookUrl}"
                {...register('chapterListUrl')}
              />
              <p className="text-xs text-muted-foreground">
                使用 {'{bookUrl}'} 作为书籍详情页URL占位符
              </p>
            </div>

            <Separator />

            <div className="space-y-4">
              <SelectorField
                label="目录列表选择器"
                value={watch('chapterListSelector')}
                onChange={(v) => setSelector('chapterListSelector', v)}
                errors={errors.chapterListSelector as SelectorFieldProps['errors']}
              />
              <SelectorField
                label="章节标题选择器"
                value={watch('chapterTitleSelector')}
                onChange={(v) => setSelector('chapterTitleSelector', v)}
                errors={errors.chapterTitleSelector as SelectorFieldProps['errors']}
              />
              <SelectorField
                label="章节链接选择器"
                value={watch('chapterLinkSelector')}
                onChange={(v) => setSelector('chapterLinkSelector', v)}
                errors={errors.chapterLinkSelector as SelectorFieldProps['errors']}
              />
            </div>

            <Separator />

            <PaginationField
              label="目录分页配置"
              value={watch('chapterPagination')}
              onChange={(v) => setPagination('chapterPagination', v)}
              errors={errors.chapterPagination as PaginationFieldProps['errors']}
            />
          </div>
        </TabsContent>

        {/* Tab 5: Chapter Content Rules */}
        <TabsContent value="chapter-content">
          <div className="space-y-4 rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              配置从章节内容页提取正文内容的规则
            </p>

            <SelectorField
              label="内容页标题选择器（可选）"
              value={watch('contentTitleSelector')}
              onChange={(v) => setSelector('contentTitleSelector', v)}
              errors={errors.contentTitleSelector as SelectorFieldProps['errors']}
            />
            <p className="text-xs text-muted-foreground -mt-2">不填则使用目录页提取的标题</p>

            <SelectorField
              label="正文选择器"
              required
              value={watch('contentSelector')}
              onChange={(v) => setSelector('contentSelector', v)}
              errors={errors.contentSelector as SelectorFieldProps['errors']}
            />

            <Separator />

            <PaginationField
              label="内容分页配置（长内容跨页拆分）"
              value={watch('contentPagination')}
              onChange={(v) => setPagination('contentPagination', v)}
              errors={errors.contentPagination as PaginationFieldProps['errors']}
            />
          </div>
        </TabsContent>

        {/* Tab 6: Anti-Crawl */}
        <TabsContent value="anti-crawl">
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
              <div>
                <Label className="text-sm font-medium">启用JS渲染</Label>
                <p className="text-xs text-muted-foreground">使用无头浏览器渲染页面（速度较慢）</p>
              </div>
              <Switch
                checked={antiCrawl.useJsRender}
                onCheckedChange={(v) =>
                  setValue('antiCrawlConfig', { ...antiCrawl, useJsRender: v }, { shouldDirty: true })
                }
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
              <div>
                <Label className="text-sm font-medium">UA轮换</Label>
                <p className="text-xs text-muted-foreground">每次请求使用不同的User-Agent</p>
              </div>
              <Switch
                checked={antiCrawl.uaRotation}
                onCheckedChange={(v) =>
                  setValue('antiCrawlConfig', { ...antiCrawl, uaRotation: v }, { shouldDirty: true })
                }
              />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">自定义Cookies</Label>
              <Textarea
                placeholder={'key1=value1\nkey2=value2'}
                rows={4}
                value={antiCrawl.cookies}
                onChange={(e) =>
                  setValue('antiCrawlConfig', { ...antiCrawl, cookies: e.target.value }, { shouldDirty: true })
                }
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">每行一个Cookie，格式：key=value</p>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label className="text-sm font-medium">请求延迟范围</Label>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground">最小延迟</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      value={antiCrawl.minDelay}
                      onChange={(e) =>
                        setValue(
                          'antiCrawlConfig',
                          { ...antiCrawl, minDelay: parseInt(e.target.value) || 0 },
                          { shouldDirty: true }
                        )
                      }
                    />
                    <span className="text-sm text-muted-foreground shrink-0">ms</span>
                  </div>
                </div>
                <span className="mt-5 text-muted-foreground">-</span>
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground">最大延迟</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      value={antiCrawl.maxDelay}
                      onChange={(e) =>
                        setValue(
                          'antiCrawlConfig',
                          { ...antiCrawl, maxDelay: parseInt(e.target.value) || 0 },
                          { shouldDirty: true })
                      }
                    />
                    <span className="text-sm text-muted-foreground shrink-0">ms</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* Tab 7: Storage */}
        <TabsContent value="storage">
          <div className="space-y-4 rounded-lg border p-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">存储模式</Label>
              <Select
                value={storageMode}
                onValueChange={(v) => setValue('storageMode', v as 'database' | 'file', { shouldDirty: true })}
              >
                <SelectTrigger className="w-full sm:w-[240px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="database">数据库存储</SelectItem>
                  <SelectItem value="file">文件存储</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                数据库存储适合小中型站点，文件存储适合大规模采集
              </p>
            </div>

            {storageMode === 'file' && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">文件存储路径</Label>
                <Input
                  placeholder="./data/novels"
                  {...register('filePath')}
                />
                <p className="text-xs text-muted-foreground">小说内容文件保存目录</p>
              </div>
            )}

            <Separator />

            <div className="space-y-2">
              <Label className="text-sm font-medium">封面保存路径</Label>
              <Input
                placeholder="./data/covers"
                {...register('coverSavePath')}
              />
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">封面格式: WebP</Badge>
                <span className="text-xs text-muted-foreground">封面图将自动转换为WebP格式保存</span>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* Tab 8: Scraping Strategy */}
        <TabsContent value="strategy">
          <div className="space-y-4 rounded-lg border p-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">采集引擎</Label>
              <Select
                value={watch('engine')}
                onValueChange={(v) => {
                  setValue('engine', v as 'cheerio' | 'playwright' | 'firecrawl', { shouldDirty: true });
                  // Auto-set useJsRender when playwright selected
                  if (v === 'playwright') {
                    setValue('antiCrawlConfig.useJsRender', true, { shouldDirty: true });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-[240px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cheerio">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-green-500" />
                      Cheerio (快速HTTP)
                    </div>
                  </SelectItem>
                  <SelectItem value="playwright">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-blue-500" />
                      Playwright (JS渲染)
                    </div>
                  </SelectItem>
                  <SelectItem value="firecrawl">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-orange-500" />
                      Firecrawl (AI增强)
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Cheerio: 最快，适合静态页面 | Playwright: 支持JS渲染 | Firecrawl: 自动清洗+JS渲染(需部署)
              </p>
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
        </TabsContent>

        {/* Tab 9: Content Cleaning */}
        <TabsContent value="clean">
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
              <div>
                <Label className="text-sm font-medium">移除广告</Label>
                <p className="text-xs text-muted-foreground">自动移除常见广告内容</p>
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
                <Label className="text-sm font-medium">HTML标签规范化</Label>
                <p className="text-xs text-muted-foreground">清理多余的HTML标签和属性</p>
              </div>
              <Switch
                checked={cleanCfg.cleanHtml}
                onCheckedChange={(v) =>
                  setValue('cleanConfig', { ...cleanCfg, cleanHtml: v }, { shouldDirty: true })
                }
              />
            </div>

            <Separator />

            <div className="space-y-2">
              <Label className="text-sm font-medium">自定义移除规则</Label>
              <Textarea
                placeholder={'<div class="ad-.*?">.*?</div>\n<script>.*?</script>'}
                rows={5}
                value={cleanCfg.removePatterns}
                onChange={(e) =>
                  setValue('cleanConfig', { ...cleanCfg, removePatterns: e.target.value }, { shouldDirty: true })
                }
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">每行一条正则表达式，匹配到的内容将被移除</p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">广告匹配规则</Label>
              <Textarea
                placeholder={'推荐.*?小说\n最新章节.*?请访问'}
                rows={5}
                value={cleanCfg.adPatterns}
                onChange={(e) =>
                  setValue('cleanConfig', { ...cleanCfg, adPatterns: e.target.value }, { shouldDirty: true })
                }
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">每行一条正则表达式，用于识别广告内容</p>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Form Actions */}
      <div className="flex items-center justify-end gap-3 border-t pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {ruleId ? '保存修改' : '创建规则'}
        </Button>
      </div>
    </form>
  );
}

// ==================== Rule List ====================

export interface ScrapeRuleItem {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  storageMode: string;
  scrapeMode: string;
  createdAt: string;
  updatedAt: string;
  _count: { tasks: number };
}

interface ScrapeRuleListProps {
  onEdit: (rule: ScrapeRuleItem) => void;
  onCreate: () => void;
}

export function ScrapeRuleList({ onEdit, onCreate }: ScrapeRuleListProps) {
  const [rules, setRules] = useState<ScrapeRuleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '20',
        ...(search ? { search } : {}),
      });
      const res = await fetch(`/api/scrape-rules?${params}`);
      const data = await res.json();
      setRules(data.rules || []);
      setTotalPages(data.totalPages || 1);
    } catch {
      toast.error('获取规则列表失败');
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这条采集规则吗？相关任务也会被删除。')) return;
    try {
      const res = await fetch(`/api/scrape-rules/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('规则已删除');
      fetchRules();
    } catch {
      toast.error('删除失败');
    }
  };

  const handleExecute = async (rule: ScrapeRuleItem) => {
    try {
      const res = await fetch('/api/scrape-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleId: rule.id, mode: rule.scrapeMode || 'incremental' }),
      });
      if (!res.ok) throw new Error();
      const task = await res.json();
      toast.success(`任务已创建: ${task.id.slice(0, 8)}...`);
    } catch {
      toast.error('创建任务失败，请确认采集任务API可用');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">采集规则管理</h2>
          <p className="text-sm text-muted-foreground">配置和管理小说采集规则</p>
        </div>
        <Button onClick={onCreate}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2 lucide lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          新建规则
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 sm:max-w-sm">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground lucide lucide-search"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <Input
            placeholder="搜索规则名称..."
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
              <tr className="border-b text-left">
                <th className="px-4 py-3 font-medium">规则名称</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">状态</th>
                <th className="hidden px-4 py-3 font-medium lg:table-cell">模式</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">任务数</th>
                <th className="hidden px-4 py-3 font-medium lg:table-cell">创建时间</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-5 w-12 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-8 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="ml-auto h-4 w-20 animate-pulse rounded bg-muted" />
                    </td>
                  </tr>
                ))
              ) : rules.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/50 lucide lucide-file-search"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="m14 17-2.5-2.5"/></svg>
                      <span>暂无采集规则</span>
                      <Button variant="link" size="sm" onClick={onCreate}>
                        创建第一条规则
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr
                    key={rule.id}
                    className="border-b last:border-0 transition-colors hover:bg-muted/50"
                  >
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium">{rule.name}</p>
                        {rule.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1 max-w-[240px]">
                            {rule.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <Badge variant={rule.enabled ? 'default' : 'secondary'}>
                        {rule.enabled ? '已启用' : '已禁用'}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <Badge variant="outline">
                        {rule.storageMode === 'file' ? '文件' : '数据库'}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <span className="text-muted-foreground">{rule._count?.tasks || 0}</span>
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell text-muted-foreground">
                      {format(new Date(rule.createdAt), 'yyyy-MM-dd HH:mm', { locale: zhCN })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                          onClick={() => handleExecute(rule)}
                          title="执行"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => onEdit(rule)}
                          title="编辑"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleDelete(rule.id)}
                          title="删除"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <span className="text-sm text-muted-foreground">
            第 {page} / {totalPages} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}
    </div>
  );
}

// ==================== Manager View (Default Export) ====================

interface ScrapeManagerViewProps {
  className?: string;
}

export default function ScrapeManagerView({ className }: ScrapeManagerViewProps) {
  const [editingRule, setEditingRule] = useState<ScrapeRuleItem | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleEdit = (rule: ScrapeRuleItem) => {
    setEditingRule(rule);
    setIsCreating(false);
  };

  const handleCreate = () => {
    setEditingRule(null);
    setIsCreating(true);
  };

  const handleSuccess = () => {
    setEditingRule(null);
    setIsCreating(false);
  };

  const handleCancel = () => {
    setEditingRule(null);
    setIsCreating(false);
  };

  return (
    <div className={className}>
      {isCreating || editingRule ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1 lucide lucide-arrow-left"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
              返回列表
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <h2 className="text-lg font-semibold">
              {isCreating ? '新建采集规则' : '编辑采集规则'}
            </h2>
          </div>
          <ScrapeRuleEditor
            ruleId={editingRule?.id || null}
            onSuccess={handleSuccess}
            onCancel={handleCancel}
          />
        </div>
      ) : (
        <ScrapeRuleList onEdit={handleEdit} onCreate={handleCreate} />
      )}
    </div>
  );
}