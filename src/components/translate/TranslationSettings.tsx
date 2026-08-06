'use client';

import { useState, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Languages } from 'lucide-react';

interface TranslationSettings {
  defaultTargetLang: string;
  autoTranslate: boolean;
  displayMode: 'panel' | 'inline' | 'tooltip';
}

const LANGUAGES = [
  { code: 'zh', name: '中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'ru', name: 'Русский' },
];

const STORAGE_KEY = 'translation-settings';

const DEFAULTS: TranslationSettings = {
  defaultTargetLang: 'zh',
  autoTranslate: false,
  displayMode: 'panel',
};

export function TranslationSettings() {
  const [settings, setSettings] = useState<TranslationSettings>(DEFAULTS);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        queueMicrotask(() => setSettings(parsed));
      }
    } catch { /* use defaults */ }
  }, []);

  const updateSetting = <K extends keyof TranslationSettings>(key: K, value: TranslationSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b">
        <Languages className="h-4 w-4 text-amber-500" />
        <h3 className="text-sm font-medium">翻译设置</h3>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm">默认目标语言</Label>
          <Select
            value={settings.defaultTargetLang}
            onValueChange={(v) => updateSetting('defaultTargetLang', v)}
          >
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  {lang.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">自动翻译</Label>
            <p className="text-[11px] text-muted-foreground">打开章节时自动翻译</p>
          </div>
          <Switch
            checked={settings.autoTranslate}
            onCheckedChange={(v) => updateSetting('autoTranslate', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">显示模式</Label>
            <p className="text-[11px] text-muted-foreground">翻译结果的展示方式</p>
          </div>
          <Select
            value={settings.displayMode}
            onValueChange={(v) => updateSetting('displayMode', v as TranslationSettings['displayMode'])}
          >
            <SelectTrigger className="w-24 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="panel">面板</SelectItem>
              <SelectItem value="inline">内联</SelectItem>
              <SelectItem value="tooltip">提示</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
