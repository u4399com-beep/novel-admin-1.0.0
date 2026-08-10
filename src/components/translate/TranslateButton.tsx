'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Loader2, Languages, Copy, Check } from 'lucide-react';

interface TranslateButtonProps {
  content: string;
  sourceLang?: string;
  targetLang?: string;
  className?: string;
}

export function TranslateButton({ content, sourceLang, targetLang = 'zh', className }: TranslateButtonProps) {
  const [open, setOpen] = useState(false);
  const [translatedText, setTranslatedText] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleQuickTranslate = useCallback(async () => {
    if (!content.trim()) return;
    setIsTranslating(true);
    setError('');
    setTranslatedText('');

    try {
      const body: Record<string, string> = {
        text: content.slice(0, 10000),
        target: targetLang,
      };

      if (sourceLang && sourceLang !== 'auto') {
        body.source = sourceLang;
      } else {
        try {
          const detectData = await apiFetch<{detected_language: string}>('/api/translate/detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: content.slice(0, 500) }),
          });
          if (detectData.detected_language) {
            body.source = detectData.detected_language;
          }
        } catch { /* proceed */ }
        if (!body.source) body.source = 'en';
      }

      const data = await apiFetch<{translated_text: string}>('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setTranslatedText(data.translated_text || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '翻译请求失败');
    } finally {
      setIsTranslating(false);
    }
  }, [content, sourceLang, targetLang]);

  const handleCopy = async () => {
    if (!translatedText) return;
    await navigator.clipboard.writeText(translatedText);
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setTranslatedText(''); setError(''); } }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`h-8 w-8 text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30 ${className || ''}`}
          title="翻译"
          aria-label="翻译内容"
        >
          <Languages className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="end">
        {!translatedText && !error && !isTranslating && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">快速翻译为中文</p>
            <Button
              size="sm"
              className="w-full bg-amber-500 hover:bg-amber-600 text-white"
              onClick={handleQuickTranslate}
            >
              <Languages className="mr-1.5 h-3.5 w-3.5" />
              开始翻译
            </Button>
          </div>
        )}
        {isTranslating && (
          <div className="flex items-center justify-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
            <span className="text-sm text-muted-foreground">翻译中...</span>
          </div>
        )}
        {error && (
          <div className="rounded-md bg-destructive/5 border border-destructive/20 dark:border-red-800 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {translatedText && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wider">译文</span>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleCopy}>
                {copied ? <><Check className="mr-1 h-3 w-3" />已复制</> : <><Copy className="mr-1 h-3 w-3" />复制</>}
              </Button>
            </div>
            <div className="max-h-48 overflow-y-auto rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-2.5 text-sm leading-relaxed scrollbar-thin">
              {translatedText}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
