'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { safeResolver } from '@/lib/safe-resolver';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { AiRuleAssistant, type GeneratedRule } from './AiRuleAssistant';
import { VisualSelectorBuilder } from './VisualSelectorBuilder';

// Re-export types for backwards compatibility
export type { ScrapeRuleFormData, ScrapeRuleItem, SelectorRule, PaginationConfig, AntiCrawlConfig, CleanConfig } from './parts/types';

// Internal imports
import type { SelectorRule, PaginationConfig, ScrapeRuleItem } from './parts/types';
import { scrapeRuleSchema, defaultSelector, defaultPagination, type FormValues } from './parts/schema';
import { BasicInfoTab } from './parts/BasicInfoTab';
import { ListPageTab } from './parts/ListPageTab';
import { BookInfoTab } from './parts/BookInfoTab';
import { ChapterDirTab } from './parts/ChapterDirTab';
import { ChapterContentTab } from './parts/ChapterContentTab';
import { AntiCrawlTab } from './parts/AntiCrawlTab';
import { StorageTab } from './parts/StorageTab';
import { StrategyTab } from './parts/StrategyTab';
import { CleanTab } from './parts/CleanTab';
import { ScrapeRuleList } from './parts/ScrapeRuleList';
import { ScrapeTaskMonitor } from './ScrapeTaskMonitor';

// ==================== Main Editor ====================

interface ScrapeRuleEditorProps {
  ruleId: string | null;
  initialAiRule?: GeneratedRule | null;
  onSuccess: () => void;
  onCancel: () => void;
}

