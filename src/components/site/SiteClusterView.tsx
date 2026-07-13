'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Globe,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Eye,
  Monitor,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { safeFormatDate } from '@/lib/format';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppStore } from '@/stores/app-store';
import type { Site, Theme, ThemeConfig, ThemeGeo } from '@/types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function tryParseJSON(str: string): unknown {
  try { return JSON.parse(str); } catch { return undefined; }
}

function defaultThemeConfig(): ThemeConfig {
  return {
    colors: { primary: '#334155', secondary: '#64748b', accent: '#0f172a', background: '#ffffff', foreground: '#0f172a', card: '#ffffff', cardForeground: '#1e293b', muted: '#f1f5f9', mutedForeground: '#94a3b8', border: '#e2e8f0', ring: '#334155' },
    layout: { maxWidth: '1200px', sidebarPosition: 'left', cardStyle: 'rounded', headerStyle: 'static', gridColumns: 3 },
    typography: { headingFont: 'sans', bodyFont: 'sans', headingWeight: 700, lineHeight: 1.6 },
    seo: { defaultTitle: '', titleTemplate: '{title} - {siteName}', defaultDescription: '', defaultKeywords: '' },
    geo: { region: 'CN', placename: '中国', position: '39.9042,116.4074' },
  };
}

// ─── Site Form Dialog ──────────────────────────────────────────────────────────

