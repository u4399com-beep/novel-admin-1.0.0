/**
 * Shared Regex Safety Utilities
 * Prevents Regular Expression Denial of Service (ReDoS) attacks via:
 *   1. Static dangerous-pattern detection (nested/overlapping quantifiers)
 *   2. Text length truncation for match operations (500K char limit)
 *   3. V8 engine's built-in regex execution limit as runtime backstop
 */

import { logger } from './logger';

export const DANGEROUS_REGEX_PATTERNS: RegExp[] = [
  /\([^)]*\+[^)]*\)\+/,           // (x+)+
  /\(\?:[^)]*\+[^)]*\)\+/,        // (?:x+)+
  /\(\?:[^)]*\*[^)]*\)\*/,        // (?:x*)*
  /\([^)]*\*[^)]*\)\+/,           // (x*)+
  /\([^)]*\*[^)]*\)\*/,           // (x*)*
  /\(\?:[^)]*\)[\*\+]\{/,      // (?:...)+{  or (?:...)*{
  /\([^)]*\)[\*\+]\{/,          // (...)+{  or (...)*{
  /\{\d+,?\d*\}\{/,             // {n,}{
  /\[\^?\]\([^)]*\)\{/,       // [^](x){
];

export function isDangerousRegex(pattern: string): boolean {
  for (const dp of DANGEROUS_REGEX_PATTERNS) {
    if (dp.test(pattern)) {
      logger.warn('Security', `Blocked potentially dangerous regex: ${pattern.substring(0, 100)}`);
      return true;
    }
  }
  return false;
}

const MAX_TEXT_LENGTH = 500000;

/** Hard limit for safeRegexReplace — higher than match to avoid truncating content mid-cleaning */
const MAX_REPLACE_TEXT_LENGTH = 5_000_000; // 5MB

export function safeRegexMatch(text: string, pattern: string, flags?: string): RegExpMatchArray | null {
  if (isDangerousRegex(pattern)) return null;

  const searchIn = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;

  try {
    return searchIn.match(new RegExp(pattern, flags));
  } catch {
    return null;
  }
}

export function safeRegexReplace(
  text: string,
  pattern: string,
  replacement: string,
  flags?: string,
  maxTextLength: number = MAX_REPLACE_TEXT_LENGTH,
): string {
  if (isDangerousRegex(pattern)) return text;
  try {
    const regex = new RegExp(pattern, flags);
    // Apply a hard length limit to prevent memory exhaustion from extremely large inputs.
    // The default (5MB) is high enough to never truncate normal novel content,
    // but prevents OOM on pathological inputs.
    const searchIn = text.length > maxTextLength ? text.substring(0, maxTextLength) : text;
    return searchIn.replace(regex, replacement);
  } catch {
    return text;
  }
}
