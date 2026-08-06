'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { tryParseJSON, defaultThemeConfig } from './helpers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ColorFieldGroup } from './form/ColorFieldGroup';
import { TypographyFieldGroup } from './form/TypographyFieldGroup';
import { LayoutFieldGroup } from './form/LayoutFieldGroup';
import type { Theme, ThemeConfig } from '@/types';

interface ThemeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingTheme: Theme | null;
  onSaved: () => void;
}

export function ThemeFormDialog({
  open,
  onOpenChange,
  editingTheme,
  onSaved,
}: ThemeFormDialogProps) {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    identifier: '',
    config: {
      colors: {
        primary: '#334155',
        secondary: '#64748b',
        accent: '#0f172a',
        background: '#ffffff',
        foreground: '#0f172a',
        card: '#ffffff',
        cardForeground: '#1e293b',
        muted: '#f1f5f9',
        mutedForeground: '#94a3b8',
        border: '#e2e8f0',
        ring: '#334155',
      },
      layout: {
        maxWidth: '1200px',
        sidebarPosition: 'left' as const,
        cardStyle: 'rounded' as const,
        headerStyle: 'static' as const,
        gridColumns: 3 as const,
      },
      typography: {
        headingFont: 'sans' as const,
        bodyFont: 'sans' as const,
        headingWeight: 700 as const,
        lineHeight: 1.6 as const,
      },
      seo: {
        defaultTitle: '',
        titleTemplate: '{title} - {siteName}',
        defaultDescription: '',
        defaultKeywords: '',
      },
      geo: {
        region: 'CN',
        placename: '中国',
        position: '39.9042,116.4074',
      },
    } as ThemeConfig,
  });

  useEffect(() => {
    if (editingTheme) {
      const cfg = typeof editingTheme.config === 'string'
        ? (tryParseJSON(editingTheme.config) as ThemeConfig ?? defaultThemeConfig())
        : editingTheme.config;
      setForm({
        name: editingTheme.name,
        description: editingTheme.description || '',
        identifier: editingTheme.identifier,
        config: cfg,
      });
    } else {
      setForm((prev) => ({ ...prev, name: '', description: '', identifier: '' }));
    }
  }, [editingTheme, open]);

  const handleSave = async () => {
    if (!form.name.trim() || !form.identifier.trim()) {
      toast.error('请填写主题名称和标识符');
      return;
    }
    setLoading(true);
    try {
      const url = editingTheme ? `/api/themes/${editingTheme.id}` : '/api/themes';
      const method = editingTheme ? 'PUT' : 'POST';
      await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim() || null,
          identifier: form.identifier.trim(),
          config: form.config,
        }),
      });
      toast.success(editingTheme ? '主题已更新' : '主题已创建');
      onOpenChange(false);
      onSaved();
    } catch { /* handled by apiFetch */ } finally {
      setLoading(false);
    }
  };

  const updateColor = (key: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      config: { ...prev.config, colors: { ...prev.config.colors, [key]: value } },
    }));
  };

  const updateTypography = (key: string, value: string | number) => {
    setForm((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        typography: { ...prev.config.typography, [key]: value } as ThemeConfig['typography'],
      },
    }));
  };

  const updateLayout = (key: string, value: string | number) => {
    setForm((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        layout: { ...prev.config.layout, [key]: value } as ThemeConfig['layout'],
      },
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingTheme ? '编辑主题' : '创建主题'}</DialogTitle>
          <DialogDescription className="sr-only">{editingTheme ? '编辑已有主题的配置' : '创建新的自定义主题'}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>主题名称 *</Label>
              <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="输入主题名称" />
            </div>
            <div className="space-y-2">
              <Label>标识符 *</Label>
              <Input value={form.identifier} onChange={(e) => setForm((p) => ({ ...p, identifier: e.target.value }))} placeholder="如: my-theme" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>描述</Label>
            <Textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} placeholder="主题描述" rows={2} />
          </div>

          <ColorFieldGroup colors={form.config.colors} onChange={updateColor} />
          <LayoutFieldGroup layout={form.config.layout} onUpdate={updateLayout} />
          <TypographyFieldGroup typography={form.config.typography} onUpdate={updateTypography} />

          {/* SEO */}
          <div>
            <Label className="text-sm font-semibold mb-3 block">SEO 配置</Label>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">默认标题</Label>
                  <Input
                    value={form.config.seo.defaultTitle}
                    onChange={(e) => setForm((p) => ({ ...p, config: { ...p.config, seo: { ...p.config.seo, defaultTitle: e.target.value } } }))}
                    placeholder="站点默认标题"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">标题模板</Label>
                  <Input
                    value={form.config.seo.titleTemplate}
                    onChange={(e) => setForm((p) => ({ ...p, config: { ...p.config, seo: { ...p.config.seo, titleTemplate: e.target.value } } }))}
                    placeholder="{title} - {siteName}"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">默认描述</Label>
                <Textarea
                  value={form.config.seo.defaultDescription}
                  onChange={(e) => setForm((p) => ({ ...p, config: { ...p.config, seo: { ...p.config.seo, defaultDescription: e.target.value } } }))}
                  placeholder="站点默认描述"
                  rows={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">默认关键词</Label>
                <Input
                  value={form.config.seo.defaultKeywords}
                  onChange={(e) => setForm((p) => ({ ...p, config: { ...p.config, seo: { ...p.config.seo, defaultKeywords: e.target.value } } }))}
                  placeholder="关键词1,关键词2"
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editingTheme ? '保存修改' : '创建主题'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
