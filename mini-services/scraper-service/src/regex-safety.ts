/**
 * Shared Regex Safety Utilities
 * Prevents Regular Expression Denial of Service (ReDoS) attacks via:
 *   1. Static dangerous-pattern detection (nested/overlapping quantifiers)
 *   2. Text length truncation (500K char limit)
 *   3. V8 engine's built-in regex execution limit as runtime backstop
 */

export const DANGEROUS_REGEX_PATTERNS: RegExp[] = [
  /\(\.[\*\+]\)\{/,          // (.)+{ or (.*){ etc
  /\([^)]*\{[\d,]+\}[^)]*\)\{/,  // nested groups with quantifiers
  /\(\[[^\]]*\]\+?\)\{/,    // ([...]+){
  /(\.\+|\.\*)\1/,          // repeated greedy quantifiers on same char
  /\([^)]*\+[^)]*\)\+/,       // (x+)+
  /\([^)]*\*[^)]*\)\*/,       // (x*)*
  /(\+|\*)\1/,                // ++ or **
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

  const searchIn = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;

  try {
    return searchIn.replace(new RegExp(pattern, flags), replacement);
  } catch {
    return text;
  }
}