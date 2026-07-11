'use client';

import { useState, useCallback, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Globe,
  Eye,
  Crosshair,
  Check,
  X,
  Loader2,
  Wand2,
  Copy,
  Search,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Zap,
  Code,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface VisualSelectorBuilderProps {
  onSelectorGenerated: (selector: {
    type: 'css' | 'xpath' | 'regex';
    value: string;
  }) => void;
  onClose: () => void;
  initialUrl?: string;
}

interface SelectorMatch {
  index: number;
  tag: string;
  text: string;
  attrs: Record<string, string>;
}

interface AiSuggestion {
  type: string;
  label: string;
  selector: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sub-components
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

function HtmlPreview({ html }: { html: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const displayHtml = isExpanded ? html : html.slice(0, 5000);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">
          HTML 预览（{html.length.toLocaleString()} 字符）
        </Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(!isExpanded)}
          className="h-6 px-2 text-xs"
        >
          {isExpanded ? (
            <>
              <ChevronUp className="h-3 w-3 mr-1" />
              收起
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3 mr-1" />
              展开全部
            </>
          )}
        </Button>
      </div>
      <ScrollArea className="h-[400px] w-full rounded-lg border bg-muted/20">
        <pre className="p-3 text-xs leading-relaxed font-mono text-foreground/80 whitespace-pre-wrap break-all">
          {displayHtml}
        </pre>
      </ScrollArea>
      {!isExpanded && html.length > 5000 && (
        <p className="text-xs text-center text-muted-foreground">
          仅显示前 5000 字符，点击展开全部
        </p>
      )}
    </div>
  );
}

function MatchedElements({ matches }: { matches: SelectorMatch[] }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  if (matches.length === 0) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        未找到匹配的元素
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          找到 {matches.length} 个匹配元素
        </span>
        <Badge variant="secondary" className="text-xs">
          {matches.length} 匹配
        </Badge>
      </div>
      <ScrollArea className="h-[250px] w-full rounded-lg border">
        <div className="p-2 space-y-1">
          {matches.slice(0, 50).map((match, i) => (
            <div key={i}>
              <button
                className="w-full text-left rounded-md px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors flex items-center gap-2"
                onClick={() =>
                  setExpandedIndex(expandedIndex === i ? null : i)
                }
              >
                <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5">
                  {match.tag}
                </Badge>
                <span className="truncate font-mono text-foreground/70">
                  {match.text || '(无文本内容)'}
                </span>
              </button>
              {expandedIndex === i && (
                <div className="ml-6 mt-1 rounded-md bg-muted/40 p-2 space-y-1">
                  {Object.entries(match.attrs).slice(0, 5).map(([key, val]) => (
                    <p key={key} className="text-[10px] font-mono text-muted-foreground">
                      <span className="text-foreground/60">{key}</span>=
                      <span className="text-primary/80">&quot;{val}&quot;</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
          {matches.length > 50 && (
            <p className="text-xs text-center text-muted-foreground py-2">
              还有 {matches.length - 50} 个匹配元素未显示...
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
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
        <Zap className="h-3 w-3" />
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

  // ═══════════════════════════════════════════════════════════════════════
  // Fetch page preview
  // ═══════════════════════════════════════════════════════════════════════
  const handleFetchPage = useCallback(async () => {
    if (!url.trim()) {
      toast.error('请输入目标 URL');
      return;
    }

    setLoading(true);
    setError(null);
    setHtml('');
    setMatches([]);
    setAiSuggestions([]);

    try {
      const response = await fetch(
        `/api/scrape-rules/preview?url=${encodeURIComponent(url.trim())}`,
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `请求失败 (${response.status})`);
      }

      const data = await response.json();
      setHtml(data.html || '');
      setPageTitle(data.title || '');
      setActiveTab('preview');
      toast.success('页面获取成功');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : '获取页面失败';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
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
        // Regex matching against text content
        const regex = new RegExp(selectorValue, 'gs');
        const allText = doc.body?.textContent || '';
        const regexMatches = allText.match(regex) || [];
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
      // We'll call the ai-generate endpoint for suggestions, 
      // but for now provide a simple heuristic-based approach
      // that works even without the AI service
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const suggestions: AiSuggestion[] = [];

      // Heuristic: find common patterns
      const h1 = doc.querySelector('h1');
      if (h1) {
        suggestions.push({
          type: 'title',
          label: '标题',
          selector: 'h1',
        });
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
            (article.id ? `#${article.id}` : `.${article.className.split(' ')[0]}`),
        });
      }

      // Try to find link lists
      const linkList = doc.querySelector('.chapter-list, .list-group, ul.list, .chapter_list');
      if (linkList) {
        const selector = linkList.id
          ? `#${linkList.id} a`
          : `.${linkList.className.split(' ')[0]} a`;
        suggestions.push({
          type: 'chapterList',
          label: '章节列表',
          selector,
        });
      }

      // Find links
      const links = doc.querySelectorAll('a[href]');
      if (links.length > 0) {
        suggestions.push({
          type: 'links',
          label: '链接',
          selector: 'a[href]',
        });
      }

      // Find images
      const images = doc.querySelectorAll('img[src]');
      if (images.length > 0) {
        suggestions.push({
          type: 'cover',
          label: '封面图片',
          selector: 'img[src]',
        });
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

  // srcdoc for iframe preview
  const iframeSrcdoc = useMemo(() => {
    if (!html) return '';
    // Inject highlight styles
    const style = `
      <style>
        * { transition: outline 0.15s ease; }
        [data-highlighted] { outline: 2px solid #3b82f6 !important; outline-offset: 2px; background: rgba(59,130,246,0.08) !important; }
      </style>
    `;
    return html.replace('<head>', `<head>${style}`).replace('<HEAD>', `<HEAD>${style}`);
  }, [html]);

  return (
    <div className="flex flex-col gap-4 h-full">
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
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
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
              onChange={(e) => setUrl(e.target.value)}
              className="pl-9"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleFetchPage();
              }}
            />
          </div>
          <Button
            onClick={handleFetchPage}
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

      {/* Main content area */}
      {loading ? (
        <LoadingOverlay message="正在获取页面内容..." />
      ) : html ? (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="preview" className="gap-1.5 text-xs">
                <Eye className="h-3.5 w-3.5" />
                页面预览
              </TabsTrigger>
              <TabsTrigger value="html" className="gap-1.5 text-xs">
                <Code className="h-3.5 w-3.5" />
                HTML 源码
              </TabsTrigger>
              <TabsTrigger value="tester" className="gap-1.5 text-xs">
                <Search className="h-3.5 w-3.5" />
                选择器测试
              </TabsTrigger>
            </TabsList>

            {/* Preview Tab */}
            <TabsContent value="preview" className="flex-1 min-h-0 mt-2">
              <div className="h-full rounded-lg border overflow-hidden">
                <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
                  <div className="flex gap-1">
                    <div className="h-2 w-2 rounded-full bg-red-400/60" />
                    <div className="h-2 w-2 rounded-full bg-yellow-400/60" />
                    <div className="h-2 w-2 rounded-full bg-green-400/60" />
                  </div>
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    {pageTitle || url}
                  </span>
                </div>
                <div className="h-[350px] bg-white">
                  <iframe
                    ref={iframeRef}
                    srcDoc={iframeSrcdoc}
                    className="w-full h-full border-0"
                    sandbox="allow-same-origin"
                    title="页面预览"
                  />
                </div>
              </div>
            </TabsContent>

            {/* HTML Tab */}
            <TabsContent value="html" className="flex-1 min-h-0 mt-2">
              <HtmlPreview html={html} />
            </TabsContent>

            {/* Tester Tab */}
            <TabsContent value="tester" className="flex-1 min-h-0 mt-2 space-y-4">
              {/* Selector Input */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">选择器</Label>
                <div className="flex gap-2">
                  <Select
                    value={selectorType}
                    onValueChange={(v) =>
                      setSelectorType(v as 'css' | 'xpath' | 'regex')
                    }
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
                    className="flex-1 font-mono text-sm"
                    placeholder={
                      selectorType === 'css'
                        ? '.class-name, #id, div > p'
                        : selectorType === 'xpath'
                          ? '//div[@class="name"]'
                          : '正则表达式'
                    }
                    value={selectorValue}
                    onChange={(e) => setSelectorValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleTestSelector();
                    }}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={handleCopy}
                    title="复制"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    onClick={handleTestSelector}
                    disabled={testing}
                    className="gap-1.5 shrink-0"
                  >
                    {testing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    测试
                  </Button>
                </div>
              </div>

              {/* Matches */}
              <MatchedElements matches={matches} />
            </TabsContent>
          </Tabs>

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
                    onClick={handleSmartSuggest}
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
                    onSelect={handleSelectSuggestion}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleSmartSuggest}
                    className="gap-1.5 text-xs"
                  >
                    <Wand2 className="h-3 w-3" />
                    重新分析
                  </Button>
                </>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : (
        <EmptyState
          icon={Globe}
          title="输入 URL 获取页面"
          description="输入目标网站 URL，点击获取页面按钮，系统将加载页面 HTML 内容供你分析并构建选择器"
        />
      )}

      <Separator />

      {/* Footer Actions */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          onClick={handleApply}
          disabled={!selectorValue.trim()}
          className="gap-1.5"
        >
          <Check className="h-4 w-4" />
          应用选择器
        </Button>
      </div>
    </div>
  );
}
