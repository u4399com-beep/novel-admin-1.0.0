/**
 * Estimate reading time for Chinese web novels.
 * Default reading speed: 300 Chinese characters per minute.
 */
export function estimateReadingTime(
  wordCount: number,
  wordsPerMinute: number = 300,
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