function SiteFormDialog({
  open,
  onOpenChange,
  editingSite,
  themes,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingSite: Site | null;
  themes: Theme[];
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    domain: '',
    name: '',
    description: '',
    themeId: '',
    enabled: true,
    siteTitle: '',
    siteDescription: '',
    siteKeywords: '',
    geoRegion: 'CN',
    geoPlacename: '中国',
    geoPosition: '39.9042,116.4074',
    novelOffset: 0,
    chapterOffset: 0,
  });

  useEffect(() => {
    if (editingSite) {
      const geo = typeof editingSite.geoConfig === 'string'
        ? (tryParseJSON(editingSite.geoConfig) as ThemeGeo ?? undefined)
        : editingSite.geoConfig;
      setForm({
        domain: editingSite.domain,
        name: editingSite.name,
        description: editingSite.description || '',
        themeId: editingSite.themeId || '',
        enabled: editingSite.enabled,
        siteTitle: editingSite.siteTitle || '',
        siteDescription: editingSite.siteDescription || '',
        siteKeywords: editingSite.siteKeywords || '',
        geoRegion: geo?.region || 'CN',
        geoPlacename: geo?.placename || '中国',
        geoPosition: geo?.position || '39.9042,116.4074',
        novelOffset: editingSite.novelOffset,
        chapterOffset: editingSite.chapterOffset,
      });
    } else {
      setForm((p) => ({ ...p, domain: '', name: '', description: '', themeId: '', enabled: true, novelOffset: 0, chapterOffset: 0 }));
    }
  }, [editingSite, open]);

  const handleSave = async () => {
    if (!form.domain.trim() || !form.name.trim()) {
      toast.error('请填写域名和站点名称');
      return;
    }
    setLoading(true);
    try {
      const url = editingSite ? `/api/sites/${editingSite.id}` : '/api/sites';
      const method = editingSite ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: form.domain.trim(),
          name: form.name.trim(),
          description: form.description.trim() || null,
          themeId: form.themeId || null,
          enabled: form.enabled,
          siteTitle: form.siteTitle.trim() || null,
          siteDescription: form.siteDescription.trim() || null,
          siteKeywords: form.siteKeywords.trim() || null,
          geoConfig: {
            region: form.geoRegion,
            placename: form.geoPlacename,
            position: form.geoPosition,
          },
          novelOffset: form.novelOffset,
          chapterOffset: form.chapterOffset,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '操作失败');
      }
      toast.success(editingSite ? '站点已更新' : '站点已创建');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingSite ? '编辑站点' : '添加站点'}</DialogTitle>
          <DialogDescription className="sr-only">
            {editingSite ? '修改站点配置信息' : '添加新的站点到站群'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Basic */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">基本信息</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>域名 *</Label>
                <Input
                  value={form.domain}
                  onChange={(e) => setForm((p) => ({ ...p, domain: e.target.value }))}
                  placeholder="novel1.example.com"
                />
              </div>
              <div className="space-y-2">
                <Label>站点名称 *</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="我的小说站"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>站点描述</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="站点简介"
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label>选择主题</Label>
              <Select
                value={form.themeId}
                onValueChange={(v) => setForm((p) => ({ ...p, themeId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择主题" />
                </SelectTrigger>
                <SelectContent>
                  {themes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
              />
              <Label>启用站点</Label>
            </div>
          </div>

          {/* SEO */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">SEO 配置</h4>
            <div className="space-y-2">
              <Label>站点标题 / Title</Label>
              <Input
                value={form.siteTitle}
                onChange={(e) => setForm((p) => ({ ...p, siteTitle: e.target.value }))}
                placeholder="站点SEO标题"
              />
            </div>
            <div className="space-y-2">
              <Label>站点描述 / Description</Label>
              <Textarea
                value={form.siteDescription}
                onChange={(e) => setForm((p) => ({ ...p, siteDescription: e.target.value }))}
                placeholder="站点SEO描述，用于搜索引擎结果展示"
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label>站点关键词 / Keywords</Label>
              <Input
                value={form.siteKeywords}
                onChange={(e) => setForm((p) => ({ ...p, siteKeywords: e.target.value }))}
                placeholder="关键词1,关键词2,关键词3"
              />
            </div>
          </div>

          {/* GEO */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">GEO 配置</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>地区</Label>
                <Input
                  value={form.geoRegion}
                  onChange={(e) => setForm((p) => ({ ...p, geoRegion: e.target.value }))}
                  placeholder="CN"
                />
              </div>
              <div className="space-y-2">
                <Label>地名</Label>
                <Input
                  value={form.geoPlacename}
                  onChange={(e) => setForm((p) => ({ ...p, geoPlacename: e.target.value }))}
                  placeholder="中国"
                />
              </div>
              <div className="space-y-2">
                <Label>坐标</Label>
                <Input
                  value={form.geoPosition}
                  onChange={(e) => setForm((p) => ({ ...p, geoPosition: e.target.value }))}
                  placeholder="39.9042,116.4074"
                />
              </div>
            </div>
          </div>

          {/* ID Offsets */}
          <div className="space-y-4">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">ID 偏移配置</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TooltipProvider>
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>小说ID偏移量</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground cursor-help underline decoration-dotted">?</span>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <p className="text-xs">
                          在站群模式下，不同站点的小说ID需要错开以避免冲突。
                          例如站点A偏移0，站点B偏移10000，则站点B的小说ID从10001开始。
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Input
                    type="number"
                    value={form.novelOffset}
                    onChange={(e) => setForm((p) => ({ ...p, novelOffset: parseInt(e.target.value) || 0 }))}
                  />
                </div>
              </TooltipProvider>
              <TooltipProvider>
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label>章节ID偏移量</Label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground cursor-help underline decoration-dotted">?</span>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <p className="text-xs">
                          同小说ID偏移，章节ID也需要在不同站点间错开。
                          确保每个站点的章节ID在全局范围内唯一。
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <Input
                    type="number"
                    value={form.chapterOffset}
                    onChange={(e) => setForm((p) => ({ ...p, chapterOffset: parseInt(e.target.value) || 0 }))}
                  />
                </div>
              </TooltipProvider>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {editingSite ? '保存修改' : '添加站点'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Site Preview (using theme config) ────────────────────────────────────────

function SitePreview({ site, theme }: { site: Site; theme: Theme }) {
  const config: ThemeConfig = typeof theme.config === 'string'
    ? ((tryParseJSON(theme.config) as ThemeConfig) ?? defaultThemeConfig())
    : theme.config;
  const { colors, typography, layout } = config;

  const headingFont =
    typography.headingFont === 'serif' ? 'Georgia, "Times New Roman", serif'
    : typography.headingFont === 'mono' ? '"Courier New", monospace'
    : 'system-ui, -apple-system, sans-serif';

  const bodyFont =
    typography.bodyFont === 'serif' ? 'Georgia, "Times New Roman", serif'
    : typography.bodyFont === 'mono' ? '"Courier New", monospace'
    : 'system-ui, -apple-system, sans-serif';

  const cardRadius =
    layout.cardStyle === 'rounded' ? '16px'
    : layout.cardStyle === 'flat' ? '0px'
    : layout.cardStyle === 'bordered' ? '4px'
    : '12px';

  const cardBorder = layout.cardStyle === 'bordered' ? `1px solid ${colors.border}` : 'none';
  const cardShadow = layout.cardStyle === 'elevated' ? '0 4px 20px rgba(0,0,0,0.3)' : 'none';

  return (
    <div
      style={{
        background: colors.background,
        borderRadius: '12px',
        overflow: 'hidden',
        border: `1px solid ${colors.border}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          background: colors.primary,
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h3
            style={{
              color: colors.background,
              fontSize: '16px',
              fontWeight: typography.headingWeight,
              fontFamily: headingFont,
              margin: 0,
            }}
          >
            {site.siteTitle || site.name}
          </h3>
          <p
            style={{
              color: `${colors.background}cc`,
              fontSize: '11px',
              margin: '2px 0 0',
            }}
          >
            {site.domain}
          </p>
        </div>
        <nav style={{ display: 'flex', gap: '16px' }}>
          {['首页', '分类', '排行', '书架'].map((item) => (
            <span
              key={item}
              style={{ color: `${colors.background}dd`, fontSize: '12px', cursor: 'pointer' }}
            >
              {item}
            </span>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div style={{ padding: '24px' }}>
        <h4
          style={{
            color: colors.foreground,
            fontSize: '14px',
            fontWeight: typography.headingWeight,
            fontFamily: headingFont,
            marginBottom: '16px',
            paddingBottom: '8px',
            borderBottom: `2px solid ${colors.primary}`,
          }}
        >
          最新小说
        </h4>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(layout.gridColumns, 3)}, 1fr)`,
            gap: '12px',
          }}
        >
          {['斗破苍穹', '凡人修仙传', '遮天'].map((title, i) => (
            <div
              key={title}
              style={{
                background: colors.card,
                borderRadius: cardRadius,
                border: cardBorder,
                boxShadow: cardShadow,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '80px',
                  background: i === 0 ? colors.primary : i === 1 ? colors.secondary : colors.accent,
                  opacity: 0.3,
                }}
              />
              <div style={{ padding: '10px' }}>
                <h5
                  style={{
                    color: colors.cardForeground,
                    fontSize: '12px',
                    fontWeight: 600,
                    fontFamily: headingFont,
                    margin: '0 0 4px',
                  }}
                >
                  {title}
                </h5>
                <p
                  style={{
                    color: colors.mutedForeground,
                    fontSize: '10px',
                    fontFamily: bodyFont,
                    lineHeight: typography.lineHeight,
                    margin: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  这是一段示例小说简介文字，展示主题排版效果
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Footer info */}
        <div
          style={{
            marginTop: '16px',
            paddingTop: '12px',
            borderTop: `1px solid ${colors.border}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ color: colors.mutedForeground, fontSize: '10px', fontFamily: bodyFont }}>
            © 2024 {site.name} · {site.description || '在线小说阅读'}
          </span>
          <span style={{ color: colors.mutedForeground, fontSize: '10px' }}>
            GEO: {config.geo.region} / {config.geo.placename}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Site Cluster View ────────────────────────────────────────────────────

export default function SiteClusterView() {
  const [sites, setSites] = useState<Site[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);
  const [editSite, setEditSite] = useState<Site | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [previewSite, setPreviewSite] = useState<Site | null>(null);
  const refreshSites = useAppStore((s) => s.refreshVersions['sites'] ?? 0);

  const fetchSites = useCallback(async () => {
    try {
      const [sitesRes, themesRes] = await Promise.all([
        fetch('/api/sites'),
        fetch('/api/themes'),
      ]);
      if (!sitesRes.ok || !themesRes.ok) throw new Error('Failed');
      const sitesData = await sitesRes.json();
      const themesData = await themesRes.json();
      setSites(sitesData);
      setThemes(
        themesData.map((t: Theme & { config: string }) => ({
          ...t,
          config: typeof t.config === 'string' ? (tryParseJSON(t.config) ?? defaultThemeConfig()) : t.config,
        }))
      );
    } catch {
      toast.error('获取站点数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSites();
  }, [fetchSites, refreshSites]);

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/sites/${deleteId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('站点已删除');
      setDeleteId(null);
      fetchSites();
    } catch {
      toast.error('删除失败');
    }
  };

  const getThemeName = (themeId: string | null) => {
    if (!themeId) return '未设置';
    const theme = themes.find((t) => t.id === themeId);
    return theme?.name || '未知主题';
  };

  const getPreviewTheme = (site: Site): Theme | null => {
    if (!site.themeId) return null;
    return themes.find((t) => t.id === site.themeId) || null;
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">站群管理</h3>
          <p className="text-sm text-muted-foreground">
            管理多个小说站点，配置域名、主题、SEO 和 ID 偏移
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setEditSite(null)}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          添加站点
        </Button>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list" className="gap-1.5">
            <Globe className="h-3.5 w-3.5" />
            站点列表
          </TabsTrigger>
          <TabsTrigger value="preview" className="gap-1.5">
            <Monitor className="h-3.5 w-3.5" />
            站点预览
          </TabsTrigger>
        </TabsList>

        {/* ── Site List Tab ── */}
        <TabsContent value="list" className="mt-4">
          {sites.length === 0 ? (
            <Card className="p-12 text-center">
              <Globe className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
              <h4 className="text-base font-medium text-muted-foreground mb-2">暂无站点</h4>
              <p className="text-sm text-muted-foreground/70 mb-6">
                添加第一个站点以开始构建你的小说站群
              </p>
              <Button onClick={() => setEditSite(null)}>
                <Plus className="h-4 w-4 mr-1.5" />
                添加站点
              </Button>
            </Card>
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>域名</TableHead>
                      <TableHead>站点名称</TableHead>
                      <TableHead>主题</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="hidden md:table-cell">小说偏移</TableHead>
                      <TableHead className="hidden lg:table-cell">创建时间</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sites.map((site) => (
                      <TableRow key={site.id} className="group">
                          <TableCell className="font-mono text-sm">{site.domain}</TableCell>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium text-sm">{site.name}</span>
                              {site.description && (
                                <span className="text-xs text-muted-foreground line-clamp-1 max-w-[200px]">
                                  {site.description}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {getThemeName(site.themeId)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={site.enabled ? 'default' : 'secondary'}
                              className={site.enabled ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : ''}
                            >
                              {site.enabled ? '已启用' : '已禁用'}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                            <span>小说: {site.novelOffset}</span>
                            <br />
                            <span>章节: {site.chapterOffset}</span>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                            {safeFormatDate(site.createdAt, (d) => format(d, 'yyyy-MM-dd HH:mm', { locale: zhCN }))}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              {site.theme && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => setPreviewSite(site)}
                                >
                                  <Eye className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setEditSite(site)}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => setDeleteId(site.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          )}
        </TabsContent>

        {/* ── Preview Tab ── */}
        <TabsContent value="preview" className="mt-4 space-y-6">
          {sites.filter((s) => s.theme).length === 0 ? (
            <Card className="p-12 text-center">
              <Monitor className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
              <h4 className="text-base font-medium text-muted-foreground mb-2">无可预览站点</h4>
              <p className="text-sm text-muted-foreground/70">
                请先为站点配置主题后，即可在此预览站点效果
              </p>
            </Card>
          ) : (
            <div className="space-y-6">
              {sites
                .filter((s) => s.theme)
                .map((site) => {
                  const theme = getPreviewTheme(site);
                  if (!theme) return null;
                  return (
                    <motion.div
                      key={site.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                    >
                      <div className="flex items-center gap-2 mb-3">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-sm">{site.name}</span>
                        <span className="text-xs text-muted-foreground font-mono">{site.domain}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {theme.name}
                        </Badge>
                      </div>
                      <SitePreview site={site} theme={theme} />
                    </motion.div>
                  );
                })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Single Site Preview Dialog */}
      {previewSite && getPreviewTheme(previewSite) && (
        <Dialog open onOpenChange={(open) => !open && setPreviewSite(null)}>
          <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>站点预览 — {previewSite.name}</DialogTitle>
            </DialogHeader>
            <SitePreview site={previewSite} theme={getPreviewTheme(previewSite)!} />
          </DialogContent>
        </Dialog>
      )}

      {/* Form Dialog */}
      <SiteFormDialog
        open={editSite !== null}
        onOpenChange={(open) => {
          if (!open) setEditSite(null);
        }}
        editingSite={editSite}
        themes={themes}
        onSaved={fetchSites}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除站点？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后该站点所有配置将丢失，此操作不可撤销。
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