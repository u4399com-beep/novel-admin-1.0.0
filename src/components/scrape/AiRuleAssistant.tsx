'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import {
  Sparkles,
  Loader2,
  Check,
  RotateCcw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

import type { GeneratedRule, AiRuleAssistantProps, Step } from './ai-assistant/types';
export type { GeneratedRule } from './ai-assistant/types';

import { StepIndicator } from './ai-assistant/AiStatusIndicator';
import { AiAnalyzeForm } from './ai-assistant/AiAnalyzeForm';
import { AnalyzingView } from './ai-assistant/AiAnalyzingView';
import { ResultView } from './ai-assistant/AiSuggestionList';

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
  const abortRef = useRef<AbortController | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setStep('input');
      setError(null);
      setGeneratedRule(null);
    } else {
      abortRef.current?.abort();
    }
  }, [open]);

  // Abort on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // ═══════════════════════════════════════════════════════════════════════
  // Generate rule via AI
  // ═══════════════════════════════════════════════════════════════════════
  const handleGenerate = useCallback(async () => {
    if (!url.trim()) {
      toast.error('请输入目标 URL');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setGenerating(true);
    setError(null);
    setStep('analyzing');

    try {
      const data = await apiFetch<GeneratedRule>('/api/scrape-rules/ai-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          siteType: siteType || undefined,
        }),
        signal: controller.signal,
      });

      setGeneratedRule(data);
      setStep('result');
      toast.success('AI 规则生成成功');
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const message =
        err instanceof Error ? err.message : 'AI 规则生成失败';
      setError(message);
      setStep('input');
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
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
            <AiAnalyzeForm
              url={url}
              onUrlChange={setUrl}
              siteType={siteType}
              onSiteTypeChange={setSiteType}
              onGenerate={handleGenerate}
              generating={generating}
              error={error}
            />
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
