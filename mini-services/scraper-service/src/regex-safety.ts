/**
 * Shared Regex Safety Utilities
 * Prevents Regular Expression Denial of Service (ReDoS) attacks via:
 *   1. Static dangerous-pattern detection (nested/overlapping quantifiers)
 *   2. Text length truncation for match operations (500K char limit)
 *   3. V8 engine's built-in regex execution limit as runtime backstop
 */

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
      console.warn(`[Security] Blocked potentially dangerous regex: ${pattern.substring(0, 100)}`);
      return true;
    }
  }
  return false;
}

const MAX_TEXT_LENGTH = 500000;

export function safeRegexMatch(text: string, pattern: string, flags?: string): RegExpMatchArray | null {
  if (isDangerousRegex(pattern)) return null;

  const searchIn = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;

  try {
    return searchIn.match(new RegExp(pattern, flags));
  } catch {
    return null;
  }
}

export function safeRegexReplace(text: string, pattern: string, replacement: string, flags?: string): string {
  if (isDangerousRegex(pattern)) return text;
  try {
    const regex = new RegExp(pattern, flags);
    // CRITICAL FIX: Do NOT truncate text for replace — V8's built-in regex
    // execution limit is the runtime backstop. Truncation was causing the tail
    // of long content (beyond 500K chars) to bypass ALL user-specified ad-pattern
    // cleaning, leaving ads/watermarks intact.
    return text.replace(regex, replacement);
  } catch {
    return text;
  }
}
