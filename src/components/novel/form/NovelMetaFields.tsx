"use client";

import { UseFormReturn, useWatch } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Category, Tag } from "@/types";
import type { NovelFormValues } from "./types";

// ─── Status badge config for preview ─────────────────────────────────────────

export const STATUS_BADGE_CONFIG: Record<string, { label: string; className: string }> = {
  ongoing: { label: '连载中', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400 border-blue-200 dark:border-blue-800/50' },
  completed: { label: '已完结', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50' },
  hiatus: { label: '暂停中', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border-amber-200 dark:border-amber-800/50' },
};

interface NovelMetaFieldsProps {
  form: UseFormReturn<NovelFormValues>;
  allCategories: Category[];
  allTags: Tag[];
}

export function NovelMetaFields({ form, allCategories, allTags }: NovelMetaFieldsProps) {
  const watchedTitle = useWatch({ control: form.control, name: "title" }) ?? '';
  const watchedAuthor = useWatch({ control: form.control, name: "author" }) ?? '';
  const watchedDescription = useWatch({ control: form.control, name: "description" }) ?? '';
  const watchedStatus = useWatch({ control: form.control, name: "status" });
  const watchedTags = useWatch({ control: form.control, name: "tags" }) ?? [];

  const titleCharCount = typeof watchedTitle === 'string' ? watchedTitle.length : 0;
  const authorCharCount = typeof watchedAuthor === 'string' ? watchedAuthor.length : 0;
  const descriptionCharCount = typeof watchedDescription === 'string' ? watchedDescription.length : 0;

  const statusBadge = watchedStatus ? STATUS_BADGE_CONFIG[watchedStatus] : null;

  const toggleTag = (tagId: string) => {
    const current = form.getValues("tags");
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    form.setValue("tags", updated);
  };

  return (
    <>
      {/* Title with char count */}
      <FormField
        control={form.control}
        name="title"
        render={({ field }) => (
          <FormItem>
            <div className="flex items-center justify-between">
              <FormLabel>
                标题 <span className="text-destructive">*</span>
              </FormLabel>
              <span className={`text-xs tabular-nums ${titleCharCount > 100 ? 'text-destructive' : 'text-muted-foreground'}`}>
                {titleCharCount}/100
              </span>
            </div>
            <FormControl>
              <Input placeholder="请输入小说标题" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* Author with char count */}
      <FormField
        control={form.control}
        name="author"
        render={({ field }) => (
          <FormItem>
            <div className="flex items-center justify-between">
              <FormLabel>作者</FormLabel>
              <span className={`text-xs tabular-nums ${authorCharCount > 50 ? 'text-destructive' : 'text-muted-foreground'}`}>
                {authorCharCount}/50
              </span>
            </div>
            <FormControl>
              <Input placeholder="佚名" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* Description with char count */}
      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <div className="flex items-center justify-between">
              <FormLabel>简介</FormLabel>
              <span className={`text-xs tabular-nums ${descriptionCharCount > 2000 ? 'text-destructive' : 'text-muted-foreground'}`}>
                {descriptionCharCount}/2000
              </span>
            </div>
            <FormControl>
              <Textarea
                placeholder="请输入小说简介..."
                className="min-h-[80px]"
                rows={3}
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* Status with badge preview */}
      <FormField
        control={form.control}
        name="status"
        render={({ field }) => (
          <FormItem>
            <FormLabel>状态</FormLabel>
            <div className="flex items-center gap-3">
              <Select
                value={field.value}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择状态" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="ongoing">连载中</SelectItem>
                  <SelectItem value="completed">已完结</SelectItem>
                  <SelectItem value="hiatus">暂停中</SelectItem>
                </SelectContent>
              </Select>
              {statusBadge && (
                <Badge variant="outline" className={statusBadge.className}>
                  {statusBadge.label}
                </Badge>
              )}
            </div>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* Category */}
      <FormField
        control={form.control}
        name="categoryId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>分类</FormLabel>
            <Select
              value={field.value ?? "none"}
              onValueChange={(val) =>
                field.onChange(val === "none" ? null : val)
              }
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择分类" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="none">无分类</SelectItem>
                {allCategories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block size-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: cat.color }}
                      />
                      {cat.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* Tags */}
      <FormField
        control={form.control}
        name="tags"
        render={() => (
          <FormItem>
            <FormLabel>标签</FormLabel>
            <div role="group" aria-labelledby="tag-label" className="flex flex-wrap gap-2 rounded-md border border-input p-3 min-h-[44px]">
              <span id="tag-label" className="sr-only">标签选择</span>
              {allTags.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  暂无标签，请先创建标签
                </span>
              ) : (
                allTags.map((tag) => {
                  const isSelected = watchedTags.includes(tag.id);
                  return (
                    <label
                      key={tag.id}
                      className="flex items-center gap-1.5 cursor-pointer select-none"
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleTag(tag.id)}
                      />
                      <span
                        className="text-xs font-medium px-1.5 py-0.5 rounded-md"
                        style={{
                          backgroundColor: isSelected
                            ? `${tag.color}20`
                            : "transparent",
                          color: isSelected
                            ? tag.color
                            : "var(--muted-foreground)",
                          border: `1px solid ${
                            isSelected
                              ? `${tag.color}40`
                              : "var(--border)"
                          }`,
                        }}
                      >
                        {tag.name}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}
