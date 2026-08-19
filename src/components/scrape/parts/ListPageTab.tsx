'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Loader2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { SelectorField } from './SelectorField';
import { PaginationField } from './PaginationField';
import type { EditorFormAccess } from './types';

export function ListPageTab({ form, setSelector, setPagination }: EditorFormAccess) {
  const { register, watch, formState: { errors } } = form;
  const listUrl = watch('listUrl');
  const [testing, setTesting] = useState(false);

  const handleTestConnection = async () => {
    const url = listUrl?.trim();
    if (!url) {
      toast.error('请先填写列表页URL');
      return;
    }
    setTesting(true);
    try {
      await apiFetch('/api/scrape-rules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      toast.success('连接测试成功，列表页可正常访问');
    } catch {
      toast.error('连接测试失败，请检查URL是否正确');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">列表页URL模板</Label>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            placeholder="https://example.com/list/{page}"
            {...register('listUrl')}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            disabled={testing || !listUrl?.trim()}
            onClick={handleTestConnection}
            aria-label="测试连接"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            测试连接
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          使用 {'{page}'} 作为页码占位符
        </p>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-sm font-medium">采集方式</Label>
        <p className="text-xs text-muted-foreground">选择提取书籍链接的选择器类型和表达式</p>
        <SelectorField
          label="书籍链接选择器"
          value={watch('listSelector')}
          onChange={(v) => setSelector('listSelector', v)}
          errors={errors.listSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
      </div>

      <Separator />

      <PaginationField
        value={watch('listPagination')}
        onChange={(v) => setPagination('listPagination', v)}
        errors={errors.listPagination as { type?: { message?: string }; selector?: { message?: string }; maxPage?: { message?: string } }}
      />
    </div>
  );
}