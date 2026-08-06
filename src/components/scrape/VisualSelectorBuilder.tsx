'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { Globe, Loader2 } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { SelectorPreview } from './visual-selector/SelectorPreview';
import { SelectorResults } from './visual-selector/SelectorResults';
import { SelectorControls } from './visual-selector/SelectorControls';
import { HtmlPreview } from './visual-selector/HtmlPreview';
import type { VisualSelectorBuilderProps, SelectorMatch, AiSuggestion } from './visual-selector/types';

// ═══════════════════════════════════════════════════════════════════════════════
// Sub-components (small, kept inline)
// ═══════════════════════════════════════════════════════════════════════════════

function LoadingOverlay({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function EmptyState({ icon: Icon, title, description }: {
  icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground max-w-xs">{description}</p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════

export function VisualSelectorBuilder({
  onSelectorGenerated,
  onClose,
  initialUrl = '',
}: VisualSelectorBuilderProps) {
  // State
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [html, setHtml] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [selectorValue, setSelectorValue] = useState('');
  const [selectorType, setSelectorType] = useState<'css' | 'xpath' | 'regex'>('css');
  const [matches, setMatches] = useState<SelectorMatch[]>([]);
  const [testing, setTesting] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('preview');
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fetchPageAcRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => () => fetchPageAcRef.current?.abort(), []);

  // ═══════════════════════════════════════════════════════════════════════
  // Fetch page preview
  // ═══════════════════════════════════════════════════════════════════════
  const handleFetchPage = useCallback(async () => {
    if (!url.trim()) {
      toast.error('请输入目标 URL');
      return;
    }

    // Abort previous in-flight request
    fetchPageAcRef.current?.abort();
    const ac = new AbortController();
    fetchPageAcRef.current = ac;

    setLoading(true);
    setError(null);
    setHtml('');
    setMatches([]);
    setAiSuggestions([]);

    try {
      const data = await apiFetch<{html: string; title: string}>(
        `/api/scrape-rules/preview?url=${encodeURIComponent(url.trim())}`,
        { signal: ac.signal },
      );
      if (ac.signal.aborted) return;
      setHtml(data.html || '');
      setPageTitle(data.title || '');
      setActiveTab('preview');
      toast.success('页面获取成功');
    } catch (err: unknown) {
      if (ac.signal.aborted) return;
      const message =
        err instanceof Error ? err.message : '获取页面失败';
      setError(message);
      toast.error(message);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [url]);

  // ═══════════════════════════════════════════════════════════════════════
  // Test CSS selector against loaded HTML
  // ═══════════════════════════════════════════════════════════════════════
  const handleTestSelector = useCallback(() => {
    if (!html) {
      toast.error('请先获取页面');
      return;
    }
    if (!selectorValue.trim()) {
      toast.error('请输入选择器');
      return;
    }

    setTesting(true);
    setMatches([]);

    try {
      // Use DOMParser to parse HTML client-side
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      if (selectorType === 'css') {
        const elements = doc.querySelectorAll(selectorValue);
        const results: SelectorMatch[] = Array.from(elements).slice(0, 100).map((el, i) => ({
          index: i,
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').slice(0, 100).trim(),
          attrs: Object.fromEntries(
            Array.from(el.attributes).map((a) => [a.name, a.value.slice(0, 100)]),
          ),
        }));
        setMatches(results);
        toast.success(`找到 ${elements.length} 个匹配`);
      } else if (selectorType === 'xpath') {
        // Basic XPath support via evaluate
        const result = doc.evaluate(
          selectorValue,
          doc,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        const results: SelectorMatch[] = [];
        for (let i = 0; i < Math.min(result.snapshotLength, 100); i++) {
          const node = result.snapshotItem(i);
          if (node instanceof Element) {
            results.push({
              index: i,
              tag: node.tagName.toLowerCase(),
              text: (node.textContent || '').slice(0, 100).trim(),
              attrs: Object.fromEntries(
                Array.from(node.attributes).map((a) => [a.name, a.value.slice(0, 100)]),
              ),
            });
          }
        }
        setMatches(results);
        toast.success(`找到 ${result.snapshotLength} 个匹配`);
      } else if (selectorType === 'regex') {
        // Regex matching against text content — with ReDoS protection
        const RE_DANGEROUS_PATTERNS = [
          /\((?:\([^)]*\)[+*]?\s*)+\+/,
          /(\.\+|\.\*)\1/,
          /\[[^\]]*\]\{(\d+),\1\}/,
          /(\+[+*]|\*[\+*])/, 
          /\(\?[=!:]\([^)]*\)[+*]/,
        ];
        for (const dangerousRe of RE_DANGEROUS_PATTERNS) {
          if (dangerousRe.test(selectorValue)) {
            toast.error('选择器可能包含危险正则模式，已拒绝执行');
            setMatches([]);
            return;
          }
        }
        // Limit input text to prevent CPU exhaustion
        const allText = (doc.body?.textContent || '').slice(0, 100_000);
        const regex = new RegExp(selectorValue, 'gs');
        // Set a timeout-based guard — if matching takes >2s, treat as ReDoS
        const startTime = Date.now();
        const regexMatches = allText.match(regex) || [];
        if (Date.now() - startTime > 2000) {
          toast.error('正则执行时间过长，可能存在回溯爆炸风险');
          setMatches([]);
          return;
        }
        const results: SelectorMatch[] = regexMatches.slice(0, 100).map((m, i) => ({
          index: i,
          tag: 'text',
          text: m.slice(0, 100).trim(),
          attrs: {},
        }));
        setMatches(results);
        toast.success(`正则匹配到 ${regexMatches.length} 个结果`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '选择器测试失败';
      toast.error(`选择器错误: ${message}`);
      setMatches([]);
    } finally {
      setTesting(false);
    }
  }, [html, selectorValue, selectorType]);

  // ═══════════════════════════════════════════════════════════════════════
  // AI Smart Suggest
  // ═══════════════════════════════════════════════════════════════════════
  const handleSmartSuggest = useCallback(async () => {
    if (!html) {
      toast.error('请先获取页面');
      return;
    }

    setAiLoading(true);
    setAiSuggestions([]);

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const suggestions: AiSuggestion[] = [];

      const h1 = doc.querySelector('h1');
      if (h1) {
        suggestions.push({ type: 'title', label: '标题', selector: 'h1' });
      }

      const metaDesc = doc.querySelector('meta[name="description"]');
      if (metaDesc) {
        suggestions.push({
          type: 'description',
          label: '描述',
          selector: 'meta[name="description"]',
        });
      }

      // Try to find article/content elements
      const article = doc.querySelector('article') || doc.querySelector('.content') || doc.querySelector('#content');
      if (article) {
        suggestions.push({
          type: 'content',
          label: '正文内容',
          selector: article.tagName.toLowerCase() === 'article' ? 'article' :
            (article.id ? `#${article.id}` : (() => {
              const firstClass = article.className && article.className.split ? article.className.split(/\s+/)[0] : '';
              return firstClass && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(firstClass) ? `.${firstClass}` : 'article';
            })()),
        });
      }

      // Try to find link lists
      const linkList = doc.querySelector('.chapter-list, .list-group, ul.list, .chapter_list');
      if (linkList) {
        const selector = linkList.id
          ? `#${linkList.id} a`
          : (() => {
              const firstClass = linkList.className && linkList.className.split ? linkList.className.split(/\s+/)[0] : '';
              return firstClass && /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(firstClass) ? `.${firstClass} a` : 'ul a';
            })();
        suggestions.push({
          type: 'chapterList',
          label: '章节列表',
          selector,
        });
      }

      // Find links
      const links = doc.querySelectorAll('a[href]');
      if (links.length > 0) {
        suggestions.push({ type: 'links', label: '链接', selector: 'a[href]' });
      }

      // Find images
      const images = doc.querySelectorAll('img[src]');
      if (images.length > 0) {
        suggestions.push({ type: 'cover', label: '封面图片', selector: 'img[src]' });
      }

      setAiSuggestions(suggestions);

      if (suggestions.length > 0) {
        toast.success(`AI 建议了 ${suggestions.length} 个选择器`);
      } else {
        toast.info('未能自动识别选择器，请手动输入');
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : '智能建议失败';
      toast.error(message);
    } finally {
      setAiLoading(false);
    }
  }, [html]);

  // ═══════════════════════════════════════════════════════════════════════
  // Apply selector
  // ═══════════════════════════════════════════════════════════════════════
  const handleApply = useCallback(() => {
    if (!selectorValue.trim()) {
      toast.error('请输入选择器');
      return;
    }
    onSelectorGenerated({ type: selectorType, value: selectorValue.trim() });
    toast.success('选择器已应用');
    onClose();
  }, [selectorValue, selectorType, onSelectorGenerated, onClose]);

  // ═══════════════════════════════════════════════════════════════════════
  // Copy selector to clipboard
  // ═══════════════════════════════════════════════════════════════════════
  const handleCopy = useCallback(async () => {
    if (!selectorValue.trim()) return;
    try {
      await navigator.clipboard.writeText(selectorValue);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败');
    }
  }, [selectorValue]);

  // ═══════════════════════════════════════════════════════════════════════
  // Select AI suggestion
  // ═══════════════════════════════════════════════════════════════════════
  const handleSelectSuggestion = useCallback((selector: string) => {
    setSelectorValue(selector);
    setSelectorType('css');
    setActiveTab('tester');
    toast.success('已填入选择器，可在测试面板验证');
  }, []);

  return (
    <div className="flex flex-col gap-4 h-full">
      <SelectorControls
        url={url}
        loading={loading}
        aiLoading={aiLoading}
        aiSuggestions={aiSuggestions}
        error={error}
        selectorValue={selectorValue}
        onUrlChange={setUrl}
        onFetchPage={handleFetchPage}
        onSmartSuggest={handleSmartSuggest}
        onSelectSuggestion={handleSelectSuggestion}
        onApply={handleApply}
        onClose={onClose}
      />

      {/* Main content area */}
      {loading ? (
        <LoadingOverlay message="正在获取页面内容..." />
      ) : html ? (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="preview" className="gap-1.5 text-xs">
                页面预览
              </TabsTrigger>
              <TabsTrigger value="html" className="gap-1.5 text-xs">
                HTML 源码
              </TabsTrigger>
              <TabsTrigger value="tester" className="gap-1.5 text-xs">
                选择器测试
              </TabsTrigger>
            </TabsList>

            {/* Preview Tab */}
            <TabsContent value="preview" className="flex-1 min-h-0 mt-2">
              <SelectorPreview
                html={html}
                pageTitle={pageTitle}
                url={url}
                iframeRef={iframeRef}
              />
            </TabsContent>

            {/* HTML Tab */}
            <TabsContent value="html" className="flex-1 min-h-0 mt-2">
              <HtmlPreview html={html} />
            </TabsContent>

            {/* Tester Tab */}
            <TabsContent value="tester" className="flex-1 min-h-0 mt-2">
              <SelectorResults
                selectorValue={selectorValue}
                selectorType={selectorType}
                matches={matches}
                testing={testing}
                onSelectorValueChange={setSelectorValue}
                onSelectorTypeChange={setSelectorType}
                onTest={handleTestSelector}
                onCopy={handleCopy}
              />
            </TabsContent>
          </Tabs>
        </div>
      ) : (
        <EmptyState
          icon={Globe}
          title="输入 URL 获取页面"
          description="输入目标网站 URL，点击获取页面按钮，系统将加载页面 HTML 内容供你分析并构建选择器"
        />
      )}
    </div>
  );
}
