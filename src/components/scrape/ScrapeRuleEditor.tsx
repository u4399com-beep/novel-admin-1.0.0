'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { safeResolver } from '@/lib/safe-resolver';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { Loader2, FlaskConical } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { AiRuleAssistant, type GeneratedRule } from './AiRuleAssistant';
import { VisualSelectorBuilder } from './VisualSelectorBuilder';

// Re-export types for backwards compatibility
export type { ScrapeRuleFormData, ScrapeRuleItem, SelectorRule, PaginationConfig, AntiCrawlConfig, CleanConfig } from './parts/types';

// Internal imports
import type { SelectorRule, PaginationConfig, ScrapeRuleItem } from './parts/types';
import type { FormValues } from './parts/schema';
import { scrapeRuleSchema, defaultSelector, defaultPagination } from './parts/schema';
import { ScrapeRuleList } from './parts/ScrapeRuleList';
import { ScrapeTaskMonitor } from './ScrapeTaskMonitor';
import { AntiCrawlMonitor } from './AntiCrawlMonitor';
import { RuleFormTabs } from './rule-editor/RuleFormTabs';
import { TestRuleDialog } from './TestRuleDialog';

// ==================== Main Editor ====================

/**
 * Normalize cleanConfig from API: convert array patterns to newline-separated strings.
 * The backend may store removePatterns/adPatterns as string[] (from seed rules)
 * or as newline-separated strings (from the frontend editor).
 */
function normalizeCleanConfig(cfg: Record<string, unknown>): { removeAds: boolean; cleanHtml: boolean; removeSelectors: string; removePatterns: string; adPatterns: string } {
  const patternsToString = (v: unknown): string => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.filter((p): p is string => typeof p === 'string').join('\n');
    return '';
  };
  return {
    removeAds: typeof cfg.removeAds === 'boolean' ? cfg.removeAds : true,
    cleanHtml: typeof cfg.cleanHtml === 'boolean' ? cfg.cleanHtml : true,
    removeSelectors: patternsToString(cfg.removeSelectors),
    removePatterns: patternsToString(cfg.removePatterns),
    adPatterns: patternsToString(cfg.adPatterns),
  };
}

