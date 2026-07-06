'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Palette,
  Plus,
  Eye,
  Pencil,
  Trash2,
  Star,
  Download,
  Loader2,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/stores/app-store';
import type { Theme, ThemeConfig } from '@/types';

// ─── Pre-built Theme Configs ──────────────────────────────────────────────────

const PREBUILT_THEMES: (Omit<ThemeConfig, 'seo' | 'geo'> & {
  name: string;
  identifier: string;
  description: string;
  seo: ThemeConfig['seo'];
  geo: ThemeConfig['geo'];
})[] = [
  {
    name: '极简白',
    identifier: 'minimal-white',
    description: '干净纯粹的白色主题，细线条边框，大量留白，无彩色搭配，专注阅读体验',
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
      sidebarPosition: 'left',
      cardStyle: 'flat',
      headerStyle: 'static',
      gridColumns: 4,
    },
    typography: {
      headingFont: 'sans',
      bodyFont: 'sans',
      headingWeight: 700,
      lineHeight: 1.75,
    },
    seo: {
      defaultTitle: '极简小说',
      titleTemplate: '{title} - {siteName}',
      defaultDescription: '简洁干净的在线小说阅读平台，沉浸式阅读体验',
      defaultKeywords: '小说,在线阅读,极简',
    },
    geo: {
      region: 'CN',
      placename: '中国',
      position: '39.9042,116.4074',
    },
  },
  {
    name: '墨绿夜',
    identifier: 'dark-emerald',
    description: '深邃暗色背景搭配翡翠绿点缀，自然静谧的夜间阅读氛围',
    colors: {
      primary: '#10b981',
      secondary: '#059669',
      accent: '#34d399',
      background: '#0f1a15',
      foreground: '#e2e8e0',
      card: '#152420',
      cardForeground: '#d1ddd8',
      muted: '#1a2e26',
      mutedForeground: '#6b8f80',
      border: '#1e3a2f',
      ring: '#10b981',
    },
    layout: {
      maxWidth: '1200px',
      sidebarPosition: 'left',
      cardStyle: 'bordered',
      headerStyle: 'fixed',
      gridColumns: 3,
    },
    typography: {
      headingFont: 'sans',
      bodyFont: 'sans',
      headingWeight: 800,
      lineHeight: 1.75,
    },
    seo: {
      defaultTitle: '墨绿小说',
      titleTemplate: '{title} - {siteName}',
      defaultDescription: '深色护眼在线小说阅读，翡翠绿主题，夜间最佳选择',
      defaultKeywords: '小说,暗色主题,护眼,夜间阅读',
    },
    geo: {
      region: 'CN',
      placename: '中国',
      position: '39.9042,116.4074',
    },
  },
  {
    name: '暖橘阳',
    identifier: 'warm-sunset',
    description: '温暖色调的日落主题，橘色主调配合奶油色背景，柔和圆润的视觉体验',
    colors: {
      primary: '#f97316',
      secondary: '#fb923c',
      accent: '#ea580c',
      background: '#fffbf5',
      foreground: '#1c1917',
      card: '#fff7ed',
      cardForeground: '#292524',
      muted: '#fff1e0',
      mutedForeground: '#a8a29e',
      border: '#fed7aa',
      ring: '#f97316',
    },
    layout: {
      maxWidth: '1200px',
      sidebarPosition: 'left',
      cardStyle: 'rounded',
      headerStyle: 'static',
      gridColumns: 3,
    },
    typography: {
      headingFont: 'sans',
      bodyFont: 'sans',
      headingWeight: 700,
      lineHeight: 1.6,
    },
    seo: {
      defaultTitle: '暖橘小说',
      titleTemplate: '{title} - {siteName}',
      defaultDescription: '温暖舒适的在线小说阅读平台，橙色暖调设计',
      defaultKeywords: '小说,暖色,阅读,舒适',
    },
    geo: {
      region: 'CN',
      placename: '中国',
      position: '39.9042,116.4074',
    },
  },
  {
    name: '赛博蓝',
    identifier: 'cyber-neon',
    description: '科技感十足的赛博朋克风格，霓虹蓝与粉色双色调，发光边框效果',
    colors: {
      primary: '#06b6d4',
      secondary: '#ec4899',
      accent: '#8b5cf6',
      background: '#0a0a1a',
      foreground: '#e0e7ff',
      card: '#111133',
      cardForeground: '#c7d2fe',
      muted: '#1a1a3e',
      mutedForeground: '#7c7c9a',
      border: '#2a2a5e',
      ring: '#06b6d4',
    },
    layout: {
      maxWidth: '1200px',
      sidebarPosition: 'left',
      cardStyle: 'elevated',
      headerStyle: 'fixed',
      gridColumns: 3,
    },
    typography: {
      headingFont: 'mono',
      bodyFont: 'sans',
      headingWeight: 800,
      lineHeight: 1.5,
    },
    seo: {
      defaultTitle: '赛博小说',
      titleTemplate: '{title} | {siteName}',
      defaultDescription: '赛博朋克风格在线小说平台，科技感阅读体验',
      defaultKeywords: '小说,赛博朋克,科技,霓虹',
    },
    geo: {
      region: 'CN',
      placename: '中国',
      position: '39.9042,116.4074',
    },
  },
  {
    name: '古典红',
    identifier: 'classic-red',
    description: '中国古典美学风格，红色与金色搭配，羊皮纸质感背景，传统装饰边框',
    colors: {
      primary: '#dc2626',
      secondary: '#ca8a04',
      accent: '#b91c1c',
      background: '#fdf6e3',
      foreground: '#1c1917',
      card: '#fef3c7',
      cardForeground: '#292524',
      muted: '#fef9ee',
      mutedForeground: '#92773a',
      border: '#d4a853',
      ring: '#dc2626',
    },
    layout: {
      maxWidth: '1100px',
      sidebarPosition: 'left',
      cardStyle: 'bordered',
      headerStyle: 'static',
      gridColumns: 3,
    },
    typography: {
      headingFont: 'serif',
      bodyFont: 'serif',
      headingWeight: 700,
      lineHeight: 1.75,
    },
    seo: {
      defaultTitle: '古典小说阁',
      titleTemplate: '{title} - {siteName}',
      defaultDescription: '中国古典风格在线小说平台，传承文学之美',
      defaultKeywords: '小说,古典,传统文学,阅读',
    },
    geo: {
      region: 'CN',
      placename: '中国',
      position: '39.9042,116.4074',
    },
  },
];

