'use client';

import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Sparkles,
  Loader2,
  Check,
  X,
  Globe,
  BookOpen,
  Palette,
  RotateCcw,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Shield,
  Zap,
  AlertTriangle,
  Info,
  Copy,
  Eye,
  Brain,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface GeneratedRule {
  name: string;
  description: string;
  engine: string;
  listUrl: string;
  listSelector: { type: string; value: string };
  listPagination: { type: string; selector: string; maxPage: number };
  bookTitleSelector: { type: string; value: string };
  bookAuthorSelector: { type: string; value: string };
  bookDescriptionSelector: { type: string; value: string };
  bookCoverSelector: { type: string; value: string };
  bookStatusSelector: { type: string; value: string };
  chapterListSelector: { type: string; value: string };
  chapterTitleSelector: { type: string; value: string };
  chapterLinkSelector: { type: string; value: string };
  contentSelector: { type: string; value: string };
  contentTitleSelector: { type: string; value: string };
  antiCrawlConfig: {
    useJsRender: boolean;
    uaRotation: boolean;
    minDelay: number;
    maxDelay: number;
  };
  agentqlQueries?: {
    title?: string;
    author?: string;
    description?: string;
    chapters?: string;
    content?: string;
  };
  confidence: number;
  notes: string[];
}

interface AiRuleAssistantProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplyRule: (rule: GeneratedRule) => void;
}

type Step = 'input' | 'analyzing' | 'result';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function getConfidenceColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
  if (score >= 50) return 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30';
  return 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30';
}

function getConfidenceLabel(score: number): string {
  if (score >= 80) return '高置信度';
  if (score >= 50) return '中等置信度';
  return '低置信度';
}

function getConfidenceIcon(score: number): React.ReactNode {
  if (score >= 80) return <Shield className="h-3 w-3" />;
  if (score >= 50) return <Info className="h-3 w-3" />;
  return <AlertTriangle className="h-3 w-3" />;
}

const SITE_TYPES = [
  { value: 'novel', label: '小说站', icon: BookOpen, description: '传统小说连载网站' },
  { value: 'manga', label: '漫画站', icon: Palette, description: '漫画/图片连载网站' },
  { value: 'literature', label: '综合文学站', icon: Globe, description: '综合文学/阅读平台' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════════════════════════

function StepIndicator({ currentStep }: { currentStep: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'input', label: '输入信息' },
    { key: 'analyzing', label: 'AI 分析中' },
    { key: 'result', label: '查看结果' },
  ];

  const currentIndex = steps.findIndex((s) => s.key === currentStep);

  return (
    <div className="flex items-center gap-1">
      {steps.map((step, i) => (
        <div key={step.key} className="flex items-center gap-1">
          {i > 0 && (
            <div
              className={`h-px w-6 transition-colors ${
                i <= currentIndex ? 'bg-primary' : 'bg-border'
              }`}
            />
          )}
          <div
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              i === currentIndex
                ? 'bg-primary text-primary-foreground'
                : i < currentIndex
                  ? 'bg-primary/15 text-primary'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            {i < currentIndex ? (
              <Check className="h-3 w-3" />
            ) : i === currentIndex && step.key === 'analyzing' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span className="text-[10px] font-bold">{i + 1}</span>
            )}
            {step.label}
          </div>
        </div>
      ))}
    </div>
  );
}

