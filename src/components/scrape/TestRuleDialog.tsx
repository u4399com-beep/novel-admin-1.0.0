'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import {
  FlaskConical,
  Globe,
  Loader2,
  RotateCcw,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

import { TestRuleResults, type TestRuleResult } from './TestRuleResults';

// ==================== Types ====================

export interface TestRuleDialogRuleData {
  listUrl: string;
  engine: string;
  listSelector?: { type: string; value: string } | null;
}

interface TestRuleDialogProps {
  rule: TestRuleDialogRuleData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ==================== Engine Options ====================

const ENGINE_OPTIONS = [
  { value: 'cheerio', label: 'Cheerio' },
  { value: 'playwright', label: 'Playwright' },
  { value: 'obscura', label: 'Obscura' },
  { value: 'firecrawl', label: 'Firecrawl' },
  { value: 'agentql', label: 'AgentQL' },
] as const;

// ==================== Component ====================

export function TestRuleDialog({ rule, open, onOpenChange }: TestRuleDialogProps) {
  const [engine, setEngine] = useState(rule.engine || 'cheerio');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestRuleResult | null>(null);
  const [fetchPhase, setFetchPhase] = useState<'idle' | 'fetching' | 'done' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setEngine(rule.engine || 'cheerio');
      setResult(null);
      setFetchPhase('idle');
    } else {
      abortRef.current?.abort();
    }
  }, [open, rule.engine]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const handleTest = useCallback(async () => {
    if (!rule.listUrl?.trim()) {
      toast.error('请先填写目标 URL');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setTesting(true);
    setFetchPhase('fetching');
    setResult(null);

    try {
      const data = await apiFetch<TestRuleResult>('/api/scrape-rules/test-rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: rule.listUrl.trim(),
          engine,
          listSelector: rule.listSelector?.value || null,
        }),
        signal: controller.signal,
        timeout: 60_000,
      });

      if (controller.signal.aborted) return;

      setResult(data);
      setFetchPhase('done');

      if (data.success) {
        toast.success('规则测试成功');
      } else {
        toast.error('规则测试失败');
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      setFetchPhase('error');
      // apiFetch already toasts, but we set a fallback result
      const message =
        err instanceof Error ? err.message : '测试请求失败';
      setResult({
        success: false,
        errorMessage: message,
      });
    } finally {
      if (!controller.signal.aborted) setTesting(false);
    }
  }, [rule.listUrl, rule.listSelector, engine]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0"
        aria-describedby="test-rule-description"
      >
        {/* Header */}
        <div className="flex flex-col gap-2 border-b px-6 py-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/20 to-violet-500/5">
              <FlaskConical className="h-5 w-5 text-violet-600 dark:text-violet-400" />
            </div>
            <div>
              <DialogTitle className="text-base">测试采集规则</DialogTitle>
              <DialogDescription id="test-rule-description" className="text-xs">
                向目标 URL 发送测试请求，验证规则配置是否正确
              </DialogDescription>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* Target URL (readonly) */}
          <div className="space-y-2" role="group" aria-label="目标地址">
            <Label htmlFor="test-url" className="text-xs font-medium">
              目标 URL
            </Label>
            <div className="relative">
              <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="test-url"
                value={rule.listUrl || ''}
                readOnly
                className="pl-9 bg-muted/50 dark:bg-muted/30 text-sm"
                placeholder="请先在编辑器中填写列表页 URL"
                aria-label="目标 URL (只读)"
              />
            </div>
          </div>

          {/* Engine Selector */}
          <div className="space-y-2" role="group" aria-label="引擎选择">
            <Label htmlFor="test-engine" className="text-xs font-medium">
              测试引擎
            </Label>
            <Select value={engine} onValueChange={setEngine} disabled={testing}>
              <SelectTrigger id="test-engine" className="w-full sm:w-[200px]" size="default">
                <Zap className="h-4 w-4 text-muted-foreground" />
                <SelectValue placeholder="选择引擎" />
              </SelectTrigger>
              <SelectContent>
                {ENGINE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Progress / Results Area */}
          <div className="min-h-[120px]" role="region" aria-label="测试结果区域" aria-live="polite">
            <AnimatePresence mode="wait">
              {/* Idle State */}
              {fetchPhase === 'idle' && !result && (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3"
                >
                  <div className="h-12 w-12 rounded-full bg-muted/50 dark:bg-muted/30 flex items-center justify-center">
                    <FlaskConical className="h-6 w-6 text-muted-foreground/50" />
                  </div>
                  <p className="text-sm">点击下方按钮开始测试</p>
                </motion.div>
              )}

              {/* Fetching State */}
              {fetchPhase === 'fetching' && (
                <motion.div
                  key="fetching"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.25 }}
                  className="flex flex-col items-center justify-center py-12 gap-4"
                >
                  <div className="relative">
                    <div className="h-12 w-12 rounded-full border-2 border-muted-foreground/20" />
                    <Loader2 className="absolute inset-0 h-12 w-12 animate-spin text-primary" />
                  </div>
                  <div className="space-y-1 text-center">
                    <p className="text-sm font-medium">正在测试...</p>
                    <p className="text-xs text-muted-foreground">
                      向 {rule.listUrl} 发送请求
                    </p>
                  </div>
                  {/* Skeleton Preview */}
                  <div className="w-full space-y-2 mt-2 px-4">
                    <div className="flex gap-2">
                      <Skeleton className="h-9 flex-1 rounded-lg" />
                      <Skeleton className="h-9 flex-1 rounded-lg" />
                      <Skeleton className="h-9 flex-1 rounded-lg" />
                    </div>
                    <div className="flex gap-2">
                      <Skeleton className="h-9 flex-1 rounded-lg" />
                      <Skeleton className="h-9 flex-1 rounded-lg" />
                      <Skeleton className="h-9 flex-1 rounded-lg" />
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Done / Error State */}
              {(fetchPhase === 'done' || fetchPhase === 'error') && result && (
                <motion.div
                  key="result"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                  <TestRuleResults result={result} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Footer - Sticky */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-3 bg-muted/20 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          <Button
            size="sm"
            onClick={handleTest}
            disabled={testing || !rule.listUrl?.trim()}
            className="gap-1.5"
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : fetchPhase !== 'idle' ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
            {fetchPhase !== 'idle' ? '再次测试' : '开始测试'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
