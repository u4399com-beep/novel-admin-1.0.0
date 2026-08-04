/**
 * Shared validation constants and utilities used across multiple API routes.
 * Extracted from duplicated definitions in tags, categories, sites, etc.
 */

/** Regex for validating HEX color strings (#RGB, #RRGGBB, #RRGGBBAA) */
export const VALID_COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/**
 * Validate that a value is a plain JSON object (not array, not null).
 * Returns null if valid, or an error message string if invalid.
 */
export function validateJsonObject(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return `${fieldName} 必须是JSON对象`;
  }
  if (Object.keys(value).length === 0) return null;
  try {
    JSON.stringify(value);
    return null;
  } catch {
    return `${fieldName} 包含无法序列化的值`;
  }
}
