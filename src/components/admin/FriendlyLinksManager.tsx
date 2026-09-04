'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Link2, ExternalLink, Globe, BookOpen } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { useDeleteConfirm } from '@/hooks/useDeleteConfirm';
import type { FriendlyLink, Site, Novel } from '@/types';

// ─── Types ────────────────────────────────────────────────────────────────────
interface FriendlyLinkWithRelations extends FriendlyLink {
  site?: { id: string; domain: string; name: string; enabled: boolean } | null;
  novel?: { id: string; title: string; slugs: { slug: string; isActive: boolean }[] } | null;
}

interface FormData {
  title: string;
  url: string;
  description: string;
  logo: string;
  linkType: 'manual' | 'site_home' | 'site_novel';
  siteId: string;
  novelId: string;
  sortOrder: number;
  enabled: boolean;
  nofollow: boolean;
}

const EMPTY_FORM: FormData = {
  title: '',
  url: '',
  description: '',
  logo: '',
  linkType: 'manual',
  siteId: '',
  novelId: '',
  sortOrder: 0,
  enabled: true,
  nofollow: false,
};

function formFromLink(link: FriendlyLinkWithRelations): FormData {
  return {
    title: link.title,
    url: link.url,
    description: link.description || '',
    logo: link.logo || '',
    linkType: link.linkType,
    siteId: link.siteId || '',
    novelId: link.novelId || '',
    sortOrder: link.sortOrder,
    enabled: link.enabled,
    nofollow: link.nofollow,
  };
}

// ─── Type Badge ───────────────────────────────────────────────────────────────
function LinkTypeBadge({ type }: { type: string }) {
  const config: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
    manual: { label: '手动', variant: 'secondary' },
    site_home: { label: '站点首页', variant: 'outline' },
    site_novel: { label: '站点小说', variant: 'outline' },
  };
  const c = config[type] || { label: type, variant: 'outline' as const };
  return <Badge variant={c.variant} className="text-[10px] px-1.5 py-0">{c.label}</Badge>;
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────
function TableSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="rounded-lg border">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 border-b last:border-0">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-40 flex-1" />
            <Skeleton className="h-5 w-12" />
            <Skeleton className="h-5 w-12" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────────────
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Link2 className="h-7 w-7 text-muted-foreground" />
      </div>
      <p className="mt-3 text-sm text-muted-foreground">还没有友情链接</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onCreate}>
        <Plus className="mr-1.5 h-4 w-4" />
        添加链接
      </Button>
    </div>
  );
}

