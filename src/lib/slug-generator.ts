/**
 * Pseudo-static URL slug generator utilities.
 * Supports three modes: 'id' (numeric), 'pinyin' (from title), 'random' (alphanumeric).
 */

import { pinyin } from 'pinyin';

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const RANDOM_SLUG_DEFAULT_LENGTH = 8;

// ═══════════════════════════════════════════════════════════════════
// Pinyin Slug
// ═══════════════════════════════════════════════════════════════════

/**
 * Convert a Chinese title to a URL-friendly pinyin slug.
 * Example: "阳间送葬人" → "yang-jian-song-zang-ren"
 */
export function generatePinyinSlug(title: string): string {
  // Strip non-CJK and non-ASCII letters (keep CJK, letters, digits)
  // For CJK characters, convert to pinyin; for ASCII letters, keep as-is.
  const parts: string[] = [];

  for (const char of title) {
    const code = char.codePointAt(0) ?? 0;

    // CJK Unified Ideographs range (includes common Chinese characters)
    if (code >= 0x4e00 && code <= 0x9fff) {
      const py = pinyin(char);
      // py is string[][] like [["yáng"]]
      if (py.length > 0 && py[0].length > 0) {
        // Remove tone marks: normalize to NFD, strip combining diacritical marks
        const noTone = py[0][0]
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        parts.push(noTone);
      }
    } else if (/[a-zA-Z0-9]/.test(char)) {
      parts.push(char.toLowerCase());
    }
    // Skip spaces, punctuation, and other characters
  }

  const slug = parts.join('-');
  // Truncate to reasonable length (max 80 chars)
  return slug.length > 80 ? slug.slice(0, 80).replace(/-$/, '') : slug;
}

// ═══════════════════════════════════════════════════════════════════
// Random Slug
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate a random alphanumeric slug of the specified length.
 * Uses crypto.randomBytes for sufficient entropy.
 */
export function generateRandomSlug(length: number = RANDOM_SLUG_DEFAULT_LENGTH): string {
  const len = Math.max(4, Math.min(32, length || RANDOM_SLUG_DEFAULT_LENGTH));
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < len; i++) {
    result += ALPHANUMERIC[bytes[i] % ALPHANUMERIC.length];
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// ID Slug
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate a numeric ID slug from a novel's creation order.
 * This uses a hash of the cuid to produce a stable numeric string,
 * or can be overridden with an explicit numeric offset.
 */
export function generateIdSlug(novelId: string): string {
  // Generate a deterministic numeric string from the cuid.
  // Use a simple hash to produce a 1-6 digit number.
  let hash = 0;
  for (let i = 0; i < novelId.length; i++) {
    const char = novelId.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0; // hash * 31 + char
  }
  // Map to positive 5-digit number
  const numeric = Math.abs(hash) % 100000 + 10000; // 10000-99999
  return String(numeric);
}

// ═══════════════════════════════════════════════════════════════════
// Main Dispatcher
// ═══════════════════════════════════════════════════════════════════

export type SlugType = 'id' | 'pinyin' | 'random';

export interface SlugResult {
  slug: string;
  type: SlugType;
}

/**
 * Generate a slug for a novel based on the specified type.
 */
export function generateSlugForNovel(
  novel: { id: string; title: string },
  type: string,
  length?: number
): SlugResult {
  const slugType = type as SlugType;

  switch (slugType) {
    case 'id':
      return { slug: generateIdSlug(novel.id), type: 'id' };
    case 'pinyin':
      return { slug: generatePinyinSlug(novel.title), type: 'pinyin' };
    case 'random':
      return { slug: generateRandomSlug(length), type: 'random' };
    default:
      throw new Error(`不支持的slug类型: ${type}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a string looks like a Prisma cuid (starts with 'c', 25+ chars, URL-safe base64).
 */
export function isCuid(s: string): boolean {
  return /^c[a-z0-9]{24,}$/.test(s);
}

/**
 * Validate a slug string (URL-safe, no special chars).
 */
export function isValidSlug(s: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(s) || /^[a-zA-Z0-9]$/.test(s);
}
