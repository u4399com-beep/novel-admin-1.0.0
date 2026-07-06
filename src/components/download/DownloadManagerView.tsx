'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Download,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Settings2,
  FileText,
  Search,
  Tag,
  Globe,
  Sparkles,
  Info,
  Eye,
  EyeOff,
  ChevronDown,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { DownloadConfig, SearchKeyword, Novel } from '@/types';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ConfigFormData {
  name: string;
  format: string;
  insertConfusion: boolean;
  confusionText: string;
  insertAd: boolean;
  adContent: string;
  adInterval: number;
  adPosition: string;
  insertSiteInfo: boolean;
  siteInfoContent: string;
  fileNamePattern: string;
}

const DEFAULT_FORM_DATA: ConfigFormData = {
  name: '',
  format: 'txt',
  insertConfusion: false,
  confusionText: '这段文字是为了增加页面内容，不影响阅读体验。请访问我们的网站获取更多精彩内容。',
  insertAd: false,
  adContent: '本章节由{siteName}整理，更多精彩请访问{siteName}。',
  adInterval: 50,
  adPosition: 'end',
  insertSiteInfo: false,
  siteInfoContent:
    '====================\n{title} - {author}\n====================\n本书由{siteName}整理发布\n',
  fileNamePattern: '{title} - {author}',
};

// ─── Main Component ────────────────────────────────────────────────────────────

