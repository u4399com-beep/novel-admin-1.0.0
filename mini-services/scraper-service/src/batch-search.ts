/**
 * Batch Search Across Multiple Sources
 *
 * Implements parallel search across multiple scrape rules,
 * with aggregation, deduplication, and ranking of results.
 */

import type { EngineType } from './types';

// ==================== Types ====================

export interface SearchResult {
  /** Book/novel title */
  title: string;
  /** Author name (if available) */
  author?: string;
  /** Source URL of the result */
  url: string;
  /** Source domain (e.g., 'example.com') */
  sourceDomain: string;
  /** Brief description/snippet */
  description?: string;
  /** Cover image URL */
  coverUrl?: string;
  /** Number of chapters (if available) */
  chapterCount?: number;
  /** Update status or date */
  updateStatus?: string;
  /** Category/tags */
  category?: string;
  /** Relevance score (0-1, computed by ranker) */
  relevanceScore: number;
  /** Source scrape rule ID */
  sourceRuleId?: string;
  /** Engine that produced this result */
  engine?: EngineType;
}

export interface BatchSearchRequest {
  /** Search query (title or title + author) */
  query: string;
  /** Optional author filter */
  author?: string;
  /** Source rule IDs to search (empty = all) */
  sourceRuleIds?: string[];
  /** Maximum concurrent searches */
  maxConcurrency?: number;
  /** Maximum results per source */
  maxResultsPerSource?: number;
  /** Overall maximum results */
  maxTotalResults?: number;
  /** Timeout per source (ms) */
  sourceTimeoutMs?: number;
  /** Minimum relevance score to include (0-1) */
  minRelevance?: number;
}

export interface BatchSearchResult {
  /** Aggregated and ranked results */
  results: SearchResult[];
  /** Per-source statistics */
  sourceStats: Array<{
    sourceDomain: string;
    resultCount: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }>;
  /** Total search duration */
  totalDurationMs: number;
  /** Number of deduplicated entries */
  dedupCount: number;
  /** The original query */
  query: string;
}

// ==================== Similarity / Deduplication ====================

/**
 * Calculate Jaccard similarity between two strings (character-level).
 * Used for deduplication of search results by title.
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().replace(/\s+/g, ''));
  const setB = new Set(b.toLowerCase().replace(/\s+/g, ''));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const char of setA) {
    if (setB.has(char)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Calculate normalized Levenshtein distance (0 = identical, 1 = completely different).
 * Capped at maxLen 50 for performance.
 */
function normalizedEditDistance(a: string, b: string): number {
  const sa = a.toLowerCase().slice(0, 50);
  const sb = b.toLowerCase().slice(0, 50);
  const lenA = sa.length;
  const lenB = sb.length;
  if (lenA === 0 && lenB === 0) return 0;
  if (lenA === 0 || lenB === 0) return 1;

  // Use 1D DP array for space efficiency
  const prev = new Array<number>(lenB + 1);
  const curr = new Array<number>(lenB + 1);
  for (let j = 0; j <= lenB; j++) prev[j] = j;

  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = sa[i - 1] === sb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    // Swap arrays
    for (let j = 0; j <= lenB; j++) prev[j] = curr[j];
  }

  return prev[lenB] / Math.max(lenA, lenB);
}

/**
 * Check if two search results are likely the same book.
 * Uses title similarity + author match.
 */
function isLikelyDuplicate(a: SearchResult, b: SearchResult): boolean {
  // Title similarity: combine Jaccard and edit distance
  const titleSim = jaccardSimilarity(a.title, b.title);
  const editSim = 1 - normalizedEditDistance(a.title, b.title);
  const combinedTitleSim = (titleSim + editSim) / 2;

  if (combinedTitleSim < 0.65) return false;

  // If both have authors, check author similarity
  if (a.author && b.author) {
    const authorSim = jaccardSimilarity(a.author, b.author);
    // High title similarity + matching author = very likely duplicate
    if (combinedTitleSim > 0.8 && authorSim > 0.5) return true;
    // Moderate title similarity needs stronger author match
    if (combinedTitleSim > 0.65 && authorSim > 0.8) return true;
    return false;
  }

  // High title similarity without author info is likely duplicate
  return combinedTitleSim > 0.85;
}

// ==================== Relevance Scoring ====================

/**
 * Score a search result's relevance to the query.
 * Factors:
 *   1. Title match (exact, contains, similarity)
 *   2. Author match (if query includes author)
 *   3. Source quality (some sources are more reliable)
 *   4. Freshness (recently updated > stale)
 */
function scoreRelevance(result: SearchResult, query: string, queryAuthor?: string): number {
  const queryLower = query.toLowerCase();
  const titleLower = result.title.toLowerCase();
  let score = 0;

  // 1. Title match scoring (0-0.5)
  if (titleLower === queryLower) {
    score += 0.5; // Exact match
  } else if (titleLower.includes(queryLower) || queryLower.includes(titleLower)) {
    score += 0.35; // Contains match
  } else {
    const titleSim = (jaccardSimilarity(titleLower, queryLower) + (1 - normalizedEditDistance(titleLower, queryLower))) / 2;
    score += titleSim * 0.4; // Similarity-scaled
  }

  // 2. Author match scoring (0-0.25)
  if (queryAuthor && result.author) {
    const authorLower = result.author.toLowerCase();
    const qAuthorLower = queryAuthor.toLowerCase();
    if (authorLower === qAuthorLower) {
      score += 0.25;
    } else if (authorLower.includes(qAuthorLower) || qAuthorLower.includes(authorLower)) {
      score += 0.15;
    } else {
      score += jaccardSimilarity(authorLower, qAuthorLower) * 0.1;
    }
  }

  // 3. Has useful metadata (0-0.15)
  if (result.chapterCount && result.chapterCount > 0) score += 0.05;
  if (result.description && result.description.length > 20) score += 0.05;
  if (result.coverUrl) score += 0.05;

  // 4. Update freshness (0-0.1)
  if (result.updateStatus) {
    if (/连载中|连载|更新|連載/i.test(result.updateStatus)) score += 0.1;
    else if (/完结|完本|完成|已完/i.test(result.updateStatus)) score += 0.05;
  }

  return Math.min(1, Math.max(0, score));
}

