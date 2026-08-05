'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Globe,
  Plus,
  Pencil,
  Trash2,
  Eye,
  Monitor,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { safeFormatDate } from '@/lib/format';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
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
import { tryParseJSON, formatRelativeTime, defaultThemeConfig } from './cluster/helpers';
import type { SiteHealthStatus } from './cluster/helpers';
import { SiteStatusDot } from './cluster/SiteStatusDot';
import { SiteFormDialog } from './cluster/SiteFormDialog';
import { SitePreview } from './cluster/SitePreview';
import type { Site, Theme, ThemeConfig } from '@/types';

export default function SiteClusterView() {
  const [sites, setSites] = useState<Site[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);
  const [editSite, setEditSite] = useState<Site | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [previewSite, setPreviewSite] = useState<Site | null>(null);
  const [siteHealthMap, setSiteHealthMap] = useState<Record<string, SiteHealthStatus>>({});
  const refreshSites = useAppStore((s) => s.refreshVersions['sites'] ?? 0);

  const fetchSites = useCallback(async (signal?: AbortSignal) => {
    try {
      const [sitesData, themesData] = await Promise.all([
        apiFetch<Site[]>('/api/sites', { signal }),
        apiFetch<(Theme & { config: string })[]>('/api/themes', { signal }),
      ]);
      if (signal?.aborted) return;
      const parsedSites = Array.isArray(sitesData) ? sitesData : (sitesData as any)?.sites ?? [];
      setSites(parsedSites);
      setSiteHealthMap((prev) => {
        const next: Record<string, SiteHealthStatus> = { ...prev };
        for (const s of parsedSites) {
          if (!(s.id in next)) {
            next[s.id] = s.enabled ? 'active' : 'error';
          }
        }
        return next;
      });
      setThemes(
        themesData.map((t) => ({      
          ...t,
          config: typeof t.config === 'string' ? (tryParseJSON(t.config) ?? defaultThemeConfig()) : (t.config as ThemeConfig),
        })) as Theme[]
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
    fetchSites(ac.signal);
    return () => ac.abort();
  }, [fetchSites, refreshSites]);

  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/sites/${deleteId}`, { method: 'DELETE' });
      toast.success('站点已删除');
      setDeleteId(null);
      fetchSites();
    } catch { /* handled by apiFetch */ } finally {
      setDeleting(false);
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
          onClick={() => { setEditSite(null); setFormOpen(true); }}
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
              <h4 className="text-base font-medium text-muted-foreground mb-2">暂无站点配置</h4>
              <p className="text-sm text-muted-foreground/70 mb-6">
                添加第一个站点以开始构建你的小说站群
              </p>
              <Button onClick={() => { setEditSite(null); setFormOpen(true); }}>
                <Plus className="h-4 w-4 mr-1.5" />
                添加第一个站点
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
                          <TableCell>
                            <span className="font-mono text-sm">{site.domain}</span>
                            {(site as any)._count?.novels != null && (
                              <span className="text-xs text-muted-foreground block mt-0.5">
                                关联小说: {(site as any)._count.novels} 部
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground/60 block mt-0.5">
                              最近更新: {formatRelativeTime(site.updatedAt)}
                            </span>
                          </TableCell>
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
                            <SiteStatusDot status={siteHealthMap[site.id] ?? (site.enabled ? 'active' : 'error')} />
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
                                  aria-label="预览站点"
                                  onClick={() => setPreviewSite(site)}
                                >
                                  <Eye className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                aria-label="编辑站点"
                                onClick={() => { setEditSite(site); setFormOpen(true); }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                aria-label="删除站点"
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
              <DialogDescription className="sr-only">预览站点 {previewSite.name} 的显示效果</DialogDescription>
            </DialogHeader>
            <SitePreview site={previewSite} theme={getPreviewTheme(previewSite)!} />
          </DialogContent>
        </Dialog>
      )}

      {/* Form Dialog */}
      <SiteFormDialog
        open={formOpen}
        onOpenChange={(open) => { if (!open) { setFormOpen(false); setEditSite(null); } }}
        editingSite={editSite}
        themes={themes}
        onSaved={fetchSites}
        onUrlTested={(domain, reachable) => {
          setSiteHealthMap((prev) => {
            const site = sites.find((s) => s.domain === domain);
            if (site) {
              return { ...prev, [site.id]: reachable ? 'active' : 'error' };
            }
            return prev;
          });
        }}
      />

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="确认删除站点？"
        description="删除后该站点所有配置将丢失，此操作不可撤销。"
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}