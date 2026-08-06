import { z } from "zod/v4";

export const novelFormSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(100, "标题不能超过100个字符"),
  author: z.string().max(50, "作者名不能超过50个字符").default("佚名"),
  description: z.string().max(2000, "简介不能超过2000字符").default(""),
  status: z.enum(["ongoing", "completed", "hiatus"]).default("ongoing"),
  categoryId: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  coverUrl: z.string().max(500, "封面URL不能超过500个字符").default(""),
});

export type NovelFormValues = z.infer<typeof novelFormSchema>;
