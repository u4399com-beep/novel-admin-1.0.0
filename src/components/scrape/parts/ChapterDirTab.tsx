'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { SelectorField } from './SelectorField';
import { PaginationField } from './PaginationField';
import type { EditorFormAccess } from './types';

export function ChapterDirTab({ form, setSelector, setPagination }: EditorFormAccess) {
  const { register, watch, formState: { errors } } = form;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium">目录页URL</Label>
        <Input
          placeholder="https://example.com/book/{bookUrl}"
          {...register('chapterListUrl')}
        />
        <p className="text-xs text-muted-foreground">
          使用 {'{bookUrl}'} 作为书籍详情页URL占位符
        </p>
      </div>

      <Separator />

      <div className="space-y-4">
        <SelectorField
          label="目录列表选择器"
          value={watch('chapterListSelector')}
          onChange={(v) => setSelector('chapterListSelector', v)}
          errors={errors.chapterListSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
        <SelectorField
          label="章节标题选择器"
          value={watch('chapterTitleSelector')}
          onChange={(v) => setSelector('chapterTitleSelector', v)}
          errors={errors.chapterTitleSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
        <SelectorField
          label="章节链接选择器"
          value={watch('chapterLinkSelector')}
          onChange={(v) => setSelector('chapterLinkSelector', v)}
          errors={errors.chapterLinkSelector as { type?: { message?: string }; value?: { message?: string } }}
        />
      </div>

      <Separator />

      <PaginationField
        label="目录分页配置"
        value={watch('chapterPagination')}
        onChange={(v) => setPagination('chapterPagination', v)}
        errors={errors.chapterPagination as { type?: { message?: string }; selector?: { message?: string }; maxPage?: { message?: string } }}
      />
    </div>
  );
}