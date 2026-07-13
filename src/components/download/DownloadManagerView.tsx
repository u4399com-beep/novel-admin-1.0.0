'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Download, Settings, Search, Plus, Pencil, Trash2, Loader2, FileText, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
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
import { Switch } from '@/components/ui/switch';
import type { DownloadConfig } from '@/types';

export default function DownloadManagerView() {
  const [configs, setConfigs] = useState<DownloadConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DownloadConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DownloadConfig | null>(null);

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await fetch('/api/download-configs');
      if (res.ok) {
        const data = await res.json();
        setConfigs(Array.isArray(data) ? data : []);
      }
    } catch {
      toast.error('获取下载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/download-configs/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '删除失败');
      }
      toast.success('配置已删除');
      fetchConfigs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleteTarget(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">下载配置</h2>
          <p className="text-sm text-muted-foreground">管理小说导出下载的格式和内容配置</p>
        </div>
        <Button
          onClick={() => { setEditing(null); setFormOpen(true); }}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          新建配置
        </Button>
      </div>

      {configs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Download className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <p className="text-muted-foreground">暂无下载配置</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => { setEditing(null); setFormOpen(true); }}
            >
              <Plus className="h-4 w-4 mr-1.5" />
              创建第一个配置
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {configs.map((config) => (
            <Card key={config.id} className={!config.enabled ? 'opacity-60' : ''}>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <FileText className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium truncate">{config.name}</h3>
                      <Badge variant="outline" className="text-[10px] shrink-0">{config.format.toUpperCase()}</Badge>
                      {!config.enabled && <Badge variant="secondary" className="text-[10px] shrink-0">已禁用</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {config.insertConfusion && '混淆 · '}
                      {config.insertAd && '广告 · '}
                      {config.insertSiteInfo && '站点信息 · '}
                      文件名: {config.fileNamePattern}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { setEditing(config); setFormOpen(true); }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget(config)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Config Form Dialog */}
      <DownloadConfigFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={fetchConfigs}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除下载配置「{deleteTarget?.name}」吗？此操作不可撤销。
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

// ─── Form Dialog ───────────────────────────────────────────────────────────

function DownloadConfigFormDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: DownloadConfig | null;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [format, setFormat] = useState('txt');
  const [insertConfusion, setInsertConfusion] = useState(false);
  const [confusionText, setConfusionText] = useState('');
  const [insertAd, setInsertAd] = useState(false);
  const [adContent, setAdContent] = useState('');
  const [adInterval, setAdInterval] = useState('50');
  const [adPosition, setAdPosition] = useState('end');
  const [insertSiteInfo, setInsertSiteInfo] = useState(false);
  const [siteInfoContent, setSiteInfoContent] = useState('');
  const [fileNamePattern, setFileNamePattern] = useState('{title} - {author}');

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setFormat(editing.format);
      setInsertConfusion(editing.insertConfusion);
      setConfusionText(editing.confusionText || '');
      setInsertAd(editing.insertAd);
      setAdContent(editing.adContent || '');
      setAdInterval(String(editing.adInterval));
      setAdPosition(editing.adPosition);
      setInsertSiteInfo(editing.insertSiteInfo);
      setSiteInfoContent(editing.siteInfoContent || '');
      setFileNamePattern(editing.fileNamePattern);
    } else {
      setName('');
      setFormat('txt');
      setInsertConfusion(false);
      setConfusionText('');
      setInsertAd(false);
      setAdContent('');
      setAdInterval('50');
      setAdPosition('end');
      setInsertSiteInfo(false);
      setSiteInfoContent('');
      setFileNamePattern('{title} - {author}');
    }
  }, [editing, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        format,
        insertConfusion,
        confusionText: insertConfusion ? confusionText || null : null,
        insertAd,
        adContent: insertAd ? adContent || null : null,
        adInterval: Number(adInterval) || 50,
        adPosition,
        insertSiteInfo,
        siteInfoContent: insertSiteInfo ? siteInfoContent || null : null,
        fileNamePattern: fileNamePattern || '{title} - {author}',
      };

      const url = editing
        ? `/api/download-configs/${editing.id}`
        : `/api/download-configs`;
      const method = editing ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '保存失败');
      }

      toast.success(editing ? '配置已更新' : '配置已创建');
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑下载配置' : '新建下载配置'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>配置名称 *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：默认导出配置" required />
          </div>

          <div className="space-y-2">
            <Label>文件格式</Label>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="txt">TXT 纯文本</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>文件名模板</Label>
            <Input value={fileNamePattern} onChange={(e) => setFileNamePattern(e.target.value)} placeholder="{title} - {author}" />
            <p className="text-[11px] text-muted-foreground">可用变量: {'{title}'}, {'{author}'}, {'{date}'}, {'{chapterCount}'}, {'{wordCount}'}</p>
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>插入混淆文本</Label>
                <p className="text-[11px] text-muted-foreground">在段落间随机插入干扰内容</p>
              </div>
              <Switch checked={insertConfusion} onCheckedChange={setInsertConfusion} />
            </div>
            {insertConfusion && (
              <textarea
                className="mt-2 w-full min-h-[80px] rounded-md border bg-transparent px-3 py-2 text-sm"
                value={confusionText}
                onChange={(e) => setConfusionText(e.target.value)}
                placeholder="每行一条混淆文本"
              />
            )}
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>插入广告内容</Label>
                <p className="text-[11px] text-muted-foreground">按间隔在章节中插入广告</p>
              </div>
              <Switch checked={insertAd} onCheckedChange={setInsertAd} />
            </div>
            {insertAd && (
              <div className="mt-2 space-y-3">
                <textarea
                  className="w-full min-h-[80px] rounded-md border bg-transparent px-3 py-2 text-sm"
                  value={adContent}
                  onChange={(e) => setAdContent(e.target.value)}
                  placeholder="广告内容，支持变量"
                />
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">插入间隔（章）</Label>
                    <Input type="number" min="1" max="1000" value={adInterval} onChange={(e) => setAdInterval(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">广告位置</Label>
                    <Select value={adPosition} onValueChange={setAdPosition}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="start">章节前</SelectItem>
                        <SelectItem value="middle">章节中</SelectItem>
                        <SelectItem value="end">章节后</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="border-t pt-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>插入站点信息</Label>
                <p className="text-[11px] text-muted-foreground">在文件首尾添加站点宣传信息</p>
              </div>
              <Switch checked={insertSiteInfo} onCheckedChange={setInsertSiteInfo} />
            </div>
            {insertSiteInfo && (
              <textarea
                className="mt-2 w-full min-h-[80px] rounded-md border bg-transparent px-3 py-2 text-sm"
                value={siteInfoContent}
                onChange={(e) => setSiteInfoContent(e.target.value)}
                placeholder="站点信息内容，支持变量"
              />
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              {editing ? '保存' : '创建'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}