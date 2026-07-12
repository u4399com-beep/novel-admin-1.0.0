/**
 * Shared validation constants and functions for scrape-rules API routes.
 * Eliminates duplication between route.ts (POST) and [id]/route.ts (PUT).
 */

import { sanitizeField } from './api-utils';
import { isSafeUrl } from './sanitize';

// ── Valid option sets ──

export const VALID_SCRAPE_MODES = ['incremental', 'full'] as const;
export const VALID_ENGINES = ['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser'] as const;
export const VALID_STORAGE_MODES = ['database', 'file'] as const;
export const VALID_DEDUP_MODES = ['url', 'title', 'both'] as const;
export const VALID_SELECTOR_TYPES = ['css', 'xpath', 'regex'] as const;
export const VALID_PAGINATION_TYPES = ['next', 'page'] as const;

// ── Limits ──

export const MAX_SELECTOR_VALUE_LENGTH = 500;
export const MAX_PAGINATION_SELECTOR_LENGTH = 500;
export const MAX_PAGINATION_MAX_PAGE = 10000;
export const MAX_THREAD = 20;
export const MIN_THREAD = 1;
export const MAX_DELAY = 60000;

// ── Selector field names for iteration ──

export const SELECTOR_FIELDS = [
  { key: 'listSelector', name: '列表选择器' },
  { key: 'chapterListSelector', name: '章节列表选择器' },
  { key: 'chapterTitleSelector', name: '章节标题选择器' },
  { key: 'chapterLinkSelector', name: '章节链接选择器' },
  { key: 'contentTitleSelector', name: '内容标题选择器' },
  { key: 'contentSelector', name: '内容选择器' },
] as const;

export const PAGINATION_FIELDS = [
  { key: 'listPagination', name: '列表分页' },
  { key: 'chapterPagination', name: '章节分页' },
  { key: 'contentPagination', name: '内容分页' },
] as const;

// ── Validators ──

export function validateSelector(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value === null) {
    return `${fieldName}格式错误，必须是包含type和value的对象`;
  }
  const obj = value as Record<string, unknown>;
  if (!VALID_SELECTOR_TYPES.includes(obj.type as typeof VALID_SELECTOR_TYPES[number])) {
    return `${fieldName}的type必须是: ${VALID_SELECTOR_TYPES.join(', ')}`;
  }
  if (typeof obj.value !== 'string') {
    return `${fieldName}的value必须是字符串`;
  }
  if (obj.value.length > MAX_SELECTOR_VALUE_LENGTH) {
    return `${fieldName}的value不能超过${MAX_SELECTOR_VALUE_LENGTH}个字符`;
  }
  return null;
}

export function validatePagination(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value === null) {
    return `${fieldName}格式错误，必须是包含type和selector的对象`;
  }
  const obj = value as Record<string, unknown>;
  if (!VALID_PAGINATION_TYPES.includes(obj.type as typeof VALID_PAGINATION_TYPES[number])) {
    return `${fieldName}的type必须是: ${VALID_PAGINATION_TYPES.join(', ')}`;
  }
  if (typeof obj.selector !== 'string') {
    return `${fieldName}的selector必须是字符串`;
  }
  if (obj.selector.length > MAX_PAGINATION_SELECTOR_LENGTH) {
    return `${fieldName}的selector不能超过${MAX_PAGINATION_SELECTOR_LENGTH}个字符`;
  }
  if (obj.maxPage !== undefined) {
    const maxPage = Number(obj.maxPage);
    if (!Number.isFinite(maxPage) || maxPage < 1 || maxPage > MAX_PAGINATION_MAX_PAGE) {
      return `${fieldName}的maxPage必须在1-${MAX_PAGINATION_MAX_PAGE}之间`;
    }
  }
  return null;
}

/** Validate save path: must start with /app/public/ and contain no path traversal */
export function validateSavePath(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const val = sanitizeField(value, 500);
  if (val && (!val.startsWith('/app/public/') || val.includes('..'))) return null;
  return val;
}

/**
 * Validate a URL field for SSRF. Returns the sanitized value or throws.
 * Use in PUT routes where you want to reject (not silently skip) bad URLs.
 */
export function validateUrlField(value: unknown, fieldName: string, maxLength = 2000): string | null {
  const val = sanitizeField(value, maxLength);
  if (!val) return null;
  if (!isSafeUrl(val)) {
    throw new ValidationError(`${fieldName} 不允许访问内网或私有地址`);
  }
  return val;
}

/** Custom error class for validation failures that should return 400 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate all selector fields from a body object.
 * Returns an error message string or null if all valid.
 */
export function validateAllSelectors(
  body: Record<string, unknown>,
  onlyIfDefined = false
): string | null {
  for (const { key, name } of SELECTOR_FIELDS) {
    if (onlyIfDefined && body[key] === undefined) continue;
    const err = validateSelector(body[key], name);
    if (err) return err;
  }
  return null;
}

/**
 * Validate all pagination fields from a body object.
 * Returns an error message string or null if all valid.
 */
export function validateAllPaginations(
  body: Record<string, unknown>,
  onlyIfDefined = false
): string | null {
  for (const { key, name } of PAGINATION_FIELDS) {
    if (onlyIfDefined && body[key] === undefined) continue;
    const err = validatePagination(body[key], name);
    if (err) return err;
  }
  return null;
}

/**
 * Parse and clamp thread/delay values from body.
 */
export function parseScrapeParams(body: Record<string, unknown>) {
  return {
    scrapeMode: VALID_SCRAPE_MODES.includes(body.scrapeMode as typeof VALID_SCRAPE_MODES[number])
      ? body.scrapeMode
      : 'incremental',
    engine: VALID_ENGINES.includes(body.engine as typeof VALID_ENGINES[number])
      ? body.engine
      : 'cheerio',
    storageMode: VALID_STORAGE_MODES.includes(body.storageMode as typeof VALID_STORAGE_MODES[number])
      ? body.storageMode
      : 'database',
    dedupMode: VALID_DEDUP_MODES.includes(body.dedupMode as typeof VALID_DEDUP_MODES[number])
      ? body.dedupMode
      : 'url',
    threadCount: Math.min(Math.max(MIN_THREAD, Number(body.threadCount) || 3), MAX_THREAD),
    minDelay: Math.max(0, Number(body.minDelay) || 1000),
    maxDelay: Math.min(MAX_DELAY, Math.max(
      Number(body.minDelay) || 1000,
      Number(body.maxDelay) || 3000
    )),
  };
}