"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod/v4";

import { safeResolver } from "@/lib/safe-resolver";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { Category, Tag } from "@/types";

// ─── Schema ────────────────────────────────────────────────────────────────────

const novelFormSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(100, "标题不能超过100个字符"),
  author: z.string().max(50, "作者名不能超过50个字符").default("佚名"),
  description: z.string().max(2000, "简介不能超过2000字符").default(""),
  status: z.enum(["ongoing", "completed", "hiatus"]).default("ongoing"),
  categoryId: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
});

type NovelFormValues = z.infer<typeof novelFormSchema>;

// ─── Component ─────────────────────────────────────────────────────────────────

export default function NovelFormDialog() {
  const {
    novelFormOpen,
    setNovelFormOpen,
    editingNovel,
    categories,
    setCategories,
    tags,
    setTags,
    triggerRefresh,
  } = useAppStore();

  const [submitting, setSubmitting] = useState(false);
  const [apiCategories, setApiCategories] = useState<Category[]>([]);
  const [apiTags, setApiTags] = useState<Tag[]>([]);

  const isEditing = !!editingNovel;

  // ── Fetch categories & tags on mount ──
  const fetchOptions = useCallback(async () => {
    try {
      const [catRes, tagRes] = await Promise.all([
        fetch("/api/categories"),
        fetch("/api/tags"),
      ]);
      if (catRes.ok) {
        const cats: Category[] = await catRes.json();
        setApiCategories(cats);
        setCategories(cats);
      }
      if (tagRes.ok) {
        const ts: Tag[] = await tagRes.json();
        setApiTags(ts);
        setTags(ts);
      }
    } catch {
      // silent fail – use store data as fallback
    }
  }, [setCategories, setTags]);

  useEffect(() => {
    if (novelFormOpen) {
      fetchOptions();
    }
  }, [novelFormOpen, fetchOptions]);

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
    },
  });

  const watchedTags = useWatch({ control: form.control, name: "tags" });
  const selectedTagIds = watchedTags ?? [];

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
          tags: editingNovel.tags.map((t) => t.tag.id),
        });
      } else {
        form.reset({
          title: "",
          author: "佚名",
          description: "",
          status: "ongoing",
          categoryId: null,
          tags: [],
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
      const body = {
        title: values.title,
        author: values.author || "佚名",
        description: values.description || null,
        status: values.status,
        categoryId: values.categoryId,
        tags: values.tags,
      };

      const url = isEditing ? `/api/novels/${editingNovel.id}` : "/api/novels";
      const method = isEditing ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(isEditing ? "编辑成功" : "创建成功", {
          description: isEditing
            ? `《${values.title}》已更新`
            : `《${values.title}》已创建`,
        });
        setNovelFormOpen(false);
        triggerRefresh('novels');
        triggerRefresh('dashboard');
      } else {
        const err = await res.json().catch(() => null);
        toast.error(isEditing ? "编辑失败" : "创建失败", {
          description: err?.error || "请稍后重试",
        });
      }
    } catch {
      toast.error(isEditing ? "编辑失败" : "创建失败", {
        description: "网络错误，请稍后重试",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={novelFormOpen} onOpenChange={setNovelFormOpen}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
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
            {/* Title */}
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    标题 <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="请输入小说标题" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Author */}
            <FormField
              control={form.control}
              name="author"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>作者</FormLabel>
                  <FormControl>
                    <Input placeholder="佚名" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Description */}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>简介</FormLabel>
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

            {/* Status */}
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>状态</FormLabel>
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
                      <SelectItem value="hiatus">暂停</SelectItem>
                    </SelectContent>
                  </Select>
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
                  <div className="flex flex-wrap gap-2 rounded-md border border-input p-3 min-h-[44px]">
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