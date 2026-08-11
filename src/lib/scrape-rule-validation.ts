/**
 * Shared validation constants and functions for scrape-rules API routes.
 * Eliminates duplication between route.ts (POST) and [id]/route.ts (PUT).
 */

import { sanitizeField } from './api-utils';
import { isSafeUrl } from './sanitize';

// ── Valid option sets ──

export const VALID_SCRAPE_MODES = ['incremental', 'full'] as const;
export const VALID_ENGINES = ['cheerio', 'playwright', 'firecrawl', 'agentql', 'cloud-browser', 'scrapling'] as const;
export const VALID_STORAGE_MODES = ['database', 'file'] as const;
export const VALID_DEDUP_MODES = ['url', 'title', 'both'] as const;
export const VALID_SELECTOR_TYPES = ['css', 'xpath', 'regex'] as const;
export const VALID_PAGINATION_TYPES = ['next', 'page'] as const;

// ── Limits ──

export const MAX_SELECTOR_VALUE_LENGTH = 500;
export const MAX_PAGINATION_SELECTOR_LENGTH = 500;
export const MAX_PAGINATION_MAX_PAGE = 100;
export const MAX_THREAD = 10;
export const MIN_THREAD = 1;
export const MAX_DELAY = 60000;

// ── Selector field names for iteration ──

const SELECTOR_FIELDS = [
  { key: 'listSelector', name: '列表选择器' },
  // Book info selectors
  { key: 'bookTitleSelector', name: '书名选择器' },
  { key: 'bookAuthorSelector', name: '作者选择器' },
  { key: 'bookCategorySelector', name: '分类选择器' },
  { key: 'bookKeywordsSelector', name: '关键词选择器' },
  { key: 'bookDescriptionSelector', name: '简介选择器' },
  { key: 'bookCoverSelector', name: '封面选择器' },
  { key: 'bookStatusSelector', name: '状态选择器' },
  // Chapter selectors
  { key: 'chapterListSelector', name: '章节列表选择器' },
  { key: 'chapterTitleSelector', name: '章节标题选择器' },
  { key: 'chapterLinkSelector', name: '章节链接选择器' },
  // Content selectors
  { key: 'contentTitleSelector', name: '内容标题选择器' },
  { key: 'contentSelector', name: '内容选择器' },
] as const;

const PAGINATION_FIELDS = [
  { key: 'listPagination', name: '列表分页' },
  { key: 'chapterPagination', name: '章节分页' },
  // NOTE: contentPagination is intentionally excluded here.
  // It has its own validateContentPagination() with a stricter maxPage limit (20 vs 100).
] as const;

// ── Cloud Browser Config ──

/**
 * Build a cloudBrowserConfig JSON string from raw URL and provider values.
 * Returns null if url is falsy, has an invalid protocol, or fails URL parsing.
 */
export function buildCloudBrowserConfig(url: unknown, provider: unknown): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  } catch { return null; }
  // Self-protect against SSRF regardless of caller validation
  if (!isSafeUrl(String(url))) return null;
  return JSON.stringify({
    provider: ['browserless', 'steel'].includes(String(provider)) ? provider : 'browserless',
    apiUrl: String(url).slice(0, 500),
  });
}

// ── Validators ──

function validateSelector(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
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
  // Validate optional `extract` attribute name
  if (obj.extract !== undefined) {
    if (typeof obj.extract !== 'string') {
      return `${fieldName}的extract必须是字符串`;
    }
    // Only allow safe attribute names (alphanumeric + hyphens, common HTML attrs)
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(obj.extract)) {
      return `${fieldName}的extract属性名无效`;
    }
  }
  return null;
}

