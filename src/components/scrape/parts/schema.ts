'use client';

import { z } from 'zod/v4';
import type { SelectorRule, PaginationConfig } from './types';

// ==================== Sub-schemas ====================

const selectorSchema = z.object({
  type: z.enum(['css', 'xpath', 'regex']),
  value: z.string(),
});

const paginationSchema = z.object({
  type: z.enum(['next', 'page']),
  selector: z.string(),
  maxPage: z.number().int().min(1).max(100),
});

// ==================== Defaults ====================

export const defaultSelector: SelectorRule = { type: 'css', value: '' };
export const defaultPagination: PaginationConfig = { type: 'next', selector: '', maxPage: 100 };

// ==================== Main Schema ====================

export const scrapeRuleSchema = z.object({
  name: z.string().min(1, '规则名称不能为空').max(200),
  description: z.string(),
  enabled: z.boolean(),

  listUrl: z.string(),
  listSelector: selectorSchema,
  listPagination: paginationSchema,

  bookTitleSelector: selectorSchema,
  bookAuthorSelector: selectorSchema,
  bookCategorySelector: selectorSchema,
  bookKeywordsSelector: selectorSchema,
  bookDescriptionSelector: selectorSchema,
  bookCoverSelector: selectorSchema,
  bookStatusSelector: selectorSchema,

  chapterListUrl: z.string(),
  chapterListSelector: selectorSchema,
  chapterTitleSelector: selectorSchema,
  chapterLinkSelector: selectorSchema,
  chapterPagination: paginationSchema,

  contentTitleSelector: selectorSchema,
  contentSelector: selectorSchema,
  contentPagination: paginationSchema,

  antiCrawlConfig: z.object({
    useJsRender: z.boolean(),
    uaRotation: z.boolean(),
    cookies: z.string(),
    minDelay: z.number().int().min(0),
    maxDelay: z.number().int().min(0),
  }),

  storageMode: z.enum(['database', 'file']),
  filePath: z.string(),
  coverSavePath: z.string(),

  scrapeMode: z.enum(['incremental', 'full']),
  engine: z.enum(['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser']),
  agentqlQueries: z.string(),
  cloudBrowserProvider: z.enum(['browserless', 'steel']),
  cloudBrowserUrl: z.string(),
  threadCount: z.number().int().min(1).max(10),
  minDelay: z.number().int().min(0),
  maxDelay: z.number().int().min(0),
  enableShuffle: z.boolean(),
  dedupMode: z.enum(['url', 'title', 'both']),

  cleanConfig: z.object({
    removeAds: z.boolean(),
    cleanHtml: z.boolean(),
    removePatterns: z.string(),
    adPatterns: z.string(),
  }),
});

export type FormValues = z.infer<typeof scrapeRuleSchema>;