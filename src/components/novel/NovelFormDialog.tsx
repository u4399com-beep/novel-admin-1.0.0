"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ImageIcon } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod/v4";

import { safeResolver } from "@/lib/safe-resolver";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/stores/app-store";
import { apiFetch } from "@/lib/api-fetch";
import type { Category, Tag, Novel } from "@/types";

// ─── Schema ────────────────────────────────────────────────────────────────────

const novelFormSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(100, "标题不能超过100个字符"),
  author: z.string().max(50, "作者名不能超过50个字符").default("佚名"),
  description: z.string().max(2000, "简介不能超过2000字符").default(""),
  status: z.enum(["ongoing", "completed", "hiatus"]).default("ongoing"),
  categoryId: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  coverUrl: z.string().max(500, "封面URL不能超过500个字符").default(""),

});

type NovelFormValues = z.infer<typeof novelFormSchema>;

// ─── Status badge config for preview ─────────────────────────────────────────

const STATUS_BADGE_CONFIG: Record<string, { label: string; className: string }> = {
  ongoing: { label: '连载中', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400 border-blue-200 dark:border-blue-800/50' },
  completed: { label: '已完结', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50' },
  hiatus: { label: '暂停中', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border-amber-200 dark:border-amber-800/50' },
};



// ─── Cover Image Preview ─────────────────────────────────────────────────────

function CoverImagePreview({ url }: { url: string }) {
  const [imgError, setImgError] = useState(false);

  if (!url.trim()) {
    return null;
  }

  return (
    <div className="w-20 h-28 rounded-md overflow-hidden border border-input shrink-0 bg-muted">
      {imgError ? (
        <div className="w-full h-full bg-gradient-to-br from-primary/20 via-primary/10 to-muted flex items-center justify-center">
          <ImageIcon className="size-5 text-muted-foreground" />
        </div>
      ) : (
        <img
          src={url}
          alt="封面预览"
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      )}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function NovelFormDialog() {
  const novelFormOpen = useAppStore((s) => s.novelFormOpen);
  const setNovelFormOpen = useAppStore((s) => s.setNovelFormOpen);
  const editingNovel = useAppStore((s) => s.editingNovel);
  const setEditingNovel = useAppStore((s) => s.setEditingNovel);
  const categories = useAppStore((s) => s.categories);
  const setCategories = useAppStore((s) => s.setCategories);
  const tags = useAppStore((s) => s.tags);
  const setTags = useAppStore((s) => s.setTags);
  const triggerRefresh = useAppStore((s) => s.triggerRefresh);

  const [submitting, setSubmitting] = useState(false);
  const [apiCategories, setApiCategories] = useState<Category[]>([]);
  const [apiTags, setApiTags] = useState<Tag[]>([]);

  const isEditing = !!editingNovel;

  // ── Fetch categories & tags on mount ──
  const fetchOptions = useCallback(async (signal?: AbortSignal) => {
    try {
      const [catRes, tagRes] = await Promise.allSettled([
        apiFetch<Category[]>("/api/categories", { signal }),
        apiFetch<Tag[]>("/api/tags", { signal }),
      ]);
      if (signal?.aborted) return;
      if (catRes.status === 'fulfilled') {
        setApiCategories(catRes.value);
        setCategories(catRes.value);
      }
      if (tagRes.status === 'fulfilled') {
        setApiTags(tagRes.value);
        setTags(tagRes.value);
      }
    } catch (err) {
      if (process.env.NODE_ENV === 'development') console.error('Failed to fetch categories/tags for form:', err);
    }
  }, [setCategories, setTags]);

  useEffect(() => {
    if (!novelFormOpen) return;
    if (categories.length === 0 || tags.length === 0) {
      const ac = new AbortController();
      fetchOptions(ac.signal);
      return () => ac.abort();
    }
  }, [novelFormOpen, fetchOptions, categories.length, tags.length]);

  // ── Merge store data with fetched data ──
  const allCategories = categories.length > 0 ? categories : apiCategories;
  const allTags = tags.length > 0 ? tags : apiTags;

  // ── Form ──
  const form = useForm<NovelFormValues>({
    resolver: safeResolver(novelFormSchema),
    defaultValues: {
      title: "",
      author: "佚名",
      description: "",
      status: "ongoing",
      categoryId: null,
      tags: [],
      coverUrl: "",
    },
  });

  const watchedTags = useWatch({ control: form.control, name: "tags" });
  const selectedTagIds = watchedTags ?? [];

  // Watched fields for reactive UI
  const watchedTitle = useWatch({ control: form.control, name: "title" }) ?? '';
  const watchedAuthor = useWatch({ control: form.control, name: "author" }) ?? '';
  const watchedDescription = useWatch({ control: form.control, name: "description" }) ?? '';
  const watchedStatus = useWatch({ control: form.control, name: "status" });
  const watchedCoverUrl = useWatch({ control: form.control, name: "coverUrl" }) ?? '';

  // ── Derived values ──
  const titleCharCount = typeof watchedTitle === 'string' ? watchedTitle.length : 0;
  const authorCharCount = typeof watchedAuthor === 'string' ? watchedAuthor.length : 0;
  const descriptionCharCount = typeof watchedDescription === 'string' ? watchedDescription.length : 0;

  // Status badge preview config
  const statusBadge = watchedStatus ? STATUS_BADGE_CONFIG[watchedStatus] : null;

  // ── Reset form when dialog opens / editingNovel changes ──
  useEffect(() => {
    if (novelFormOpen) {
      if (editingNovel) {
        form.reset({
          title: editingNovel.title,
          author: editingNovel.author || "佚名",
          description: editingNovel.description || "",
          status: editingNovel.status,
          categoryId: editingNovel.categoryId,
          tags: (editingNovel.tags ?? []).map((t) => t.tag.id),
          coverUrl: editingNovel.coverUrl || "",
        });
      } else {
        form.reset({
          title: "",
          author: "佚名",
          description: "",
          status: "ongoing",
          categoryId: null,
          tags: [],
          coverUrl: "",
        });
      }
    }
  }, [novelFormOpen, editingNovel, form]);

  // ── Tag toggle helper ──
  const toggleTag = (tagId: string) => {
    const current = form.getValues("tags");
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    form.setValue("tags", updated);
  };

  // ── Submit ──
  const onSubmit = async (values: NovelFormValues) => {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title: values.title,
        author: values.author || "佚名",
        description: values.description || null,
        status: values.status,
        categoryId: values.categoryId,
        tags: values.tags,
      };

      // Only include coverUrl if provided
      if (values.coverUrl.trim()) {
        body.coverUrl = values.coverUrl.trim();
      }

      const url = isEditing ? `/api/novels/${editingNovel.id}` : "/api/novels";
      const method = isEditing ? "PUT" : "POST";

      await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      toast.success(isEditing ? "编辑成功" : "创建成功", {
        description: isEditing
          ? `《${values.title}》已更新`
          : `《${values.title}》已创建`,
      });
      setNovelFormOpen(false);
      triggerRefresh('novels');
      triggerRefresh('dashboard');
    } catch {
      /* apiFetch already shows error toast */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={novelFormOpen} onOpenChange={(open) => {
      if (!open) setEditingNovel(null);
      setNovelFormOpen(open);
    }}>
      <DialogContent className="sm:max-w-[580px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "编辑小说" : "新建小说"}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "修改小说的基本信息"
              : "填写基本信息来创建一本新小说"}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
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

            {/* Cover URL with preview */}
            <FormField
              control={form.control}
              name="coverUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>封面图片URL</FormLabel>
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <FormControl>
                        <Input
                          placeholder="https://example.com/cover.jpg"
                          {...field}
                          aria-label="封面图片URL"
                        />
                      </FormControl>
                      <FormMessage />
                    </div>
                    <CoverImagePreview url={watchedCoverUrl} />
                  </div>
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
                        const isSelected = selectedTagIds
                          .includes(tag.id);
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

            {/* Actions */}
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setNovelFormOpen(false)}
                disabled={submitting}
              >
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {isEditing ? "保存中..." : "创建中..."}
                  </>
                ) : isEditing ? (
                  "保存"
                ) : (
                  "创建"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
