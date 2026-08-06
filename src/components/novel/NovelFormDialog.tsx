"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { safeResolver } from "@/lib/safe-resolver";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { useAppStore } from "@/stores/app-store";
import { apiFetch } from "@/lib/api-fetch";
import { novelFormSchema, type NovelFormValues } from "@/components/novel/form/types";
import { NovelMetaFields } from "@/components/novel/form/NovelMetaFields";
import { NovelCoverUpload } from "@/components/novel/form/NovelCoverUpload";
import type { Category, Tag } from "@/types";

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: safeResolver(novelFormSchema) as any,
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
            <NovelMetaFields form={form} allCategories={allCategories} allTags={allTags} />
            <NovelCoverUpload form={form} />

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