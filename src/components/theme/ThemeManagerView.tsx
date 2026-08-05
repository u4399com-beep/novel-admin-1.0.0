'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Palette,
  Plus,
  Download,
  Upload,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { useAppStore } from '@/stores/app-store';
import { PREBUILT_THEMES } from '@/lib/prebuilt-themes';
import { tryParseJSON, defaultThemeConfig } from './manager/helpers';
import { ThemeFormDialog } from './manager/ThemeFormDialog';
import { ThemePreviewDialog } from './manager/ThemePreviewDialog';
import { ThemeCardGrid } from './manager/ThemeCardGrid';
import type { Theme, ThemeConfig } from '@/types';


export default function ThemeManagerView() {
  const [themes, setThemes] = useState<(Theme & { _count?: { sites: number } })[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editTheme, setEditTheme] = useState<Theme | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<{ config: ThemeConfig; name: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const refreshThemes = useAppStore((s) => s.refreshVersions['themes'] ?? 0);

  const fetchThemes = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<(Theme & { config: string; _count?: { sites: number } })[]>('/api/themes', { signal });
      if (signal?.aborted) return;
      setThemes(
        data.map((t) => ({
          ...t,
          config: (typeof t.config === 'string' ? (tryParseJSON(t.config) ?? defaultThemeConfig()) : t.config) as ThemeConfig,
        }))
      );
    } catch {
      if (signal?.aborted) return;
      /* handled by apiFetch */
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchThemes(ac.signal);
    return () => ac.abort();
  }, [fetchThemes, refreshThemes]);

  const handleSeed = async () => {
    setSeeding(true);
    try {
      const results = await Promise.allSettled(
        PREBUILT_THEMES.map((t) => {
          const { name, identifier, description, seo, geo, ...rest } = t;
          const config: ThemeConfig = { ...rest, seo, geo };
          return apiFetch('/api/themes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, identifier, description, config }),
          });
        })
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      const okCount = results.filter((r) => r.status === 'fulfilled').length;
      if (failed > 0) {
        toast.warning(`成功导入 ${okCount} 个主题，${failed} 个已存在或失败`);
      } else {
        toast.success(`预设主题已导入（${okCount} 个）`);
      }
      fetchThemes();
    } finally {
      setSeeding(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/themes/${deleteId}`, { method: 'DELETE' });
      toast.success('主题已删除');
      setDeleteId(null);
      fetchThemes();
    } catch { /* handled by apiFetch */ } finally {
      setDeleting(false);
    }
  };

  const getThemeConfig = (theme: Theme & { config: string | ThemeConfig }): ThemeConfig => {
    return typeof theme.config === 'string' ? ((tryParseJSON(theme.config) as ThemeConfig) ?? defaultThemeConfig()) : theme.config;
  };

  // ─── Export theme ────────────────────────────────────────
  const handleExport = (theme: Theme & { config: string | ThemeConfig }) => {
    const config = getThemeConfig(theme);
    const exportData = {
      name: theme.name,
      description: theme.description || '',
      identifier: theme.identifier,
      config,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `theme-${theme.identifier}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`已导出主题「${theme.name}」`);
  };

  // ─── Import theme ────────────────────────────────────────
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = tryParseJSON(text) as Record<string, unknown> | undefined;
      if (!data || typeof data.name !== 'string' || !data.name.trim()) {
        toast.error('无效的主题文件：缺少主题名称');
        return;
      }
      const name = String(data.name).trim();
      const description = typeof data.description === 'string' ? String(data.description).trim() : '';
      const identifier = typeof data.identifier === 'string' ? String(data.identifier).trim() : `imported-${Date.now()}`;
      let config: ThemeConfig = defaultThemeConfig();
      if (data.config && typeof data.config === 'object') {
        const configObj = data.config as Record<string, unknown>;
        config = { ...defaultThemeConfig(), ...(configObj as Partial<ThemeConfig>) };
        if (configObj.colors && typeof configObj.colors === 'object') {
          config.colors = { ...defaultThemeConfig().colors, ...(configObj.colors as Partial<ThemeConfig['colors']>) };
        }
      }
      await apiFetch('/api/themes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || null, identifier, config }),
      });
      toast.success(`已导入主题「${name}」`);
      fetchThemes();
    } catch {
      toast.error('导入失败：文件格式不正确');
    }
    if (importInputRef.current) importInputRef.current.value = '';
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-64 flex-1" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">主题管理</h3>
          <p className="text-sm text-muted-foreground">
            管理站点外观主题，配置配色、布局和排版方案
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {themes.length === 0 && (
            <Button variant="outline" size="sm" onClick={handleSeed} disabled={seeding}>
              {seeding ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
              导入预设主题
            </Button>
          )}
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImport}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => importInputRef.current?.click()}
            className="gap-1.5"
          >
            <Upload className="h-4 w-4" />
            导入主题
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (themes.length > 0) handleExport(themes[0]);
            }}
            disabled={themes.length === 0}
            className="gap-1.5"
          >
            <Download className="h-4 w-4" />
            导出主题
          </Button>
          <Button
            size="sm"
            onClick={() => { setEditTheme(null); setFormOpen(true); }}
            className="gap-1.5"
          >
            <Plus className="h-4 w-4" />
            创建主题
          </Button>
        </div>
      </div>

      {/* Empty State */}
      {themes.length === 0 && (
        <Card className="p-12 text-center">
          <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-4">
            <Palette className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <h4 className="text-base font-medium text-muted-foreground mb-2">暂无主题配置</h4>
          <p className="text-sm text-muted-foreground/70 mb-6">
            点击「创建第一个主题」开始自定义站点外观，或导入预设主题快速上手
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" onClick={handleSeed} disabled={seeding}>
              {seeding ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
              导入预设主题
            </Button>
            <Button onClick={() => { setEditTheme(null); setFormOpen(true); }}>
              <Plus className="h-4 w-4 mr-1.5" />
              创建第一个主题
            </Button>
          </div>
        </Card>
      )}

      {/* Theme Grid */}
      <ThemeCardGrid
        themes={themes as any[]}
        onPreview={(config, name) => setPreviewTheme({ config, name })}
        onEdit={(theme) => { setEditTheme(theme); setFormOpen(true); }}
        onDelete={(id) => setDeleteId(id)}
      />

      {/* Pre-built themes info (when DB has themes) */}
      {themes.length > 0 && !PREBUILT_THEMES.every(
        (pt) => themes.some((t) => t.identifier === pt.identifier)
      ) && (
        <div className="text-center">
          <Button variant="link" size="sm" onClick={handleSeed} disabled={seeding}>
            {seeding ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
            补充导入缺失的预设主题
          </Button>
        </div>
      )}

      {/* Edit / Create Dialog */}
      <ThemeFormDialog
        open={formOpen}
        onOpenChange={(open) => { if (!open) { setFormOpen(false); setEditTheme(null); } }}
        editingTheme={editTheme}
        onSaved={fetchThemes}
      />

      {/* Preview Dialog */}
      {previewTheme && (
        <ThemePreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setPreviewTheme(null);
          }}
          themeConfig={previewTheme.config}
          themeName={previewTheme.name}
        />
      )}

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="确认删除主题？"
        description="删除后使用该主题的站点将失去主题配置，此操作不可撤销。"
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}