// ─── Form Dialog ─────────────────────────────────────────────────────────────
function FriendlyLinkFormDialog({
  open,
  initialForm,
  saving,
  sites,
  novels,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initialForm: FormData;
  saving: boolean;
  sites: Site[];
  novels: Novel[];
  onClose: () => void;
  onSubmit: (data: FormData) => void;
}) {
  const [form, setForm] = useState<FormData>(initialForm);
  const [urlError, setUrlError] = useState('');

  const updateField = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === 'url') {
      if (value && !/^https?:\/\//i.test(String(value))) {
        setUrlError('URL 必须以 http:// 或 https:// 开头');
      } else {
        setUrlError('');
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error('链接名称不能为空');
      return;
    }
    if (!form.url.trim()) {
      toast.error('链接URL不能为空');
      return;
    }
    if (urlError) {
      toast.error(urlError);
      return;
    }
    onSubmit(form);
  };

  const showSiteSelect = form.linkType === 'site_home' || form.linkType === 'site_novel';
  const showNovelSelect = form.linkType === 'site_novel';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialForm !== EMPTY_FORM ? '编辑友情链接' : '添加友情链接'}</DialogTitle>
          <DialogDescription>
            {initialForm !== EMPTY_FORM ? '修改友情链接配置' : '添加新的友情链接到站点'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="fl-title">链接名称 <span className="text-destructive">*</span></Label>
            <Input
              id="fl-title"
              value={form.title}
              onChange={(e) => updateField('title', e.target.value)}
              placeholder="网站名称"
              maxLength={100}
              autoFocus
            />
          </div>

          {/* URL */}
          <div className="space-y-1.5">
            <Label htmlFor="fl-url">链接URL <span className="text-destructive">*</span></Label>
            <Input
              id="fl-url"
              value={form.url}
              onChange={(e) => updateField('url', e.target.value)}
              placeholder="https://example.com"
              maxLength={2048}
              aria-invalid={!!urlError}
              className={urlError ? 'border-destructive' : ''}
            />
            {urlError && <p className="text-xs text-destructive">{urlError}</p>}
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="fl-desc">描述</Label>
            <Textarea
              id="fl-desc"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              placeholder="链接描述（可选）"
              maxLength={500}
              rows={2}
            />
          </div>

          {/* Logo */}
          <div className="space-y-1.5">
            <Label htmlFor="fl-logo">Logo URL</Label>
            <Input
              id="fl-logo"
              value={form.logo}
              onChange={(e) => updateField('logo', e.target.value)}
              placeholder="https://example.com/logo.png（可选）"
              maxLength={2048}
            />
          </div>

          <Separator className="my-3" />

          {/* Link Type */}
          <div className="space-y-1.5">
            <Label>链接类型</Label>
            <Select value={form.linkType} onValueChange={(v) => updateField('linkType', v as FormData['linkType'])}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">手动链接</SelectItem>
                <SelectItem value="site_home">站点首页</SelectItem>
                <SelectItem value="site_novel">站点小说</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Site Select */}
          {showSiteSelect && (
            <div className="space-y-1.5">
              <Label>关联站点</Label>
              <Select value={form.siteId} onValueChange={(v) => updateField('siteId', v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择站点（可选）" />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <div className="flex items-center gap-2">
                        <Globe className="h-3 w-3 text-muted-foreground" />
                        <span>{s.name || s.domain}</span>
                        <span className="text-xs text-muted-foreground">{s.domain}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Novel Select */}
          {showNovelSelect && (
            <div className="space-y-1.5">
              <Label>关联小说</Label>
              <Select value={form.novelId} onValueChange={(v) => updateField('novelId', v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择小说（可选）" />
                </SelectTrigger>
                <SelectContent>
                  {novels.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      <div className="flex items-center gap-2">
                        <BookOpen className="h-3 w-3 text-muted-foreground" />
                        <span>{n.title}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Separator className="my-3" />

          {/* Sort Order */}
          <div className="space-y-1.5">
            <Label htmlFor="fl-sort">排序权重</Label>
            <Input
              id="fl-sort"
              type="number"
              value={form.sortOrder}
              onChange={(e) => updateField('sortOrder', parseInt(e.target.value, 10) || 0)}
              min={-10000}
              max={10000}
            />
            <p className="text-[11px] text-muted-foreground">数值越小越靠前，范围 -10000 ~ 10000</p>
          </div>

          {/* Switches */}
          <div className="flex items-center justify-between">
            <Label htmlFor="fl-enabled">启用</Label>
            <Switch
              id="fl-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => updateField('enabled', v)}
            />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="fl-nofollow">Nofollow</Label>
            <Switch
              id="fl-nofollow"
              checked={form.nofollow}
              onCheckedChange={(v) => updateField('nofollow', v)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? '保存中...' : initialForm !== EMPTY_FORM ? '更新' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function FriendlyLinksManager() {
  const [links, setLinks] = useState<FriendlyLinkWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FriendlyLinkWithRelations | null>(null);
  const [saving, setSaving] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [novels, setNovels] = useState<Novel[]>([]);
  const { deleteTarget, setDeleteTarget, deleting, handleDelete: confirmDelete } = useDeleteConfirm<FriendlyLinkWithRelations>();

  const fetchLinks = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const data = await apiFetch<FriendlyLinkWithRelations[]>('/api/friendly-links', { signal });
      if (signal?.aborted) return;
      setLinks(data);
    } catch {
      if (signal?.aborted) return;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const fetchReferenceData = useCallback(async (signal?: AbortSignal) => {
    try {
      const [sitesData, novelsData] = await Promise.all([
        apiFetch<{ sites: Site[] }>('/api/sites', { signal, silent: true }),
        apiFetch<{ novels: Novel[] }>('/api/novels?pageSize=200', { signal, silent: true }),
      ]);
      if (signal?.aborted) return;
      setSites(sitesData.sites ?? []);
      setNovels(novelsData.novels ?? []);
    } catch {
      // Reference data fetch failure is non-critical
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchLinks(ac.signal);
    fetchReferenceData(ac.signal);
    return () => ac.abort();
  }, [fetchLinks, fetchReferenceData]);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (link: FriendlyLinkWithRelations) => {
    setEditing(link);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditing(null);
  };

  const currentForm = editing ? formFromLink(editing) : EMPTY_FORM;
  const dialogKey = editing ? editing.id : 'create';

  const onSubmit = async (data: FormData) => {
    try {
      setSaving(true);
      const body = {
        title: data.title.trim(),
        url: data.url.trim(),
        description: data.description.trim() || null,
        logo: data.logo.trim() || null,
        linkType: data.linkType,
        siteId: data.siteId || null,
        novelId: data.novelId || null,
        sortOrder: data.sortOrder,
        enabled: data.enabled,
        nofollow: data.nofollow,
      };

      if (editing) {
        await apiFetch(`/api/friendly-links/${editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast.success('友情链接已更新');
      } else {
        await apiFetch('/api/friendly-links', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast.success('友情链接已创建');
      }

      closeDialog();
      fetchLinks();
    } catch {
      /* handled by apiFetch */
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = useCallback(() => confirmDelete(async () => {
    if (!deleteTarget) return;
    await apiFetch(`/api/friendly-links/${deleteTarget.id}`, { method: 'DELETE' });
    toast.success('友情链接已删除');
    fetchLinks();
  }), [confirmDelete, deleteTarget, fetchLinks]);

  if (loading) return <TableSkeleton />;
  if (links.length === 0) return <EmptyState onCreate={openCreate} />;

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">友情链接管理</h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          添加链接
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">标题</TableHead>
              <TableHead className="hidden md:table-cell">URL</TableHead>
              <TableHead className="w-[100px]">类型</TableHead>
              <TableHead className="hidden lg:table-cell w-[100px]">站点/小说</TableHead>
              <TableHead className="w-[80px]">状态</TableHead>
              <TableHead className="w-[120px] text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.map((link) => (
              <TableRow key={link.id}>
                <TableCell>
                  <div className="flex items-center gap-2 min-w-0">
                    {link.logo ? (
                      <img
                        src={link.logo}
                        alt=""
                        className="h-5 w-5 rounded object-contain shrink-0 bg-muted"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted">
                        <Link2 className="h-3 w-3 text-muted-foreground" />
                      </div>
                    )}
                    <span className="truncate text-sm font-medium">{link.title}</span>
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate text-xs text-muted-foreground max-w-[200px]">{link.url}</span>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </TableCell>
                <TableCell>
                  <LinkTypeBadge type={link.linkType} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                    {link.site && <span className="truncate">{link.site.name || link.site.domain}</span>}
                    {link.novel && <span className="truncate">{link.novel.title}</span>}
                    {!link.site && !link.novel && <span className="text-muted-foreground/50">—</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <Badge variant={link.enabled ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0 justify-center">
                      {link.enabled ? '启用' : '禁用'}
                    </Badge>
                    {link.nofollow && (
                      <span className="text-[10px] text-muted-foreground text-center">nofollow</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="编辑链接"
                      onClick={() => openEdit(link)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      aria-label="删除链接"
                      onClick={() => setDeleteTarget(link)}
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

      {/* Summary */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>共 {links.length} 个链接</span>
        <span>启用 {links.filter((l) => l.enabled).length} 个</span>
        <span>禁用 {links.filter((l) => !l.enabled).length} 个</span>
      </div>

      {/* Form Dialog — key forces remount so useState initializer picks up new initialForm */}
      {dialogOpen && (
        <FriendlyLinkFormDialog
          key={dialogKey}
          open={dialogOpen}
          initialForm={currentForm}
          saving={saving}
          sites={sites}
          novels={novels}
          onClose={closeDialog}
          onSubmit={onSubmit}
        />
      )}

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        description={
          deleteTarget
            ? `确定要删除友情链接「${deleteTarget.title}」吗？此操作不可撤销。`
            : ''
        }
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
