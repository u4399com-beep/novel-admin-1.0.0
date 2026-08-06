'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Languages, ArrowRightLeft, Copy, Check, Sparkles } from 'lucide-react';

interface TranslatePanelProps {
  content: string;
  sourceLang?: string;
  className?: string;
  onClose?: () => void;
}

interface Language {
  code: string;
  name: string;
}

const DEFAULT_LANGUAGES: Language[] = [
  { code: 'zh', name: '中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'ru', name: 'Русский' },
];

export function TranslatePanel({ content, sourceLang, className, onClose }: TranslatePanelProps) {
  const [languages, setLanguages] = useState<Language[]>(DEFAULT_LANGUAGES);
  const [source, setSource] = useState(sourceLang || 'auto');
  const [target, setTarget] = useState('zh');
  const [translatedText, setTranslatedText] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('translation-settings');
    if (saved) {
      try {
        const settings = JSON.parse(saved);
        if (settings.defaultTargetLang) {
          queueMicrotask(() => setTarget(settings.defaultTargetLang));
        }
      } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    fetch('/api/translate/languages')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setLanguages(data);
        }
      })
      .catch(() => { /* use defaults */ });
  }, []);

  const handleTranslate = useCallback(async () => {
    if (!content.trim()) return;
    setIsTranslating(true);
    setError('');
    setTranslatedText('');

    try {
      const effectiveSource = source === 'auto' ? await detectLanguage(content) : source;
      if (!effectiveSource) {
        setError('无法检测源语言，请手动选择');
        return;
      }

      const resp = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content, source: effectiveSource, target, format: 'text' }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `翻译失败 (${resp.status})`);
      }

      const data = await resp.json();
      setTranslatedText(data.translated_text || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '翻译请求失败');
    } finally {
      setIsTranslating(false);
    }
  }, [content, source, target]);

  const detectLanguage = async (text: string): Promise<string | null> => {
    try {
      const resp = await fetch('/api/translate/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 500) }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.detected_language || null;
      }
    } catch { /* ignore */ }
    return null;
  };

  const handleSwap = () => {
    if (source !== 'auto') {
      setSource(target);
      setTarget(source);
      setTranslatedText('');
    }
  };

  const handleCopy = async () => {
    if (!translatedText) return;
    await navigator.clipboard.writeText(translatedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDetect = async () => {
    if (!content.trim()) return;
    const detected = await detectLanguage(content);
    if (detected) {
      setSource(detected);
    }
  };

  const panelClass = [
    'border-amber-200/50 bg-amber-50/30 dark:border-amber-800/50 dark:bg-amber-950/10',
    className || '',
  ].filter(Boolean).join(' ');

  return (
    <Card className={panelClass}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-amber-500" />
            翻译面板
          </CardTitle>
          <div className="flex items-center gap-1">
            {onClose && (
              <Button variant="ghost" size="sm" onClick={onClose} className="h-7 text-xs">
                关闭
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Language selectors */}
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="源语言" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  <span className="flex items-center gap-1.5">
                    <Languages className="h-3 w-3" />
                    自动检测
                  </span>
                </SelectItem>
                {languages.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label="交换语言"
            onClick={handleSwap}
            title="交换语言"
            disabled={source === 'auto'}
          >
            <ArrowRightLeft className="h-3.5 w-3.5" />
          </Button>

          <div className="flex-1">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="目标语言" />
              </SelectTrigger>
              <SelectContent>
                {languages.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-8 bg-amber-500 hover:bg-amber-600 text-white"
            onClick={handleTranslate}
            disabled={isTranslating || !content.trim()}
          >
            {isTranslating ? (
              <><Loader2 className="mr-1.5 h-3 w-3 animate-spin" />翻译中...</>
            ) : (
              <><Languages className="mr-1.5 h-3 w-3" />翻译</>
            )}
          </Button>

          {source === 'auto' && (
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleDetect}>
              检测语言
            </Button>
          )}

          {translatedText && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs ml-auto"
              onClick={handleCopy}
            >
              {copied ? <><Check className="mr-1 h-3 w-3" />已复制</> : <><Copy className="mr-1 h-3 w-3" />复制</>}
            </Button>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Translated result - side by side on desktop, stacked on mobile */}
        {translatedText && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">原文</p>
              <div className="max-h-64 overflow-y-auto rounded-md border bg-background p-3 text-sm leading-relaxed scrollbar-thin">
                {content.slice(0, 5000)}
                {content.length > 5000 && <span className="text-muted-foreground">...</span>}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wider">译文</p>
              <div className="max-h-64 overflow-y-auto rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-sm leading-relaxed scrollbar-thin">
                {translatedText}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
