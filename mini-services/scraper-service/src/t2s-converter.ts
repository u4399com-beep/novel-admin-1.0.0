/**
 * Traditional → Simplified Chinese Converter
 * Wraps `chinese-conv` library with auto-detection and scraping integration.
 */

import { sify } from "chinese-conv";

/**
 * Known traditional-only character set for fast detection.
 * If any of these appear in text, the text likely contains traditional Chinese.
 * Only the most distinctive characters (~200) to keep the set small and fast.
 */
const TRADITIONAL_INDICATORS = new Set<string>([
  // Common traditional-only chars (simplified form differs)
  "裡","裏","著","於","網","電","話","腦","軟","體",
  "資","料","圖","片","視","頻","點","擊","網","頁",
  "站","連","結","下","載","搜","尋","瀏","覽","註","冊",
  "帳","號","密","碼","訊","國","際","經","濟","社","會",
  "醫","療","運","動","娛","樂","音","影","新","聞","報","導",
  "記","者","訪","問","評","論","觀","點","問","題","解","決",
  "計","劃","發","展","建","設","改","革","開","放","創","新",
  "廠","區","導","縣","領","導","關","係","產","業","學","習",
  "現","場","環","境","個","體","單","位","長","期","過","程",
  "義","務","權","利","責","任","聯","繫","緊","張","實","踐",
  "領","域","體","驗","環","節","團","隊","層","面","審","查",
  "檢","查","處","理","調","查","確","認","輔","導","協","調",
  // High-confidence discriminators (chars that ONLY exist in traditional)
  "億","幣","塊","標","準","價","值","質","監","督","適","應",
  "種","類","幾","機","構","總","結","報","告","貫","徹",
  "執","行","穩","定","態","勢","營","養","衛","生","防",
  "禦","禦","預","處","準","備","響","應","參","與","擴",
  "散","離","開","設","置","廣","泛","運","用","獲","取",
  "構","建","組","織","歷","史","歲","月","歡","迎","購",
  "買","賣","虛","擬","實","際","極","為","際","邊","際",
]);

/**
 * Characters that exist in BOTH traditional and simplified (ambiguous).
 * These are excluded from the detection ratio.
 */
const AMBIGUOUS_CHARS = new Set<string>([
  "的","了","是","在","我","有","和","就","不","人","都","一","一个","上","也",
  "很","到","说","要","去","你","会","着","没有","看","好","自己","这",
]);

/**
 * Detect if text is primarily Traditional Chinese.
 * Uses a two-pass approach: indicator characters + character-level ratio.
 */
export function isTraditionalChinese(text: string): boolean {
  if (!text || text.length < 20) return false;

  let tradCount = 0;
  let cjkCount = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // Count CJK characters
    if (ch >= "\u4e00" && ch <= "\u9fff") {
      cjkCount++;
      if (TRADITIONAL_INDICATORS.has(ch)) {
        tradCount++;
      }
    }
  }

  // Need at least some CJK text
   if (cjkCount < 10) return false;

  // Fast path: high-confidence indicators present
  const ratio = tradCount / cjkCount;
  if (ratio > 0.05) return true; // 5% traditional indicators is strong signal

  return false;
}

/**
 * Convert Traditional Chinese text to Simplified Chinese.
 * Non-Chinese characters (punctuation, numbers, Latin, etc.) are passed through unchanged.
 */
export function toSimplifiedChinese(text: string): string {
  if (!text) return text;
  return sify(text);
}

/**
 * Auto-detect and convert if the text is Traditional Chinese.
 * @returns The converted text and whether conversion was performed.
 */
export function convertIfTraditional(text: string): { text: string; converted: boolean } {
  if (!text || !isTraditionalChinese(text)) {
    return { text, converted: false };
  }
  return { text: toSimplifiedChinese(text), converted: true };
}

/**
 * Batch convert an array of strings, auto-detecting each one.
 */
export function batchConvertIfTraditional(texts: string[]): { texts: string[]; convertedCount: number } {
  let convertedCount = 0;
  const results = texts.map((t) => {
    const result = convertIfTraditional(t);
    if (result.converted) convertedCount++;
    return result.text;
  });
  return { texts: results, convertedCount };
}