const VALID_SELECTOR_TYPES = new Set(['css', 'xpath', 'regex']);
const VALID_PAGINATION_TYPES = new Set(['next', 'page']);

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
      antiCrawlConfig: { useJsRender: false, uaRotation: false, cookies: '', minDelay: 500, maxDelay: 2000, humanBehavior: false, dnt: false, acceptLanguage: '', referer: '', captchaStrategy: 'auto', enableCaptchaRetry: true, maxCaptchaRetries: 3 },
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
      cleanConfig: { removeAds: true, cleanHtml: true, removeSelectors: '', removePatterns: '', adPatterns: '' },
    },
  });

  const { handleSubmit, reset, setValue, watch, formState: { isSubmitting } } = formMethods;

  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [visualSelectorOpen, setVisualSelectorOpen] = useState(false);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [visualSelectorField, setVisualSelectorField] = useState<keyof FormValues | ''>('');
  const visualSelectorFieldRef = useRef(visualSelectorField);
  visualSelectorFieldRef.current = visualSelectorField;

  type FormField = Parameters<typeof formMethods.setValue>[0];
  const safeSetValue = useCallback(
    (field: string, value: unknown, options?: Parameters<typeof formMethods.setValue>[2]) => {
      formMethods.setValue(field as FormField, value as never, options);
    },
    [formMethods.setValue]
  );

  const setSelector = useCallback(
    (field: keyof FormValues, val: SelectorRule) => {
      safeSetValue(field, val, { shouldDirty: true });
    },
    [safeSetValue]
  );

  const setPagination = useCallback(
    (field: keyof FormValues, val: PaginationConfig) => {
      safeSetValue(field, val, { shouldDirty: true });
    },
    [safeSetValue]
  );

  const handleApplyAiRule = useCallback((rule: GeneratedRule) => {
    const s = (v?: { type: string; value: string }): SelectorRule => ({
      type: (v?.type != null && VALID_SELECTOR_TYPES.has(v.type) ? v.type : 'css') as 'css' | 'xpath' | 'regex',
      value: v?.value || '',
    });
    const p = (v?: { type: string; selector: string; maxPage: number }): PaginationConfig => ({
      type: (v?.type != null && VALID_PAGINATION_TYPES.has(v.type) ? v.type : 'next') as 'next' | 'page',
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
        humanBehavior: rule.antiCrawlConfig.humanBehavior || false,
        dnt: rule.antiCrawlConfig.dnt || false,
        acceptLanguage: rule.antiCrawlConfig.acceptLanguage || '',
        referer: rule.antiCrawlConfig.referer || '',
        captchaStrategy: 'auto',
        enableCaptchaRetry: true,
        maxCaptchaRetries: 3,
      }, { shouldDirty: true });
    }
    if (rule.agentqlQueries) {
      setValue('agentqlQueries', JSON.stringify(rule.agentqlQueries, null, 2), { shouldDirty: true });
    }
    setAiAssistantOpen(false);
    toast.success('AI规则已应用到编辑器');
  }, [setValue]);

  useEffect(() => {
    if (initialAiRule) handleApplyAiRule(initialAiRule);
  }, [initialAiRule, handleApplyAiRule]);

  const openVisualSelector = useCallback((fieldName: string, _currentUrl?: string) => {
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

  useEffect(() => {
    if (!ruleId) { reset(); return; }
    const controller = new AbortController();
    async function loadRule() {
      try {
        const rule = await apiFetch<Record<string, unknown>>(`/api/scrape-rules/${ruleId}`, { signal: controller.signal });
        const str = (k: string) => (rule[k] as string | null) ?? null;
        const num = (k: string) => (rule[k] as number | null) ?? null;
        const bool = (k: string) => (rule[k] as boolean | null) ?? null;
        const parseJSON = <T,>(val: unknown, fallback: T): T => {
          if (!val) return fallback;
          try { return JSON.parse(val as string) as T; } catch { return fallback; }
        };
        reset({
          name: (rule.name as string) || '',
          description: (rule.description as string) || '',
          enabled: (rule.enabled as boolean) ?? true,
          listUrl: str('listUrl') || '',
          listSelector: parseJSON(rule.listSelector, defaultSelector),
          listPagination: parseJSON(rule.listPagination, defaultPagination),
          bookTitleSelector: parseJSON(rule.bookTitleSelector, defaultSelector),
          bookAuthorSelector: parseJSON(rule.bookAuthorSelector, defaultSelector),
          bookCategorySelector: parseJSON(rule.bookCategorySelector, defaultSelector),
          bookKeywordsSelector: parseJSON(rule.bookKeywordsSelector, defaultSelector),
          bookDescriptionSelector: parseJSON(rule.bookDescriptionSelector, defaultSelector),
          bookCoverSelector: parseJSON(rule.bookCoverSelector, defaultSelector),
          bookStatusSelector: parseJSON(rule.bookStatusSelector, defaultSelector),
          chapterListUrl: str('chapterListUrl') || '',
          chapterListSelector: parseJSON(rule.chapterListSelector, defaultSelector),
          chapterTitleSelector: parseJSON(rule.chapterTitleSelector, defaultSelector),
          chapterLinkSelector: parseJSON(rule.chapterLinkSelector, defaultSelector),
          chapterPagination: parseJSON(rule.chapterPagination, defaultPagination),
          contentTitleSelector: parseJSON(rule.contentTitleSelector, defaultSelector),
          contentSelector: parseJSON(rule.contentSelector, defaultSelector),
          contentPagination: parseJSON(rule.contentPagination, defaultPagination),
          antiCrawlConfig: parseJSON(rule.antiCrawlConfig, { useJsRender: false, uaRotation: false, cookies: '', minDelay: 500, maxDelay: 2000, humanBehavior: false, dnt: false, acceptLanguage: '', referer: '', captchaStrategy: 'auto', enableCaptchaRetry: true, maxCaptchaRetries: 3 }),
          storageMode: (str('storageMode') as FormValues['storageMode']) || 'database',
          filePath: str('filePath') || './data/novels',
          coverSavePath: str('coverSavePath') || './data/covers',
          scrapeMode: (str('scrapeMode') as FormValues['scrapeMode']) || 'incremental',
          engine: (str('engine') as FormValues['engine']) || 'cheerio',
          agentqlQueries: str('agentqlConfig') || '',
          cloudBrowserProvider: 'browserless',
          cloudBrowserUrl: 'https://chrome.browserless.io',
          threadCount: num('threadCount') || 3,
          minDelay: num('minDelay') ?? 1000,
          maxDelay: num('maxDelay') ?? 3000,
          enableShuffle: bool('enableShuffle') ?? false,
          dedupMode: (str('dedupMode') as FormValues['dedupMode']) || 'url',
          cleanConfig: normalizeCleanConfig(parseJSON(rule.cleanConfig, { removeAds: true, cleanHtml: true, removePatterns: '', adPatterns: '' })),
        });
      } catch { /* handled by apiFetch */ }
    }
    loadRule();
    return () => { controller.abort(); };
  }, [ruleId, reset]);

  const onSubmit = async (data: FormValues) => {
    try {
      const url = ruleId ? `/api/scrape-rules/${ruleId}` : '/api/scrape-rules';
      const method = ruleId ? 'PUT' : 'POST';
      await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      toast.success(ruleId ? '规则已更新' : '规则已创建');
      onSuccess();
    } catch { /* handled by apiFetch */ }
  };

  const formAccess = useMemo(() => ({ form: formMethods, setSelector, setPagination }), [formMethods, setSelector, setPagination]);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <RuleFormTabs
        formAccess={formAccess}
        onOpenAiAssistant={() => setAiAssistantOpen(true)}
        onOpenVisualSelector={openVisualSelector}
      />

      <div className="flex items-center justify-end gap-3 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => setTestDialogOpen(true)}
          className="gap-1.5"
          aria-label="测试规则"
        >
          <FlaskConical className="h-4 w-4" />
          测试
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {ruleId ? '保存修改' : '创建规则'}
        </Button>
      </div>

      <AiRuleAssistant
        open={aiAssistantOpen}
        onOpenChange={setAiAssistantOpen}
        onApplyRule={handleApplyAiRule}
      />

      {visualSelectorOpen && (
        <VisualSelectorBuilder
          key={`vs-${visualSelectorField}`}
          onSelectorGenerated={handleVisualSelectorGenerated}
          onClose={() => setVisualSelectorOpen(false)}
          initialUrl={watch('listUrl')}
        />
      )}

      <TestRuleDialog
        open={testDialogOpen}
        onOpenChange={setTestDialogOpen}
        rule={{
          listUrl: watch('listUrl'),
          engine: watch('engine'),
          listSelector: watch('listSelector'),
        }}
      />
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
  const [showAntiCrawlMonitor, setShowAntiCrawlMonitor] = useState(false);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);

  const handleEdit = (rule: ScrapeRuleItem) => {
    setEditingRule(rule);
    setIsCreating(false);
    setShowTaskMonitor(false);
    setShowAntiCrawlMonitor(false);
  };

  const handleCreate = () => {
    setEditingRule(null);
    setIsCreating(true);
    setShowTaskMonitor(false);
    setShowAntiCrawlMonitor(false);
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
    setAiAssistantOpen(false);
    setIsCreating(true);
    setShowTaskMonitor(false);
    setShowAntiCrawlMonitor(false);
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
      ) : showAntiCrawlMonitor ? (
        <AntiCrawlMonitor onBack={() => setShowAntiCrawlMonitor(false)} />
      ) : (
        <>
          <div className="mb-3 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowAntiCrawlMonitor(true)} className="gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-shield-check"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
              反爬监控
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowTaskMonitor(true)} className="gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>
              任务记录
            </Button>
          </div>
          <ScrapeRuleList onEdit={handleEdit} onCreate={handleCreate} onOpenAiAssistant={() => setAiAssistantOpen(true)} />
        </>
      )}

      <AiRuleAssistant
        open={aiAssistantOpen}
        onOpenChange={setAiAssistantOpen}
        onApplyRule={handleAiApplyAndCreate}
      />
    </div>
  );
}
