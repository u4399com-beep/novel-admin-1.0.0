import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Safely extract hostname from a URL string.
 * Returns fallback (default: 'unknown') if URL is invalid.
 */
export function safeHostname(url: string, fallback = 'unknown'): string {
  try { return new URL(url).hostname; } catch { return fallback; }
}