function validatePagination(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
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

/** Validate save path: must start with /app/public/ and contain no path traversal. Throws ValidationError if provided but invalid. */
export function validateSavePath(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const val = sanitizeField(value, 500);
  if (!val) return null;
  if (!val.startsWith('/app/public/') || val.includes('..')) {
    throw new ValidationError('保存路径必须以 /app/public/ 开头且不能包含 ..');
  }
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
export interface ScrapeParams {
  scrapeMode: typeof VALID_SCRAPE_MODES[number];
  engine: typeof VALID_ENGINES[number];
  storageMode: typeof VALID_STORAGE_MODES[number];
  dedupMode: typeof VALID_DEDUP_MODES[number];
  threadCount: number;
  minDelay: number;
  maxDelay: number;
}

export function parseScrapeParams(body: Record<string, unknown>): ScrapeParams {
  const sm = typeof body.scrapeMode === 'string' && VALID_SCRAPE_MODES.includes(body.scrapeMode) ? body.scrapeMode : 'incremental';
  const en = typeof body.engine === 'string' && VALID_ENGINES.includes(body.engine) ? body.engine : 'cheerio';
  const st = typeof body.storageMode === 'string' && VALID_STORAGE_MODES.includes(body.storageMode) ? body.storageMode : 'database';
  const dd = typeof body.dedupMode === 'string' && VALID_DEDUP_MODES.includes(body.dedupMode) ? body.dedupMode : 'url';
  return {
    scrapeMode: sm as typeof VALID_SCRAPE_MODES[number],
    engine: en as typeof VALID_ENGINES[number],
    storageMode: st as typeof VALID_STORAGE_MODES[number],
    dedupMode: dd as typeof VALID_DEDUP_MODES[number],
    threadCount: Math.min(Math.max(MIN_THREAD, Number(body.threadCount) || 3), MAX_THREAD),
    minDelay: Math.max(0, Number(body.minDelay) || 1000),
    maxDelay: Math.min(MAX_DELAY, Math.max(
      Number(body.minDelay) || 1000,
      Number(body.maxDelay) || 3000
    )),
  };
}

// ── Clean Config Validation ──

const MAX_CLEAN_PATTERN_LENGTH = 200;
const MAX_CLEAN_PATTERNS_COUNT = 100;
const MAX_CONTENT_PAGINATION_MAX_PAGE = 20;

/**
 * Validate and sanitize the cleanConfig object.
 * - removeAds/cleanHtml: must be boolean if provided
 * - removePatterns/adPatterns: must be string (newline-separated) or string[]
 * - Individual patterns are length-limited to prevent abuse
 * - Total pattern count is capped
 *
 * Returns the sanitized cleanConfig JSON string, or throws ValidationError.
 */
export function validateCleanConfig(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('cleanConfig必须是对象');
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // Boolean fields
  if (obj.removeAds !== undefined) {
    if (typeof obj.removeAds !== 'boolean') {
      throw new ValidationError('cleanConfig.removeAds必须是布尔值');
    }
    result.removeAds = obj.removeAds;
  }
  if (obj.cleanHtml !== undefined) {
    if (typeof obj.cleanHtml !== 'boolean') {
      throw new ValidationError('cleanConfig.cleanHtml必须是布尔值');
    }
    result.cleanHtml = obj.cleanHtml;
  }

  // Pattern fields: normalize string (newline-sep) to string[]
  if (obj.removeSelectors !== undefined) {
    result.removeSelectors = validateAndNormalizePatterns(obj.removeSelectors, 'removeSelectors');
  }
  if (obj.removePatterns !== undefined) {
    result.removePatterns = validateAndNormalizePatterns(obj.removePatterns, 'removePatterns');
  }
  if (obj.adPatterns !== undefined) {
    result.adPatterns = validateAndNormalizePatterns(obj.adPatterns, 'adPatterns');
  }

  return JSON.stringify(result);
}

/**
 * Validate a contentPagination field with stricter maxPage limit.
 * Content pagination should not exceed MAX_CONTENT_PAGINATION_MAX_PAGE (20).
 */
export function validateContentPagination(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'contentPagination格式错误，必须是包含type和selector的对象';
  }
  const obj = value as Record<string, unknown>;
  if (!VALID_PAGINATION_TYPES.includes(obj.type as typeof VALID_PAGINATION_TYPES[number])) {
    return `contentPagination的type必须是: ${VALID_PAGINATION_TYPES.join(', ')}`;
  }
  if (typeof obj.selector !== 'string') {
    return 'contentPagination的selector必须是字符串';
  }
  if (obj.selector.length > MAX_PAGINATION_SELECTOR_LENGTH) {
    return `contentPagination的selector不能超过${MAX_PAGINATION_SELECTOR_LENGTH}个字符`;
  }
  if (obj.maxPage !== undefined) {
    const maxPage = Number(obj.maxPage);
    if (!Number.isFinite(maxPage) || maxPage < 1 || maxPage > MAX_CONTENT_PAGINATION_MAX_PAGE) {
      return `contentPagination的maxPage必须在1-${MAX_CONTENT_PAGINATION_MAX_PAGE}之间`;
    }
  }
  return null;
}

/**
 * Normalize a patterns field (string or string[]) to a newline-separated string.
 * Validates individual pattern length and total count.
 */
function validateAndNormalizePatterns(value: unknown, fieldName: string): string {
  let patterns: string[];

  if (typeof value === 'string') {
    patterns = value.split('\n').map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(value)) {
    patterns = value.filter((p): p is string => typeof p === 'string').map(s => s.trim()).filter(Boolean);
  } else {
    throw new ValidationError(`cleanConfig.${fieldName}必须是字符串或字符串数组`);
  }

  if (patterns.length > MAX_CLEAN_PATTERNS_COUNT) {
    throw new ValidationError(`cleanConfig.${fieldName}不能超过${MAX_CLEAN_PATTERNS_COUNT}条规则`);
  }

  const sanitized = patterns.map(p => {
    if (p.length > MAX_CLEAN_PATTERN_LENGTH) {
      return p.slice(0, MAX_CLEAN_PATTERN_LENGTH);
    }
    return p;
  });

  return sanitized.join('\n');
}