'use client';

import { useState, useRef, useCallback } from 'react';
import { Upload, FileText, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch, FetchError } from '@/lib/api-fetch';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface Category {
  id: string;
  name: string;
  color: string;
}

interface ImportResult {
  id: string;
  title: string;
  author: string;
  chapterCount: number;
  wordCount: number;
}

type ImportState = 'idle' | 'uploading' | 'success' | 'error';

interface NovelImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Category[];
  onImportSuccess?: (result: ImportResult) => void;
}

export function NovelImportDialog({ open, onOpenChange, categories, onImportSuccess }: NovelImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState('auto');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('ongoing');
  const [importState, setImportState] = useState<ImportState>('idle');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setFile(null);
    setImportState('idle');
    setResult(null);
    setErrorMsg('');
    setDragOver(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleClose = (open: boolean) => {
    if (!open) resetState();
    onOpenChange(open);
  };

  const handleFileSelect = (selectedFile: File) => {
    const validExts = ['.txt', '.json'];
    const ext = '.' + selectedFile.name.split('.').pop()?.toLowerCase();
    if (!validExts.includes(ext)) {
      toast.error('仅支持 TXT 和 JSON 格式');
      return;
    }
    if (selectedFile.size > 50 * 1024 * 1024) {
      toast.error('文件大小超过50MB限制');
      return;
    }
    setFile(selectedFile);
    setImportState('idle');
    setResult(null);
    setErrorMsg('');
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) handleFileSelect(droppedFile);
  }, [handleFileSelect]);

  const handleImport = async () => {
    if (!file) return;
    setImportState('uploading');
    setErrorMsg('');

    try {
      const formData = new FormData();
      formData.append('file', file);
      if (categoryId) formData.append('categoryId', categoryId);
      formData.append('status', status);
      formData.append('format', format);

      const data = await apiFetch<{ success: boolean; novel: ImportResult; error?: string }>(
        '/api/novels/import',
        {
          method: 'POST',
          body: formData,
        },
      );

      if (data.success && data.novel) {
        setImportState('success');
        setResult(data.novel);
        toast.success(`导入成功: ${data.novel.title} (${data.novel.chapterCount}章)`);
        onImportSuccess?.(data.novel);
      } else {
        throw new Error(data.error || '导入失败');
      }
    } catch (err) {
      setImportState('error');
      const msg = err instanceof FetchError ? err.message : err instanceof Error ? err.message : '导入失败';
      setErrorMsg(msg);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            导入小说
          </DialogTitle>
          <DialogDescription>
            上传 TXT 或 JSON 文件批量创建小说和章节
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* File drop zone */}
          <div
            className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
              dragOver
                ? 'border-primary bg-primary/5'
                : file
                  ? 'border-muted-foreground/30'
                  : 'border-muted-foreground/20 hover:border-muted-foreground/40'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileSelect(f);
              }}
            />

            {file ? (
              <div className="flex items-center gap-3">
                <FileText className="h-8 w-8 text-primary shrink-0" />
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{formatSize(file.size)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={(e) => { e.stopPropagation(); setFile(null); setImportState('idle'); }}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="h-8 w-8 mx-auto text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">拖放文件到此处，或点击选择</p>
                <p className="text-xs text-muted-foreground/60">支持 TXT、JSON 格式 (最大50MB)</p>
              </div>
            )}
          </div>

          {/* Options row */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="import-format" className="text-xs">文件格式</Label>
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger id="import-format" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动检测</SelectItem>
                  <SelectItem value="txt">TXT</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="import-category" className="text-xs">分类</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger id="import-category" className="h-8 text-xs">
                  <SelectValue placeholder="无分类" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">无分类</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="import-status" className="text-xs">状态</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="import-status" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ongoing">连载中</SelectItem>
                  <SelectItem value="completed">已完结</SelectItem>
                  <SelectItem value="hiatus">暂停中</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Format help */}
          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-1.5">
            <p className="font-medium text-foreground">文件格式说明</p>
            <div>
              <span className="font-medium">TXT:</span> 自动识别「第X章」等分隔符，文件名作为小说标题
            </div>
            <div>
              <span className="font-medium">JSON:</span>{' '}
              <code className="rounded bg-muted px-1 text-[11px]">{'{ "title": "...", "author": "...", "chapters": [{ "title": "...", "content": "..." }] }'}</code>
            </div>
          </div>

          {/* Import result */}
          {importState === 'success' && result && (
            <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 p-3 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
              <div className="text-xs">
                <p className="font-medium text-emerald-700 dark:text-emerald-300">导入成功</p>
                <p className="text-emerald-600 dark:text-emerald-400 mt-0.5">
                  {result.title} · {result.author} · {result.chapterCount}章 · {(result.wordCount / 10000).toFixed(1)}万字
                </p>
              </div>
            </div>
          )}

          {importState === 'error' && errorMsg && (
            <div className="rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 p-3 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
              <p className="text-xs text-red-600 dark:text-red-400">{errorMsg}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {importState === 'success' ? (
            <Button onClick={() => handleClose(false)} className="gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              完成
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleClose(false)}>取消</Button>
              <Button
                onClick={handleImport}
                disabled={!file || importState === 'uploading'}
                className="gap-1.5"
              >
                {importState === 'uploading' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {importState === 'uploading' ? '导入中...' : '开始导入'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