function AnalyzingView({ url }: { url: string }) {
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('正在连接目标站点...');

  useEffect(() => {
    const stages = [
      { at: 5, text: '正在连接目标站点...' },
      { at: 15, text: '正在获取页面内容...' },
      { at: 30, text: '正在分析页面结构...' },
      { at: 45, text: '正在识别列表页模式...' },
      { at: 55, text: '正在识别书籍信息字段...' },
      { at: 65, text: '正在生成选择器规则...' },
      { at: 75, text: '正在测试选择器匹配...' },
      { at: 85, text: '正在优化反爬策略...' },
      { at: 95, text: '正在生成最终配置...' },
    ];

    const interval = setInterval(() => {
      setProgress((prev) => {
        const next = Math.min(prev + Math.random() * 8 + 1, 99);
        const stage = [...stages].reverse().find((s) => next >= s.at);
        if (stage) setStatusText(stage.text);
        return next;
      });
    }, 600);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12">
      {/* Animated brain/sparkles */}
      <div className="relative">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
          <Brain className="h-10 w-10 text-primary animate-pulse" />
        </div>
        <Sparkles className="absolute -top-2 -right-2 h-5 w-5 text-primary/60 animate-bounce" />
        <Sparkles className="absolute -bottom-1 -left-3 h-4 w-4 text-primary/40 animate-bounce [animation-delay:150ms]" />
      </div>

      <div className="space-y-2 text-center">
        <h3 className="text-sm font-semibold">AI 正在分析页面</h3>
        <p className="text-xs text-muted-foreground max-w-xs">{statusText}</p>
      </div>

      <div className="w-full max-w-sm space-y-2">
        <Progress value={progress} className="h-2" />
        <p className="text-center text-[10px] text-muted-foreground">
          目标: {url}
        </p>
      </div>

      {/* Animated dots */}
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-2 w-2 rounded-full bg-primary/40 animate-bounce"
            style={{ animationDelay: `${i * 200}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function SelectorCard({ label, selector, editable = false }: {
  label: string;
  selector: { type: string; value: string } | undefined;
  editable?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(selector?.value || '');
  const [prevValue, setPrevValue] = useState(selector?.value || '');

  if (selector?.value !== prevValue) {
    setValue(selector?.value || '');
    setPrevValue(selector?.value || '');
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">
        {label}
      </span>
      {editing ? (
        <Input
          className="flex-1 h-7 text-xs font-mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === 'Enter' && setEditing(false)}
          autoFocus
        />
      ) : (
        <code
          className={`flex-1 text-xs font-mono truncate cursor-pointer hover:text-primary transition-colors ${
            selector?.value ? 'text-foreground/70' : 'text-muted-foreground italic'
          }`}
          onClick={() => editable && setEditing(true)}
          title={editable ? '点击编辑' : undefined}
        >
          {selector?.value || '(未设置)'}
        </code>
      )}
      {selector?.type && (
        <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5">
          {selector.type}
        </Badge>
      )}
    </div>
  );
}

function ResultView({
  rule,
  onApply,
  onRegenerate,
}: {
  rule: GeneratedRule;
  onApply: () => void;
  onRegenerate: () => void;
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [agentqlOpen, setAgentqlOpen] = useState(false);
  const confidenceIconEmoji = getConfidenceIcon(rule.confidence);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 pr-4">
        {/* Confidence & Meta */}
        <div className="flex items-center gap-3">
          <Badge className={getConfidenceColor(rule.confidence)}>
            <span className="mr-1">{confidenceIconEmoji}</span>
            {rule.confidence}% · {getConfidenceLabel(rule.confidence)}
          </Badge>
          <Badge variant="outline">
            {rule.engine === 'cheerio' ? 'Cheerio' : rule.engine === 'playwright' ? 'Playwright' : rule.engine}
          </Badge>
        </div>

        {/* Rule name & description */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm">{rule.name}</CardTitle>
            <CardDescription className="text-xs">{rule.description}</CardDescription>
          </CardHeader>
        </Card>

        {/* List page selectors */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5" />
              列表页配置
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-1.5">
            <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">
                列表 URL
              </span>
              <code className="flex-1 text-xs font-mono truncate text-primary/70 hover:underline cursor-pointer">
                {rule.listUrl || '(未设置)'}
              </code>
            </div>
            <SelectorCard label="列表选择器" selector={rule.listSelector} editable />
            <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">
                分页类型
              </span>
              <code className="flex-1 text-xs font-mono truncate text-foreground/70">
                {rule.listPagination?.type || '未设置'}
              </code>
              <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5">
                最多 {rule.listPagination?.maxPage || 0} 页
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Book info selectors */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <BookOpen className="h-3.5 w-3.5" />
              书籍信息选择器
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-1.5">
            <SelectorCard label="书名" selector={rule.bookTitleSelector} editable />
            <SelectorCard label="作者" selector={rule.bookAuthorSelector} editable />
            <SelectorCard label="简介" selector={rule.bookDescriptionSelector} editable />
            <SelectorCard label="封面" selector={rule.bookCoverSelector} editable />
            <SelectorCard label="状态" selector={rule.bookStatusSelector} editable />
          </CardContent>
        </Card>

        {/* Chapter selectors */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5" />
              章节选择器
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-1.5">
            <SelectorCard label="章节列表" selector={rule.chapterListSelector} editable />
            <SelectorCard label="章节标题" selector={rule.chapterTitleSelector} editable />
            <SelectorCard label="章节链接" selector={rule.chapterLinkSelector} editable />
          </CardContent>
        </Card>

        {/* Content selectors */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Eye className="h-3.5 w-3.5" />
              正文内容选择器
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-1.5">
            <SelectorCard label="内容标题" selector={rule.contentTitleSelector} editable />
            <SelectorCard label="正文内容" selector={rule.contentSelector} editable />
          </CardContent>
        </Card>

        {/* Anti-crawl config */}
        {rule.antiCrawlConfig && (
          <Card>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-xs flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5" />
                反爬策略
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">JS 渲染</p>
                  <p className="text-xs font-medium">
                    {rule.antiCrawlConfig.useJsRender ? '启用' : '关闭'}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">UA 轮换</p>
                  <p className="text-xs font-medium">
                    {rule.antiCrawlConfig.uaRotation ? '启用' : '关闭'}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">最小延迟</p>
                  <p className="text-xs font-medium">{rule.antiCrawlConfig.minDelay}ms</p>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">最大延迟</p>
                  <p className="text-xs font-medium">{rule.antiCrawlConfig.maxDelay}ms</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* AgentQL Queries */}
        {rule.agentqlQueries && Object.keys(rule.agentqlQueries).some((k) => rule.agentqlQueries?.[k as keyof typeof rule.agentqlQueries]) && (
          <Collapsible open={agentqlOpen} onOpenChange={setAgentqlOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="w-full justify-between gap-2">
                <span className="flex items-center gap-2 text-xs">
                  <Brain className="h-3.5 w-3.5 text-primary" />
                  AgentQL 自然语言查询
                </span>
                {agentqlOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 space-y-1.5">
              {Object.entries(rule.agentqlQueries).map(([key, val]) =>
                val ? (
                  <div
                    key={key}
                    className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2"
                  >
                    <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5 mt-0.5">
                      {key}
                    </Badge>
                    <p className="text-xs text-foreground/70 italic">{val}</p>
                  </div>
                ) : null,
              )}
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* AI Notes */}
        {rule.notes && rule.notes.length > 0 && (
          <Collapsible open={notesOpen} onOpenChange={setNotesOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="w-full justify-between gap-2">
                <span className="flex items-center gap-2 text-xs">
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  AI 分析备注 ({rule.notes.length})
                </span>
                {notesOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
                {rule.notes.map((note, i) => (
                  <p key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                    <span className="shrink-0 text-[10px] font-bold text-muted-foreground/60 mt-px">
                      {i + 1}.
                    </span>
                    {note}
                  </p>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </ScrollArea>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Component
// ═══════════════════════════════════════════════════════════════════════════════

export function AiRuleAssistant({
  open,
  onOpenChange,
  onApplyRule,
}: AiRuleAssistantProps) {
  const [step, setStep] = useState<Step>('input');
  const [url, setUrl] = useState('');
  const [siteType, setSiteType] = useState<string>('');
  const [generatedRule, setGeneratedRule] = useState<GeneratedRule | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setStep('input');
      setError(null);
      setGeneratedRule(null);
    }
  }, [open]);

  // ═══════════════════════════════════════════════════════════════════════
  // Generate rule via AI
  // ═══════════════════════════════════════════════════════════════════════
  const handleGenerate = useCallback(async () => {
    if (!url.trim()) {
      toast.error('请输入目标 URL');
      return;
    }

    setGenerating(true);
    setError(null);
    setStep('analyzing');

    try {
      const response = await fetch('/api/scrape-rules/ai-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          siteType: siteType || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `请求失败 (${response.status})`);
      }

      const data = await response.json();
      setGeneratedRule(data as GeneratedRule);
      setStep('result');
      toast.success('AI 规则生成成功');
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'AI 规则生成失败';
      setError(message);
      setStep('input');
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  }, [url, siteType]);

  // ═══════════════════════════════════════════════════════════════════════
  // Apply generated rule
  // ═══════════════════════════════════════════════════════════════════════
  const handleApply = useCallback(() => {
    if (!generatedRule) return;
    onApplyRule(generatedRule);
    onOpenChange(false);
    toast.success('规则已应用到编辑器');
  }, [generatedRule, onApplyRule, onOpenChange]);

  // ═══════════════════════════════════════════════════════════════════════
  // Regenerate
  // ═══════════════════════════════════════════════════════════════════════
  const handleRegenerate = useCallback(() => {
    setGeneratedRule(null);
    handleGenerate();
  }, [handleGenerate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0">
        {/* Header */}
        <div className="flex flex-col gap-3 border-b px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-base">
                  AI 智能规则生成
                </DialogTitle>
                <DialogDescription className="text-xs">
                  输入目标网站 URL，AI 自动分析页面结构并生成采集规则
                </DialogDescription>
              </div>
            </div>
            <StepIndicator currentStep={step} />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* Step 1: Input */}
          {step === 'input' && (
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
                    onChange={(e) => setUrl(e.target.value)}
                    className="text-sm pl-4 pr-4 h-11"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleGenerate();
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
                      className={`relative flex flex-col items-center gap-2 rounded-xl border-2 px-4 py-4 transition-all hover:bg-muted/40 ${
                        siteType === type.value
                          ? 'border-primary bg-primary/5 text-primary'
                          : 'border-border'
                      }`}
                      onClick={() =>
                        setSiteType(siteType === type.value ? '' : type.value)
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
                  onClick={handleGenerate}
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
          )}

          {/* Step 2: Analyzing */}
          {step === 'analyzing' && <AnalyzingView url={url} />}

          {/* Step 3: Result */}
          {step === 'result' && generatedRule && (
            <div className="h-full px-6 py-4">
              <ResultView
                rule={generatedRule}
                onApply={handleApply}
                onRegenerate={handleRegenerate}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-6 py-3 bg-muted/20">
          <div className="flex items-center gap-2">
            {step === 'result' && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={generating}
                  className="gap-1.5"
                >
                  {generating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  重新生成
                </Button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
            {step === 'result' && generatedRule && (
              <Button
                size="sm"
                onClick={handleApply}
                className="gap-1.5"
              >
                <Check className="h-3.5 w-3.5" />
                应用规则
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
