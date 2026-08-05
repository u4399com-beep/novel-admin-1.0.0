"use client";

import { useState } from "react";
import { ImageIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import type { NovelFormValues } from "./types";
import type { UseFormReturn } from "react-hook-form";
import { useWatch } from "react-hook-form";

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

interface NovelCoverUploadProps {
  form: UseFormReturn<NovelFormValues>;
}

export function NovelCoverUpload({ form }: NovelCoverUploadProps) {
  const watchedCoverUrl = useWatch({ control: form.control, name: "coverUrl" }) ?? '';

  return (
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
  );
}