// ─── Theme Preview Card (inline styled) ────────────────────────────────────────

function ThemePreviewCard({ config, name }: { config: ThemeConfig; name: string }) {
  const { colors, typography, layout } = config;
  const headingFont = typography.headingFont === 'serif' ? 'Georgia, "Times New Roman", serif'
    : typography.headingFont === 'mono' ? '"Courier New", monospace'
    : 'system-ui, -apple-system, sans-serif';
  const bodyFont = typography.bodyFont === 'serif' ? 'Georgia, "Times New Roman", serif'
    : typography.bodyFont === 'mono' ? '"Courier New", monospace'
    : 'system-ui, -apple-system, sans-serif';

  const cardRadius = layout.cardStyle === 'rounded' ? '16px'
    : layout.cardStyle === 'flat' ? '0px'
    : layout.cardStyle === 'bordered' ? '4px'
    : '12px';
  const cardBorder = layout.cardStyle === 'bordered' ? `1px solid ${colors.border}` : 'none';
  const cardShadow = layout.cardStyle === 'elevated' ? '0 4px 20px rgba(0,0,0,0.3)' : 'none';

  return (
    <div
      style={{
        background: colors.background,
        borderRadius: '8px',
        padding: '16px',
        overflow: 'hidden',
      }}
    >
      {/* Mini header */}
      <div
        style={{
          background: colors.primary,
          borderRadius: '4px',
          padding: '6px 12px',
          marginBottom: '10px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ color: '#fff', fontSize: '11px', fontWeight: 600, fontFamily: headingFont }}>
          {name}
        </span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <div style={{ width: 16, height: 16, borderRadius: '50%', background: colors.secondary }} />
          <div style={{ width: 16, height: 16, borderRadius: '50%', background: colors.accent }} />
        </div>
      </div>
      {/* Mini cards grid */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.gridColumns}, 1fr)`, gap: '6px' }}>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              background: colors.card,
              borderRadius: cardRadius,
              border: cardBorder,
              boxShadow: cardShadow,
              padding: '8px',
              minHeight: '50px',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '8px',
                borderRadius: '4px',
                background: colors.muted,
                marginBottom: '4px',
              }}
            />
            <div
              style={{
                width: `${70 - i * 10}%`,
                height: '6px',
                borderRadius: '3px',
                background: colors.border,
              }}
            />
            <p
              style={{
                color: colors.mutedForeground,
                fontSize: '8px',
                fontFamily: bodyFont,
                lineHeight: 1.4,
                marginTop: '4px',
              }}
            >
              样本文本示例...
            </p>
          </div>
        ))}
      </div>
      {/* Mini text */}
      <div style={{ marginTop: '8px' }}>
        <p
          style={{
            color: colors.foreground,
            fontSize: '10px',
            fontWeight: typography.headingWeight,
            fontFamily: headingFont,
            marginBottom: '2px',
          }}
        >
          标题文字样式
        </p>
        <p
          style={{
            color: colors.mutedForeground,
            fontSize: '8px',
            fontFamily: bodyFont,
            lineHeight: typography.lineHeight,
          }}
        >
          正文内容示例，展示当前主题的排版效果与配色方案
        </p>
      </div>
      {/* Color swatches */}
      <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
        {Object.values(colors).slice(0, 6).map((c, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: '12px',
              borderRadius: '3px',
              background: c,
              border: `1px solid ${colors.border}`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Theme Form Dialog ────────────────────────────────────────────────────────

function ThemeFormDialog({
  open,
  onOpenChange,
  editingTheme,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingTheme: Theme | null;
  onSaved: () => void;
}) {
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
        ? JSON.parse(editingTheme.config) as ThemeConfig
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
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim() || null,
          identifier: form.identifier.trim(),
          config: form.config,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '操作失败');
      }
      toast.success(editingTheme ? '主题已更新' : '主题已创建');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setLoading(false);
    }
  };

  const updateColor = (key: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        colors: { ...prev.config.colors, [key]: value },
      },
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingTheme ? '编辑主题' : '创建主题'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>主题名称 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="输入主题名称"
              />
            </div>
            <div className="space-y-2">
              <Label>标识符 *</Label>
              <Input
                value={form.identifier}
                onChange={(e) => setForm((p) => ({ ...p, identifier: e.target.value }))}
                placeholder="如: my-theme"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>描述</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="主题描述"
              rows={2}
            />
          </div>

          {/* Colors */}
          <div>
            <Label className="text-sm font-semibold mb-3 block">配色方案</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                ['primary', '主色'],
                ['secondary', '次色'],
                ['accent', '强调色'],
                ['background', '背景色'],
                ['foreground', '前景色'],
                ['card', '卡片色'],
                ['cardForeground', '卡片文字'],
                ['muted', '柔和背景'],
                ['mutedForeground', '柔和文字'],
                ['border', '边框色'],
                ['ring', '聚焦色'],
              ].map(([key, label]) => (
                <div key={key} className="flex items-center gap-2">
                  <input
                    type="color"
                    value={form.config.colors[key as keyof typeof form.config.colors]}
                    onChange={(e) => updateColor(key, e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border"
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <span className="text-[10px] text-muted-foreground/60 font-mono truncate">
                      {form.config.colors[key as keyof typeof form.config.colors]}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Layout */}
          <div>
            <Label className="text-sm font-semibold mb-3 block">布局设置</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">卡片样式</Label>
                <Select
                  value={form.config.layout.cardStyle}
                  onValueChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      config: {
                        ...p.config,
                        layout: { ...p.config.layout, cardStyle: v as ThemeConfig['layout']['cardStyle'] },
                      },
                    }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rounded">圆角</SelectItem>
                    <SelectItem value="flat">扁平</SelectItem>
                    <SelectItem value="elevated">悬浮</SelectItem>
                    <SelectItem value="bordered">边框</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">头部样式</Label>
                <Select
                  value={form.config.layout.headerStyle}
                  onValueChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      config: {
                        ...p.config,
                        layout: { ...p.config.layout, headerStyle: v as 'fixed' | 'static' },
                      },
                    }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">固定</SelectItem>
                    <SelectItem value="static">静态</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">网格列数</Label>
                <Select
                  value={String(form.config.layout.gridColumns)}
                  onValueChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      config: {
                        ...p.config,
                        layout: { ...p.config.layout, gridColumns: Number(v) as 3 | 4 },
                      },
                    }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">3 列</SelectItem>
                    <SelectItem value="4">4 列</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Typography */}
          <div>
            <Label className="text-sm font-semibold mb-3 block">排版设置</Label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">标题字体</Label>
                <Select
                  value={form.config.typography.headingFont}
                  onValueChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      config: {
                        ...p.config,
                        typography: {
                          ...p.config.typography,
                          headingFont: v as 'sans' | 'serif' | 'mono',
                        },
                      },
                    }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sans">无衬线</SelectItem>
                    <SelectItem value="serif">衬线</SelectItem>
                    <SelectItem value="mono">等宽</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">正文字体</Label>
                <Select
                  value={form.config.typography.bodyFont}
                  onValueChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      config: {
                        ...p.config,
                        typography: {
                          ...p.config.typography,
                          bodyFont: v as 'sans' | 'serif' | 'mono',
                        },
                      },
                    }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sans">无衬线</SelectItem>
                    <SelectItem value="serif">衬线</SelectItem>
                    <SelectItem value="mono">等宽</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">标题字重</Label>
                <Select
                  value={String(form.config.typography.headingWeight)}
                  onValueChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      config: {
                        ...p.config,
                        typography: {
                          ...p.config.typography,
                          headingWeight: Number(v) as 700 | 800,
                        },
                      },
                    }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="700">700 Bold</SelectItem>
                    <SelectItem value="800">800 ExtraBold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">行高</Label>
                <Select
                  value={String(form.config.typography.lineHeight)}
                  onValueChange={(v) =>
                    setForm((p) => ({
                      ...p,
                      config: {
                        ...p.config,
                        typography: {
                          ...p.config.typography,
                          lineHeight: Number(v) as 1.5 | 1.6 | 1.75,
                        },
                      },
                    }))
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1.5">1.5 紧凑</SelectItem>
                    <SelectItem value="1.6">1.6 适中</SelectItem>
                    <SelectItem value="1.75">1.75 宽松</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* SEO */}
          <div>
            <Label className="text-sm font-semibold mb-3 block">SEO 配置</Label>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">默认标题</Label>
                  <Input
                    value={form.config.seo.defaultTitle}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        config: { ...p.config, seo: { ...p.config.seo, defaultTitle: e.target.value } },
                      }))
                    }
                    placeholder="站点默认标题"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">标题模板</Label>
                  <Input
                    value={form.config.seo.titleTemplate}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        config: { ...p.config, seo: { ...p.config.seo, titleTemplate: e.target.value } },
                      }))
                    }
                    placeholder="{title} - {siteName}"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">默认描述</Label>
                <Textarea
                  value={form.config.seo.defaultDescription}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      config: { ...p.config, seo: { ...p.config.seo, defaultDescription: e.target.value } },
                    }))
                  }
                  placeholder="站点默认描述"
                  rows={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">默认关键词</Label>
                <Input
                  value={form.config.seo.defaultKeywords}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      config: { ...p.config, seo: { ...p.config.seo, defaultKeywords: e.target.value } },
                    }))
                  }
                  placeholder="关键词1,关键词2"
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editingTheme ? '保存修改' : '创建主题'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Preview Dialog ────────────────────────────────────────────────────────────

function ThemePreviewDialog({
  open,
  onOpenChange,
  themeConfig,
  themeName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  themeConfig: ThemeConfig;
  themeName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>主题预览 — {themeName}</DialogTitle>
        </DialogHeader>
        <ThemePreviewCard config={themeConfig} name={themeName} />
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Theme Manager View ───────────────────────────────────────────────────

export function ThemeManagerView() {
  const [themes, setThemes] = useState<(Theme & { _count?: { sites: number } })[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editTheme, setEditTheme] = useState<Theme | null>(null);
  const [previewTheme, setPreviewTheme] = useState<{ config: ThemeConfig; name: string } | null>(null);
  const refreshThemes = useAppStore((s) => s.refreshThemes);

  const fetchThemes = useCallback(async () => {
    try {
      const res = await fetch('/api/themes');
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setThemes(
        data.map((t: Theme & { config: string; _count?: { sites: number } }) => ({
          ...t,
          config: typeof t.config === 'string' ? JSON.parse(t.config) : t.config,
        }))
      );
    } catch {
      toast.error('获取主题列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchThemes();
  }, [fetchThemes, refreshThemes]);

  const handleSeed = async () => {
    setSeeding(true);
    try {
      for (const t of PREBUILT_THEMES) {
        const { name, identifier, description, seo, geo, ...rest } = t;
        const config: ThemeConfig = { ...rest, seo, geo };
        await fetch('/api/themes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, identifier, description, config }),
        }).catch(() => {});
      }
      toast.success('预设主题已导入');
      fetchThemes();
    } catch {
      toast.error('导入失败');
    } finally {
      setSeeding(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/themes/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('主题已删除');
      setDeleteId(null);
      fetchThemes();
    } catch {
      toast.error('删除失败');
    }
  };

  const getThemeConfig = (theme: Theme & { config: string | ThemeConfig }): ThemeConfig => {
    return typeof theme.config === 'string' ? JSON.parse(theme.config) : theme.config;
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
          <Button
            size="sm"
            onClick={() => setEditTheme(null)}
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
          <Palette className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
          <h4 className="text-base font-medium text-muted-foreground mb-2">暂无主题</h4>
          <p className="text-sm text-muted-foreground/70 mb-6">
            点击「导入预设主题」快速加载 5 个精心设计的主题方案，或手动创建自定义主题
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" onClick={handleSeed} disabled={seeding}>
              {seeding ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
              导入预设主题
            </Button>
            <Button onClick={() => setEditTheme(null)}>
              <Plus className="h-4 w-4 mr-1.5" />
              创建主题
            </Button>
          </div>
        </Card>
      )}

      {/* Theme Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        <AnimatePresence mode="popLayout">
          {themes.map((theme) => {
            const config = getThemeConfig(theme);
            const siteCount = theme._count?.sites ?? 0;

            return (
              <motion.div
                key={theme.id}
                layout
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                <Card className="overflow-hidden group hover:shadow-lg transition-shadow duration-300">
                  <CardContent className="p-0">
                    {/* Preview */}
                    <div className="p-4 pb-3">
                      <ThemePreviewCard config={config} name={theme.name} />
                    </div>

                    {/* Info */}
                    <div className="px-4 pb-2">
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <h4 className="font-semibold text-sm leading-tight">{theme.name}</h4>
                        <Badge variant="secondary" className="text-[10px] shrink-0">
                          {theme.identifier}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                        {theme.description || '暂无描述'}
                      </p>
                      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Star className="h-3 w-3" />
                          {siteCount} 个站点使用
                        </span>
                        <span
                          className="inline-block w-3 h-3 rounded-full border"
                          style={{ background: config.colors.primary, borderColor: config.colors.border }}
                        />
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center border-t divide-x">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 h-9 rounded-none text-xs gap-1"
                        onClick={() => setPreviewTheme({ config, name: theme.name })}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        预览
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 h-9 rounded-none text-xs gap-1"
                        onClick={() => setEditTheme(theme)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 h-9 rounded-none text-xs gap-1 text-destructive hover:text-destructive"
                        onClick={() => setDeleteId(theme.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

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
        open={editTheme !== null || false}
        onOpenChange={(open) => {
          if (!open) setEditTheme(null);
        }}
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
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除主题？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后使用该主题的站点将失去主题配置，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}