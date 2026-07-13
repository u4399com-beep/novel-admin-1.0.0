'use client';

import type { UseFormReturn } from 'react-hook-form';
import type { FormValues } from './schema';

// ==================== Domain Types ====================

export interface SelectorRule {
  type: 'css' | 'xpath' | 'regex';
  value: string;
}

export interface PaginationConfig {
  type: 'next' | 'page';
  selector: string;
  maxPage: number;
}

export interface AntiCrawlConfig {
  useJsRender: boolean;
  uaRotation: boolean;
  cookies: string;
  minDelay: number;
  maxDelay: number;
}

export interface CleanConfig {
  removeAds: boolean;
  cleanHtml: boolean;
  removePatterns: string;
  adPatterns: string;
}

export interface ScrapeRuleFormData {
  // Basic
  name: string;
  description: string;
  enabled: boolean;

  // List page
  listUrl: string;
  listSelector: SelectorRule;
  listPagination: PaginationConfig;

  // Book info
  bookTitleSelector: SelectorRule;
  bookAuthorSelector: SelectorRule;
  bookCategorySelector: SelectorRule;
  bookKeywordsSelector: SelectorRule;
  bookDescriptionSelector: SelectorRule;
  bookCoverSelector: SelectorRule;
  bookStatusSelector: SelectorRule;

  // Chapter directory
  chapterListUrl: string;
  chapterListSelector: SelectorRule;
  chapterTitleSelector: SelectorRule;
  chapterLinkSelector: SelectorRule;
  chapterPagination: PaginationConfig;

  // Chapter content
  contentTitleSelector: SelectorRule;
  contentSelector: SelectorRule;
  contentPagination: PaginationConfig;

  // Anti-crawl
  antiCrawlConfig: AntiCrawlConfig;

  // Storage
  storageMode: 'database' | 'file';
  filePath: string;
  coverSavePath: string;

  // Scrape strategy
  scrapeMode: 'incremental' | 'full';
  engine: 'cheerio' | 'playwright' | 'firecrawl' | 'agentql' | 'cloud-browser';

  // AgentQL queries
  agentqlQueries: string; // JSON string: {title:"...", author:"...", content:"..."}

  // Cloud Browser config
  cloudBrowserProvider: 'browserless' | 'steel';
  cloudBrowserUrl: string;
  threadCount: number;
  minDelay: number;
  maxDelay: number;
  enableShuffle: boolean;
  dedupMode: 'url' | 'title' | 'both';

  // Content cleaning
  cleanConfig: CleanConfig;
}

// ==================== Rule List Types ====================

export interface ScrapeRuleItem {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  engine?: string;
  storageMode: string;
  scrapeMode: string;
  createdAt: string;
  updatedAt: string;
  _count: { tasks: number };
}

// ==================== Editor Form Access ====================

export interface EditorFormAccess {
  form: UseFormReturn<FormValues>;
  setSelector: (field: keyof FormValues, val: SelectorRule) => void;
  setPagination: (field: keyof FormValues, val: PaginationConfig) => void;
}