export function ScrapeRuleEditor({ ruleId, initialAiRule, onSuccess, onCancel }: ScrapeRuleEditorProps) {
  const formMethods = useForm<FormValues>({
    resolver: safeResolver(scrapeRuleSchema),
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
      agentqlQueries: '',
      cloudBrowserProvider: 'browserless',
      cloudBrowserUrl: 'https://chrome.browserless.io',
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

  const { register, handleSubmit, reset, setValue, watch, formState: { errors, isSubmitting } } = formMethods;

  // AI Rule Assistant state
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  // Visual Selector state
  const [visualSelectorOpen, setVisualSelectorOpen] = useState(false);
  const [visualSelectorField, setVisualSelectorField] = useState<keyof FormValues | ''>('');
  const visualSelectorFieldRef = useRef(visualSelectorField);
  visualSelectorFieldRef.current = visualSelectorField;

  // Form helpers
  const setSelector = useCallback(
    (field: keyof FormValues, val: SelectorRule) => {
      setValue(field, val as any, { shouldDirty: true });
    },
    [setValue]
  );

  const setPagination = useCallback(
    (field: keyof FormValues, val: PaginationConfig) => {
      setValue(field, val as any, { shouldDirty: true });
    },
    [setValue]
  );

  // Apply AI-generated rule to form
  const handleApplyAiRule = useCallback((rule: GeneratedRule) => {
    const s = (v?: { type: string; value: string }): SelectorRule => ({
      type: (v?.type as 'css' | 'xpath' | 'regex') || 'css',
      value: v?.value || '',
    });
    const p = (v?: { type: string; selector: string; maxPage: number }): PaginationConfig => ({
      type: (v?.type as 'next' | 'page') || 'next',
      selector: v?.selector || '',
      maxPage: v?.maxPage || 100,
    });

    setValue('name', rule.name, { shouldDirty: true });
    setValue('description', rule.description || '', { shouldDirty: true });
    setValue('engine', (rule.engine as FormValues['engine']) || 'cheerio', { shouldDirty: true });
    if (rule.listUrl) setValue('listUrl', rule.listUrl, { shouldDirty: true });
    if (rule.listSelector) setValue('listSelector', s(rule.listSelector), { shouldDirty: true });
    if (rule.listPagination) setValue('listPagination', p(rule.listPagination), { shouldDirty: true });
    if (rule.bookTitleSelector) setValue('bookTitleSelector', s(rule.bookTitleSelector), { shouldDirty: true });
    if (rule.bookAuthorSelector) setValue('bookAuthorSelector', s(rule.bookAuthorSelector), { shouldDirty: true });
    if (rule.bookDescriptionSelector) setValue('bookDescriptionSelector', s(rule.bookDescriptionSelector), { shouldDirty: true });
    if (rule.bookCoverSelector) setValue('bookCoverSelector', s(rule.bookCoverSelector), { shouldDirty: true });
    if (rule.bookStatusSelector) setValue('bookStatusSelector', s(rule.bookStatusSelector), { shouldDirty: true });
    if (rule.chapterListSelector) setValue('chapterListSelector', s(rule.chapterListSelector), { shouldDirty: true });
    if (rule.chapterTitleSelector) setValue('chapterTitleSelector', s(rule.chapterTitleSelector), { shouldDirty: true });
    if (rule.chapterLinkSelector) setValue('chapterLinkSelector', s(rule.chapterLinkSelector), { shouldDirty: true });
    if (rule.contentSelector) setValue('contentSelector', s(rule.contentSelector), { shouldDirty: true });
    if (rule.contentTitleSelector) setValue('contentTitleSelector', s(rule.contentTitleSelector), { shouldDirty: true });
    if (rule.antiCrawlConfig) {
      setValue('antiCrawlConfig', {
        useJsRender: rule.antiCrawlConfig.useJsRender || false,
        uaRotation: rule.antiCrawlConfig.uaRotation || false,
        cookies: '',
        minDelay: rule.antiCrawlConfig.minDelay || 500,
        maxDelay: rule.antiCrawlConfig.maxDelay || 2000,
      }, { shouldDirty: true });
    }
    if (rule.agentqlQueries) {
      setValue('agentqlQueries', JSON.stringify(rule.agentqlQueries, null, 2), { shouldDirty: true });
    }

    setAiAssistantOpen(false);
    toast.success('AI规则已应用到编辑器');
  }, [setValue]);

  // Apply initial AI rule when passed from parent (list-level AI assistant)
  useEffect(() => {
    if (initialAiRule) {
      handleApplyAiRule(initialAiRule);
    }
  }, [initialAiRule, handleApplyAiRule]);

  // Open visual selector for a specific field
  const openVisualSelector = useCallback((fieldName: string, currentUrl?: string) => {
    setVisualSelectorField(fieldName as keyof FormValues);
    setVisualSelectorOpen(true);
  }, []);

  const handleVisualSelectorGenerated = useCallback((selector: { type: 'css' | 'xpath' | 'regex'; value: string }) => {
    setVisualSelectorOpen(false);
    const field = visualSelectorFieldRef.current;
    if (field) {
      setSelector(field as keyof FormValues, selector);
      toast.success(`选择器已应用到 ${field}`);
    }
  }, [setSelector]);

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
          engine: (rule.engine as FormValues['engine']) || 'cheerio',
          agentqlQueries: rule.agentqlConfig || '',
          cloudBrowserProvider: 'browserless',
          cloudBrowserUrl: 'https://chrome.browserless.io',
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

  // Build form access object for sub-components
  const formAccess = { form: formMethods, setSelector, setPagination };

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
          <BasicInfoTab {...formAccess} />
        </TabsContent>

        {/* Tab 2: List Page Rules */}
        <TabsContent value="list">
          <ListPageTab {...formAccess} />
        </TabsContent>

        {/* Tab 3: Book Info Rules */}
        <TabsContent value="book">
          <BookInfoTab {...formAccess} />
        </TabsContent>

        {/* Tab 4: Chapter Directory Rules */}
        <TabsContent value="chapter-dir">
          <ChapterDirTab {...formAccess} />
        </TabsContent>

        {/* Tab 5: Chapter Content Rules */}
        <TabsContent value="chapter-content">
          <ChapterContentTab {...formAccess} />
        </TabsContent>

        {/* Tab 6: Anti-Crawl */}
        <TabsContent value="anti-crawl">
          <AntiCrawlTab {...formAccess} />
        </TabsContent>

        {/* Tab 7: Storage */}
        <TabsContent value="storage">
          <StorageTab {...formAccess} />
        </TabsContent>

        {/* Tab 8: Scraping Strategy */}
        <TabsContent value="strategy">
          <StrategyTab
            {...formAccess}
            onOpenAiAssistant={() => setAiAssistantOpen(true)}
            onOpenVisualSelector={openVisualSelector}
          />
        </TabsContent>

        {/* Tab 9: Content Cleaning */}
        <TabsContent value="clean">
          <CleanTab {...formAccess} />
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

      {/* AI Rule Assistant Dialog */}
      <AiRuleAssistant
        open={aiAssistantOpen}
        onOpenChange={setAiAssistantOpen}
        onApplyRule={handleApplyAiRule}
      />

      {/* Visual Selector Builder Dialog */}
      {visualSelectorOpen && (
        <VisualSelectorBuilder
          onSelectorGenerated={handleVisualSelectorGenerated}
          onClose={() => setVisualSelectorOpen(false)}
          initialUrl={watch('listUrl')}
        />
      )}
    </form>
  );
}

// ==================== Manager View (Default Export) ====================

interface ScrapeManagerViewProps {
  className?: string;
}

export default function ScrapeManagerView({ className }: ScrapeManagerViewProps) {
  const [editingRule, setEditingRule] = useState<ScrapeRuleItem | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showTaskMonitor, setShowTaskMonitor] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);

  const handleEdit = (rule: ScrapeRuleItem) => {
    setEditingRule(rule);
    setIsCreating(false);
    setShowTaskMonitor(false);
  };

  const handleCreate = () => {
    setEditingRule(null);
    setIsCreating(true);
    setShowTaskMonitor(false);
  };

  const handleSuccess = () => {
    setEditingRule(null);
    setIsCreating(false);
  };

  const handleCancel = () => {
    setEditingRule(null);
    setIsCreating(false);
  };

  const handleBackFromMonitor = () => {
    setShowTaskMonitor(false);
  };

  const [pendingAiRule, setPendingAiRule] = useState<GeneratedRule | null>(null);

  const handleAiApplyAndCreate = (rule: GeneratedRule) => {
    // When applying from the list-level AI assistant, create a new rule
    setAiAssistantOpen(false);
    setIsCreating(true);
    setShowTaskMonitor(false);
    setPendingAiRule(rule);
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
            initialAiRule={pendingAiRule}
            onSuccess={() => { handleSuccess(); setPendingAiRule(null); }}
            onCancel={() => { handleCancel(); setPendingAiRule(null); }}
          />
        </div>
      ) : showTaskMonitor ? (
        <ScrapeTaskMonitor onBack={handleBackFromMonitor} />
      ) : (
        <>
          <div className="mb-3 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowTaskMonitor(true)}
              className="gap-1.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>
              任务记录
            </Button>
          </div>
          <ScrapeRuleList onEdit={handleEdit} onCreate={handleCreate} onOpenAiAssistant={() => setAiAssistantOpen(true)} />
        </>
      )}

      {/* List-level AI Assistant */}
      <AiRuleAssistant
        open={aiAssistantOpen}
        onOpenChange={setAiAssistantOpen}
        onApplyRule={handleAiApplyAndCreate}
      />
    </div>
  );
}