// ==================== Deduplication ====================

/**
 * Deduplicate search results by title/author similarity.
 * When duplicates are found, keep the one with higher relevance score.
 */
export function deduplicateResults(results: SearchResult[]): { results: SearchResult[]; dedupCount: number } {
  if (results.length <= 1) return { results, dedupCount: 0 };

  const kept: SearchResult[] = [];
  const removed = new Set<number>();

  for (let i = 0; i < results.length; i++) {
    if (removed.has(i)) continue;

    for (let j = i + 1; j < results.length; j++) {
      if (removed.has(j)) continue;

      if (isLikelyDuplicate(results[i], results[j])) {
        // Keep the one with higher relevance score
        if (results[i].relevanceScore >= results[j].relevanceScore) {
          removed.add(j);
        } else {
          removed.add(i);
          break; // i is removed, no need to compare further
        }
      }
    }

    if (!removed.has(i)) {
      kept.push(results[i]);
    }
  }

  return { results: kept, dedupCount: removed.size };
}

// ==================== Batch Search Execution ====================

/**
 * Execute a batch search across multiple sources.
 *
 * This is the main entry point. It:
 * 1. Searches each source in parallel (with concurrency limit)
 * 2. Scores results for relevance
 * 3. Deduplicates across sources
 * 4. Ranks and returns results
 *
 * @param request - Search request parameters
 * @param searchFn - Function to execute a search on a single source
 * @returns Aggregated, deduplicated, ranked results
 */
export async function executeBatchSearch(
  request: BatchSearchRequest,
  searchFn: (query: string, sourceRuleId: string, timeoutMs: number) => Promise<SearchResult[]>,
): Promise<BatchSearchResult> {
  const startTime = Date.now();
  const maxConcurrency = request.maxConcurrency ?? 3;
  const maxResultsPerSource = request.maxResultsPerSource ?? 10;
  const maxTotalResults = request.maxTotalResults ?? 50;
  const sourceTimeoutMs = request.sourceTimeoutMs ?? 15000;
  const minRelevance = request.minRelevance ?? 0.1;

  // Get source rule IDs to search
  const sourceIds = request.sourceRuleIds?.length ? request.sourceRuleIds : [];

  // If no sources, return empty
  if (sourceIds.length === 0) {
    return {
      results: [],
      sourceStats: [],
      totalDurationMs: Date.now() - startTime,
      dedupCount: 0,
      query: request.query,
    };
  }

  // Execute searches with concurrency limit
  const allResults: SearchResult[] = [];
  const sourceStats: BatchSearchResult['sourceStats'] = [];

  // Process in batches of maxConcurrency
  for (let i = 0; i < sourceIds.length; i += maxConcurrency) {
    const batch = sourceIds.slice(i, i + maxConcurrency);
    const promises = batch.map(async (sourceId) => {
      const sourceStart = Date.now();
      try {
        // searchFn already receives sourceTimeoutMs and handles timeout internally;
        // no need for Promise.race with setTimeout (which would leak the timer)
        const results = await searchFn(request.query, sourceId, sourceTimeoutMs);

        // Score and limit results per source
        const scored = results
          .slice(0, maxResultsPerSource)
          .map(r => ({
            ...r,
            relevanceScore: scoreRelevance(r, request.query, request.author),
          }));

        allResults.push(...scored);
        sourceStats.push({
          sourceDomain: scored[0]?.sourceDomain || sourceId,
          resultCount: scored.length,
          durationMs: Date.now() - sourceStart,
          success: true,
        });
      } catch (err) {
        sourceStats.push({
          sourceDomain: sourceId,
          resultCount: 0,
          durationMs: Date.now() - sourceStart,
          success: false,
          error: err instanceof Error ? err.message.slice(0, 100) : 'Unknown error',
        });
      }
    });

    await Promise.all(promises);
  }

  // Filter by minimum relevance
  const filtered = allResults.filter(r => r.relevanceScore >= minRelevance);

  // Sort by relevance score (descending)
  filtered.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // Deduplicate
  const { results: deduped, dedupCount } = deduplicateResults(filtered);

  // Limit total results
  const finalResults = deduped.slice(0, maxTotalResults);

  return {
    results: finalResults,
    sourceStats,
    totalDurationMs: Date.now() - startTime,
    dedupCount,
    query: request.query,
  };
}

// ==================== Utility: Title-Author Extraction ====================

/**
 * Extract title and optional author from a search query string.
 * Supports formats like: "Book Title", "Book Title Author", "Book Title / Author"
 */
export function parseSearchQuery(query: string): { title: string; author?: string } {
  // Try common separators: "title / author", "title - author", "title(author)"
  const separators = [
    /^(.+?)\s*[\/\\|]\s*(.+)$/,    // title / author
    /^(.+?)\s*[-–—]\s*(.+)$/,      // title - author
    /^(.+?)\s*[（(]\s*(.+?)\s*[）)]$/, // title (author)
  ];

  for (const sep of separators) {
    const match = query.match(sep);
    if (match) {
      return { title: match[1].trim(), author: match[2].trim() };
    }
  }

  return { title: query.trim() };
}