export function DownloadManagerView() {
  const [configs, setConfigs] = useState<DownloadConfig[]>([]);
  const [loading, setLoading] = useState(true);

  // Config dialog
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<DownloadConfig | null>(null);
  const [formData, setFormData] = useState<ConfigFormData>(DEFAULT_FORM_DATA);
  const [saving, setSaving] = useState(false);

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingConfig, setDeletingConfig] = useState<DownloadConfig | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Download dialog
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const [downloadConfigId, setDownloadConfigId] = useState<string>('');
  const [downloading, setDownloading] = useState(false);

  // Novel selection for download
  const [novels, setNovels] = useState<Novel[]>([]);
  const [selectedNovelId, setSelectedNovelId] = useState('');
  const [novelSearch, setNovelSearch] = useState('');
  const [novelDropdownOpen, setNovelDropdownOpen] = useState(false);

  // Search keywords
  const [keywordNovelId, setKeywordNovelId] = useState('');
  const [keywordNovelTitle, setKeywordNovelTitle] = useState('');
  const [keywords, setKeywords] = useState<SearchKeyword[]>([]);
  const [keywordsLoading, setKeywordsLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);

  // ─── Fetch configs ────────────────────────────────────────────────────────

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await fetch('/api/download-configs');
      if (res.ok) {
        const data = await res.json();
        setConfigs(data);
        // Create default config if none exists
        if (data.length === 0) {
          await createDefaultConfig();
        }
      }
    } catch {
      toast.error('获取下载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const createDefaultConfig = async () => {
    try {
      const res = await fetch('/api/download-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '默认配置',
          format: 'txt',
          insertConfusion: false,
          insertAd: false,
          adInterval: 50,
          adPosition: 'end',
          insertSiteInfo: false,
          fileNamePattern: '{title} - {author}',
        }),
      });
      if (res.ok) {
        const newConfig = await res.json();
        setConfigs([newConfig]);
        setDownloadConfigId(newConfig.id);
      }
    } catch {
      // Silent fail for default creation
    }
  };

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  // ─── Fetch novels for download ────────────────────────────────────────────

  const fetchNovels = useCallback(async () => {
    try {
      const params = new URLSearchParams({ pageSize: '100' });
      if (novelSearch) params.set('search', novelSearch);
      const res = await fetch(`/api/novels?${params}`);
      if (res.ok) {
        const data = await res.json();
        setNovels(data.novels);
      }
    } catch {
      toast.error('获取小说列表失败');
    }
  }, [novelSearch]);

  useEffect(() => {
    fetchNovels();
  }, [fetchNovels]);

  // ─── Config CRUD ──────────────────────────────────────────────────────────

  const openCreateDialog = () => {
    setEditingConfig(null);
    setFormData(DEFAULT_FORM_DATA);
    setConfigDialogOpen(true);
  };

  const openEditDialog = (config: DownloadConfig) => {
    setEditingConfig(config);
    setFormData({
      name: config.name,
      format: config.format,
      insertConfusion: config.insertConfusion,
      confusionText: config.confusionText || '',
      insertAd: config.insertAd,
      adContent: config.adContent || '',
      adInterval: config.adInterval,
      adPosition: config.adPosition,
      insertSiteInfo: config.insertSiteInfo,
      siteInfoContent: config.siteInfoContent || '',
      fileNamePattern: config.fileNamePattern,
    });
    setConfigDialogOpen(true);
  };

  const handleSaveConfig = async () => {
    if (!formData.name.trim()) {
      toast.error('请输入配置名称');
      return;
    }
    setSaving(true);
    try {
      const url = editingConfig
        ? `/api/download-configs/${editingConfig.id}`
        : '/api/download-configs';
      const method = editingConfig ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        toast.success(editingConfig ? '配置已更新' : '配置已创建');
        setConfigDialogOpen(false);
        fetchConfigs();
      } else {
        const data = await res.json();
        toast.error(data.error || '操作失败');
      }
    } catch {
      toast.error('保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (config: DownloadConfig) => {
    setDeletingConfig(config);
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingConfig) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/download-configs/${deletingConfig.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success('配置已删除');
        setDeleteDialogOpen(false);
        fetchConfigs();
      } else {
        toast.error('删除失败');
      }
    } catch {
      toast.error('删除配置失败');
    } finally {
      setDeleting(false);
    }
  };

  // ─── Download ─────────────────────────────────────────────────────────────

  const openDownloadDialog = (presetConfigId?: string) => {
    setSelectedNovelId('');
    setDownloadConfigId(presetConfigId || configs[0]?.id || '');
    setDownloadDialogOpen(true);
  };

  const handleDownload = async () => {
    if (!selectedNovelId) {
      toast.error('请选择要下载的小说');
      return;
    }
    if (!downloadConfigId) {
      toast.error('请选择下载配置');
      return;
    }
    setDownloading(true);
    try {
      const url = `/api/download/${selectedNovelId}?configId=${downloadConfigId}&format=txt`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || '下载失败');
        return;
      }
      // Trigger download
      const blob = await res.blob();
      const contentDisposition = res.headers.get('Content-Disposition');
      let fileName = 'novel.txt';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename\*=UTF-8''(.+)/);
        if (match) {
          fileName = decodeURIComponent(match[1]);
        }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);

      toast.success(`已下载: ${fileName}`);
      setDownloadDialogOpen(false);
    } catch {
      toast.error('下载失败');
    } finally {
      setDownloading(false);
    }
  };

  // ─── Search Keywords ──────────────────────────────────────────────────────

  const handleExtractKeywords = async () => {
    if (!keywordNovelId) {
      toast.error('请先选择小说');
      return;
    }
    setExtracting(true);
    try {
      const res = await fetch(`/api/search-keywords/${keywordNovelId}`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        setKeywords(data.keywords);
        toast.success(`已提取 ${data.count} 个关键词`);
      } else {
        toast.error('提取关键词失败');
      }
    } catch {
      toast.error('提取关键词失败');
    } finally {
      setExtracting(false);
    }
  };

  const handleSetAsTags = async () => {
    if (!keywordNovelId || keywords.length === 0) return;

    try {
      // Fetch existing tags
      const tagsRes = await fetch('/api/tags');
      if (!tagsRes.ok) {
        toast.error('获取标签失败');
        return;
      }
      const existingTags = await tagsRes.json();
      const existingTagNames = new Set(existingTags.map((t: { name: string }) => t.name));

      // Get unique keyword texts
      const uniqueKeywords = [...new Set(keywords.map((k) => k.keyword))];

      // Create missing tags
      for (const kw of uniqueKeywords) {
        if (!existingTagNames.has(kw)) {
          const createRes = await fetch('/api/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: kw, color: '#6b7280' }),
          });
          if (createRes.ok) {
            existingTagNames.add(kw);
          }
        }
      }

      // Fetch novel to get existing tags
      const novelRes = await fetch(`/api/novels/${keywordNovelId}`);
      if (!novelRes.ok) {
        toast.error('获取小说信息失败');
        return;
      }
      const novel = await novelRes.json();
      const existingNovelTagIds = novel.tags?.map((nt: { tagId: string }) => nt.tagId) || [];

      // Fetch all tags again to get IDs
      const allTagsRes = await fetch('/api/tags');
      const allTags = await allTagsRes.json();

      // Build tag IDs list: existing + new
      const newTagIds = allTags
        .filter((t: { name: string }) => uniqueKeywords.includes(t.name))
        .map((t: { id: string }) => t.id);

      const allTagIds = [...new Set([...existingNovelTagIds, ...newTagIds])];

      // Update novel
      await fetch(`/api/novels/${keywordNovelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: allTagIds }),
      });

      toast.success(`已将 ${uniqueKeywords.length} 个关键词设为辅助标签`);
    } catch {
      toast.error('设置辅助标签失败');
    }
  };

  const handleAddSingleTag = async (keyword: string) => {
    if (!keywordNovelId) return;
    try {
      // Check if tag exists
      const tagsRes = await fetch('/api/tags');
      const existingTags = await tagsRes.json();
      let tagId = existingTags.find((t: { name: string }) => t.name === keyword)?.id;

      if (!tagId) {
        const createRes = await fetch('/api/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: keyword, color: '#6b7280' }),
        });
        if (createRes.ok) {
          const newTag = await createRes.json();
          tagId = newTag.id;
        } else {
          toast.error('创建标签失败');
          return;
        }
      }

      // Fetch novel
      const novelRes = await fetch(`/api/novels/${keywordNovelId}`);
      const novel = await novelRes.json();
      const existingTagIds = novel.tags?.map((nt: { tagId: string }) => nt.tagId) || [];

      if (existingTagIds.includes(tagId)) {
        toast.info('该标签已存在');
        return;
      }

      // Update novel
      await fetch(`/api/novels/${keywordNovelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: [...existingTagIds, tagId] }),
      });

      toast.success(`已添加标签: ${keyword}`);
    } catch {
      toast.error('添加标签失败');
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const sourceColorMap: Record<string, string> = {
    '百度': 'bg-blue-100 text-blue-700',
    '搜狗': 'bg-orange-100 text-orange-700',
    '必应': 'bg-teal-100 text-teal-700',
    '360搜索': 'bg-rose-100 text-rose-700',
    '神马搜索': 'bg-amber-100 text-amber-700',
  };

  const positionLabels: Record<string, string> = {
    start: '章节开头',
    middle: '章节中间',
    end: '章节结尾',
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="p-4 sm:p-6 space-y-6 max-w-5xl">
        {/* ── Section 1: Download Config Management ── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-md shadow-emerald-500/20">
                <Settings2 className="h-4.5 w-4.5 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">下载配置管理</h2>
                <p className="text-xs text-muted-foreground">管理TXT下载的格式、混淆和广告设置</p>
              </div>
            </div>
            <Button onClick={openCreateDialog} size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">新建配置</span>
            </Button>
          </div>

          {configs.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground mb-3">暂无下载配置</p>
                <Button onClick={openCreateDialog} variant="outline" size="sm">
                  <Plus className="h-4 w-4 mr-1.5" />
                  创建第一个配置
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {configs.map((config) => (
                <Card
                  key={config.id}
                  className="group hover:shadow-md transition-shadow duration-200"
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 shrink-0">
                          <Download className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-sm font-semibold truncate">
                            {config.name}
                          </CardTitle>
                          <CardDescription className="text-xs mt-0.5">
                            TXT · {config.format.toUpperCase()}
                          </CardDescription>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEditDialog(config)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => confirmDelete(config)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2.5">
                    {/* Settings summary badges */}
                    <div className="flex flex-wrap gap-1.5">
                      <Badge
                        variant="outline"
                        className={`text-[11px] px-2 py-0 ${
                          config.insertConfusion
                            ? 'border-amber-300 bg-amber-50 text-amber-700'
                            : 'text-muted-foreground'
                        }`}
                      >
                        混淆: {config.insertConfusion ? '已启用' : '关闭'}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`text-[11px] px-2 py-0 ${
                          config.insertAd
                            ? 'border-violet-300 bg-violet-50 text-violet-700'
                            : 'text-muted-foreground'
                        }`}
                      >
                        广告: {config.insertAd ? `每${config.adInterval}章` : '关闭'}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`text-[11px] px-2 py-0 ${
                          config.insertSiteInfo
                            ? 'border-sky-300 bg-sky-50 text-sky-700'
                            : 'text-muted-foreground'
                        }`}
                      >
                        站点信息: {config.insertSiteInfo ? '已启用' : '关闭'}
                      </Badge>
                    </div>

                    {/* Ad position detail */}
                    {config.insertAd && (
                      <p className="text-xs text-muted-foreground">
                        广告位置: {positionLabels[config.adPosition] || config.adPosition}
                      </p>
                    )}

                    {/* File name pattern */}
                    <p className="text-xs text-muted-foreground font-mono truncate" title={config.fileNamePattern}>
                      📄 {config.fileNamePattern}
                    </p>

                    {/* Action buttons */}
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        className="flex-1 gap-1.5 text-xs h-8"
                        onClick={() => openDownloadDialog(config.id)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        使用此配置下载
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <Separator />

        {/* ── Section 2: Quick Download ── */}
        <section>
          <div className="flex items-center gap-2.5 mb-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 shadow-md shadow-sky-500/20">
              <Download className="h-4.5 w-4.5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">快速下载</h2>
              <p className="text-xs text-muted-foreground">选择小说和配置，一键生成TXT文件</p>
            </div>
          </div>

          <Card>
            <CardContent className="py-5">
              <div className="flex flex-col sm:flex-row gap-3 items-end">
                <div className="flex-1 w-full">
                  <Label className="text-xs text-muted-foreground mb-1.5 block">选择小说</Label>
                  <div className="relative">
                    <Input
                      placeholder="搜索小说标题或作者..."
                      value={novelSearch}
                      onChange={(e) => setNovelSearch(e.target.value)}
                      onFocus={() => setNovelDropdownOpen(true)}
                      className="pr-8"
                    />
                    <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    {novelDropdownOpen && novels.length > 0 && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                        {novels.map((novel) => (
                          <button
                            key={novel.id}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center justify-between"
                            onClick={() => {
                              setSelectedNovelId(novel.id);
                              setNovelSearch(novel.title);
                              setNovelDropdownOpen(false);
                            }}
                          >
                            <span className="truncate">{novel.title}</span>
                            <span className="text-xs text-muted-foreground ml-2 shrink-0">
                              {novel.author}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="w-full sm:w-48">
                  <Label className="text-xs text-muted-foreground mb-1.5 block">下载配置</Label>
                  <Select value={downloadConfigId} onValueChange={setDownloadConfigId}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择配置" />
                    </SelectTrigger>
                    <SelectContent>
                      {configs.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={handleDownload}
                  disabled={!selectedNovelId || !downloadConfigId || downloading}
                  className="w-full sm:w-auto gap-1.5"
                >
                  {downloading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  下载TXT
                </Button>
              </div>
              {selectedNovelId && novelSearch && (
                <p className="text-xs text-muted-foreground mt-2">
                  已选择: {novelSearch}
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        <Separator />

        {/* ── Section 3: Search Keywords ── */}
        <section>
          <div className="flex items-center gap-2.5 mb-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 shadow-md shadow-amber-500/20">
              <Globe className="h-4.5 w-4.5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">搜索引擎关键词提取</h2>
              <p className="text-xs text-muted-foreground">
                生成搜索优化关键词，可批量设为辅助标签
              </p>
            </div>
          </div>

          <Card>
            <CardContent className="py-5 space-y-4">
              {/* Novel selector */}
              <div className="flex flex-col sm:flex-row gap-3 items-end">
                <div className="flex-1 w-full">
                  <Label className="text-xs text-muted-foreground mb-1.5 block">选择小说</Label>
                  <div className="relative">
                    <Input
                      placeholder="搜索小说标题或作者..."
                      value={keywordNovelTitle}
                      onChange={(e) => {
                        setKeywordNovelTitle(e.target.value);
                        setKeywordNovelId('');
                        setKeywords([]);
                      }}
                    />
                    {keywordNovelTitle && novels.length > 0 && (
                      <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                        {novels
                          .filter(
                            (n) =>
                              n.title.includes(keywordNovelTitle) ||
                              n.author.includes(keywordNovelTitle)
                          )
                          .map((novel) => (
                            <button
                              key={novel.id}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center justify-between"
                              onClick={() => {
                                setKeywordNovelId(novel.id);
                                setKeywordNovelTitle(novel.title);
                              }}
                            >
                              <span className="truncate">{novel.title}</span>
                              <span className="text-xs text-muted-foreground ml-2 shrink-0">
                                {novel.author}
                              </span>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
                <Button
                  onClick={handleExtractKeywords}
                  disabled={!keywordNovelId || extracting}
                  variant="outline"
                  className="w-full sm:w-auto gap-1.5"
                >
                  {extracting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  提取关键词
                </Button>
              </div>

              {keywordNovelId && keywords.length > 0 && (
                <>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground">
                      已提取 <span className="text-amber-600">{keywords.length}</span> 个关键词
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={handleSetAsTags}
                    >
                      <Tag className="h-3.5 w-3.5" />
                      全部设为辅助标签
                    </Button>
                  </div>

                  <ScrollArea className="max-h-64">
                    <div className="flex flex-wrap gap-2 pr-4">
                      {keywords.map((kw) => (
                        <div
                          key={kw.id}
                          className="group/badge flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 transition-colors hover:bg-muted"
                        >
                          <Badge
                            variant="secondary"
                            className={`text-[10px] px-1.5 py-0 rounded ${
                              sourceColorMap[kw.source] || 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {kw.source}
                          </Badge>
                          <span className="text-xs text-foreground max-w-[200px] truncate">
                            {kw.keyword}
                          </span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => handleAddSingleTag(kw.keyword)}
                                className="opacity-0 group-hover/badge:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                              >
                                <Tag className="h-3 w-3" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">
                              设为标签
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </>
              )}

              {keywordNovelId && keywords.length === 0 && !extracting && (
                <div className="flex flex-col items-center py-8 text-center">
                  <Search className="h-8 w-8 text-muted-foreground/40 mb-2" />
                  <p className="text-sm text-muted-foreground">
                    点击"提取关键词"开始生成搜索优化关键词
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── Dialog: Create/Edit Config ── */}
        <Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {editingConfig ? '编辑下载配置' : '新建下载配置'}
              </DialogTitle>
              <DialogDescription>
                {editingConfig ? '修改下载配置的各项参数' : '创建一个新的下载配置'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5 py-2">
              {/* Basic info */}
              <div className="space-y-2">
                <Label htmlFor="config-name">
                  配置名称 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="config-name"
                  placeholder="输入配置名称"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">文件格式</Label>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant="outline" className="font-mono">
                    TXT
                  </Badge>
                  <span className="text-xs">纯文本格式（目前仅支持TXT）</span>
                </div>
              </div>

              <Separator />

              {/* ── 混淆设置 ── */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <EyeOff className="h-4 w-4 text-amber-500" />
                  混淆设置
                </h4>

                <div className="flex items-center justify-between">
                  <Label htmlFor="insert-confusion" className="text-sm cursor-pointer">
                    启用混淆
                  </Label>
                  <Switch
                    id="insert-confusion"
                    checked={formData.insertConfusion}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, insertConfusion: checked })
                    }
                  />
                </div>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="relative">
                      <Label className="text-xs text-muted-foreground mb-1.5 block">
                        混淆文本
                      </Label>
                      <Textarea
                        placeholder="输入混淆文本（每行一段）..."
                        value={formData.confusionText}
                        onChange={(e) =>
                          setFormData({ ...formData, confusionText: e.target.value })
                        }
                        disabled={!formData.insertConfusion}
                        rows={4}
                        className="font-mono text-xs"
                      />
                      <Info className="absolute right-2 top-7 h-3.5 w-3.5 text-muted-foreground/60" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs">
                    在段落之间插入随机混淆文本，防止内容被直接复制
                  </TooltipContent>
                </Tooltip>
              </div>

              <Separator />

              {/* ── 广告插入 ── */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <FileText className="h-4 w-4 text-violet-500" />
                  广告插入
                </h4>

                <div className="flex items-center justify-between">
                  <Label htmlFor="insert-ad" className="text-sm cursor-pointer">
                    启用广告插入
                  </Label>
                  <Switch
                    id="insert-ad"
                    checked={formData.insertAd}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, insertAd: checked })
                    }
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    广告内容{' '}
                    <span className="text-[10px] font-normal">
                      (支持变量: {'{title}'}, {'{author}'}, {'{siteName}'}, {'{chapterTitle}'})
                    </span>
                  </Label>
                  <Textarea
                    placeholder="输入广告内容..."
                    value={formData.adContent}
                    onChange={(e) =>
                      setFormData({ ...formData, adContent: e.target.value })
                    }
                    disabled={!formData.insertAd}
                    rows={3}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      插入频率（每N章）
                    </Label>
                    <Input
                      type="number"
                      min={10}
                      max={200}
                      value={formData.adInterval}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          adInterval: Math.max(10, Math.min(200, parseInt(e.target.value) || 50)),
                        })
                      }
                      disabled={!formData.insertAd}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">插入位置</Label>
                    <Select
                      value={formData.adPosition}
                      onValueChange={(value) =>
                        setFormData({ ...formData, adPosition: value })
                      }
                      disabled={!formData.insertAd}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="start">章节开头</SelectItem>
                        <SelectItem value="middle">章节中间</SelectItem>
                        <SelectItem value="end">章节结尾</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              <Separator />

              {/* ── 站点信息 ── */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Globe className="h-4 w-4 text-sky-500" />
                  站点信息
                </h4>

                <div className="flex items-center justify-between">
                  <Label htmlFor="insert-site-info" className="text-sm cursor-pointer">
                    启用站点信息
                  </Label>
                  <Switch
                    id="insert-site-info"
                    checked={formData.insertSiteInfo}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, insertSiteInfo: checked })
                    }
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    站点信息内容{' '}
                    <span className="text-[10px] font-normal">
                      (支持变量: {'{title}'}, {'{author}'}, {'{siteName}'})
                    </span>
                  </Label>
                  <Textarea
                    placeholder="输入站点信息..."
                    value={formData.siteInfoContent}
                    onChange={(e) =>
                      setFormData({ ...formData, siteInfoContent: e.target.value })
                    }
                    disabled={!formData.insertSiteInfo}
                    rows={4}
                    className="font-mono text-xs"
                  />
                </div>
              </div>

              <Separator />

              {/* ── 文件命名 ── */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <FileText className="h-4 w-4 text-emerald-500" />
                  文件命名
                </h4>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">文件名模板</Label>
                  <Input
                    placeholder="{title} - {author}"
                    value={formData.fileNamePattern}
                    onChange={(e) =>
                      setFormData({ ...formData, fileNamePattern: e.target.value })
                    }
                    className="font-mono text-sm"
                  />
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    <span className="text-[10px] text-muted-foreground">可用变量:</span>
                    {['{title}', '{author}', '{wordCount}', '{chapterCount}', '{date}'].map(
                      (v) => (
                        <code
                          key={v}
                          className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono text-foreground"
                        >
                          {v}
                        </code>
                      )
                    )}
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfigDialogOpen(false)}
                disabled={saving}
              >
                取消
              </Button>
              <Button onClick={handleSaveConfig} disabled={saving || !formData.name.trim()}>
                {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                {editingConfig ? '保存修改' : '创建配置'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── Dialog: Delete Confirmation ── */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认删除</AlertDialogTitle>
              <AlertDialogDescription>
                确定要删除配置 <span className="font-medium text-foreground">"{deletingConfig?.name}"</span> 吗？此操作无法撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={deleting}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                {deleting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* ── Dialog: Download ── */}
        <Dialog open={downloadDialogOpen} onOpenChange={setDownloadDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Download className="h-5 w-5 text-emerald-600" />
                下载小说
              </DialogTitle>
              <DialogDescription>选择小说和下载配置</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">选择小说</Label>
                <Select value={selectedNovelId} onValueChange={setSelectedNovelId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择要下载的小说" />
                  </SelectTrigger>
                  <SelectContent>
                    {novels.map((novel) => (
                      <SelectItem key={novel.id} value={novel.id}>
                        <span className="truncate">{novel.title}</span>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {novel.author}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">下载格式</Label>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    TXT
                  </Badge>
                  <span className="text-xs text-muted-foreground">纯文本格式</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">下载配置</Label>
                <Select value={downloadConfigId} onValueChange={setDownloadConfigId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择配置" />
                  </SelectTrigger>
                  <SelectContent>
                    {configs.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDownloadDialogOpen(false)}
                disabled={downloading}
              >
                取消
              </Button>
              <Button
                onClick={handleDownload}
                disabled={!selectedNovelId || !downloadConfigId || downloading}
                className="gap-1.5"
              >
                {downloading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                下载
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}