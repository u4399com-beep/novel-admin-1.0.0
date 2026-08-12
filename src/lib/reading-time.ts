/**
 * Estimate reading time for Chinese web novels.
 * Uses the shared READING_SPEED_CHARS_PER_MIN constant for consistency.
 */
import { READING_SPEED_CHARS_PER_MIN } from './constants';

export function estimateReadingTime(
  wordCount: number,
  wordsPerMinute: number = READING_SPEED_CHARS_PER_MIN,
): {
  hours: number;
  minutes: number;
  totalMinutes: number;
  display: string;
} {
  const totalMinutes = Math.ceil(wordCount / wordsPerMinute);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  let display: string;
  if (hours >= 1) {
    display = `约${hours}小时${minutes > 0 ? `${minutes}分钟` : ''}`;
  } else {
    display = `约${minutes}分钟`;
  }

  return { hours, minutes, totalMinutes, display };
}
