'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { Save, Download, Upload, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { GeneralSettings } from '@/components/admin/settings/GeneralSettings';
import { ScraperSettings } from '@/components/admin/settings/ScraperSettings';
import { SecuritySettings } from '@/components/admin/settings/SecuritySettings';

interface SiteSettings {
  siteName: string;
  siteDescription: string;
  itemsPerPage: string;
  scrapeInterval: number;
  concurrentTasks: number;
  autoPublish: boolean;
  defaultSort: string;
  themeColor: string;
  showWordCount: boolean;
}

const STORAGE_KEY = 'novel-pavilion-settings';

const DEFAULT_SETTINGS: SiteSettings = {
  siteName: '小说阁',
  siteDescription: '',
  itemsPerPage: '15',
  scrapeInterval: 30,
  concurrentTasks: 3,
  autoPublish: false,
  defaultSort: 'newest',
  themeColor: '#8b5cf6',
  showWordCount: true,
};

function loadLocalSettings(): SiteSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SiteSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch { /* ignore parse errors */ }
  return DEFAULT_SETTINGS;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SiteSettings>(loadLocalSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<Record<string, string>>('/api/admin/settings', { signal: controller.signal })
      .then((data) => {
        if (data && typeof data === 'object') {
          setSettings((prev) => {
            const merged = { ...prev };
            for (const [key, value] of Object.entries(data)) {
              if (key in prev) {
                const typedKey = key as keyof SiteSettings;
                const prevValue = prev[typedKey];
                if (typeof prevValue === 'boolean') {
                  (merged as Record<string, unknown>)[key] = value === 'true';
                } else if (typeof prevValue === 'number') {
                  (merged as Record<string, unknown>)[key] = Number(value) || prevValue;
                } else {
                  (merged as Record<string, unknown>)[key] = value;
                }
              }
            }
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); } catch { /* ignore */ }
            return merged;
          });
        }
      })
      .catch(() => { /* use localStorage fallback */ })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const update = useCallback((key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key as keyof SiteSettings]: value as SiteSettings[keyof SiteSettings] }));
  }, []);

  const saveSettings = useCallback(async () => {
    setSaving(true);
    try {
      await apiFetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      toast.success('设置已保存');
    } catch {
      toast.error('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const handleImportCategories = useCallback(async () => {
    try {
      await apiFetch('/api/public/seed-categories', { method: 'POST' });
      toast.success('分类导入成功');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '分类导入失败');
    }
  }, []);

  const handleClearCache = useCallback(async () => {
    try {
      if (typeof window !== 'undefined' && 'caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      toast.success('缓存已清空');
    } catch {
      toast.error('清空缓存失败');
    }
  }, []);

  const handleExportAll = useCallback(async () => {
    setExporting(true);
    try {
      // Use credentials: 'include' to send session cookies (same-origin).
      // Do NOT use manual Authorization header — NextAuth uses httpOnly cookies,
      // not localStorage tokens. The raw fetch is needed here because
      // apiFetch only handles JSON responses, not blob downloads.
      const response = await fetch('/api/admin/export-all', {
        credentials: 'include',
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `novel-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('数据导出成功');
    } catch {
      toast.error('导出数据失败，请重试');
    } finally {
      setExporting(false);
    }
  }, []);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
        <p className="font-medium mb-1">关于这些设置</p>
        <ul className="list-disc list-inside space-y-0.5 text-xs opacity-90">
          <li><b>站点名称</b>已在前台页面实时生效（侧栏标题、浏览器标签等）</li>
          <li><b>每页显示数量 / 默认排序 / 显示字数统计</b>已存储至数据库，供前台 API 调用</li>
          <li><b>采集间隔 / 并发数 / 自动发布</b>已存储至数据库，供 scraper-service 采集任务读取使用</li>
          <li>设置会同时保存到浏览器本地和服务器数据库，本地副本作为离线缓存和编辑回显</li>
        </ul>
      </div>

      <GeneralSettings
        siteName={settings.siteName}
        siteDescription={settings.siteDescription}
        itemsPerPage={settings.itemsPerPage}
        onUpdate={update}
      />

      <ScraperSettings
        scrapeInterval={settings.scrapeInterval}
        concurrentTasks={settings.concurrentTasks}
        autoPublish={settings.autoPublish}
        onUpdate={update}
      />

      <SecuritySettings
        defaultSort={settings.defaultSort}
        themeColor={settings.themeColor}
        showWordCount={settings.showWordCount}
        onUpdate={update}
      />

      <Card className="card-border-glow">
        <CardHeader>
          <CardTitle className="text-base settings-section-title">数据管理</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" disabled={exporting} onClick={handleExportAll} className="gap-1.5 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {exporting ? '正在导出...' : '导出所有数据'}
            </Button>
            <Button variant="outline" onClick={handleImportCategories} className="gap-1.5 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <Upload className="h-4 w-4" />
              导入分类
            </Button>
            <Button variant="outline" onClick={handleClearCache} className="gap-1.5 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <Trash2 className="h-4 w-4" />
              清空缓存
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={saveSettings} disabled={saving || loading} className="gap-2 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? '保存中...' : '保存设置'}
        </Button>
      </div>
    </div>
  );
}
