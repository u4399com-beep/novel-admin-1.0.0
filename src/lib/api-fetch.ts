import { toast } from 'sonner';

/**
 * Shared API fetch utility.
 *
 * Key behaviors vs raw fetch:
 *   1. On non-2xx responses, reads the response body and extracts
 *      the actual `error` field from the JSON, so the user sees
 *      "未授权，请先登录" instead of a generic "获取xxx失败".
 *   2. Automatically toasts unexpected errors (network, parse, etc.)
 *      so the caller only needs to handle known business errors.
 *   3. Returns typed JSON via generic parameter.
 */

export interface ApiError {
  error: string;
  detail?: string;
}

export class FetchError extends Error {
  status: number;
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Fetch wrapper that extracts server error messages from response body.
 *
 * @example
 * ```ts
 * const data = await apiFetch<Novel[]>('/api/novels?page=1');
 * ```
 *
 * @example
 * ```ts
 * try {
 *   await apiFetch('/api/novels', { method: 'POST', body: ... });
 * } catch (err) {
 *   if (err instanceof FetchError && err.status === 401) {
 *     // redirect to login
 *   }
 * }
 * ```
 */
export interface ApiFetchOptions extends RequestInit {
  /** If true, suppress automatic error toasts (caller handles errors) */
  silent?: boolean;
}

export async function apiFetch<T = unknown>(
  url: string,
  init?: ApiFetchOptions,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Network error (DNS failure, connection refused, CORS, etc.)
    const msg = err instanceof Error ? err.message : '网络连接失败';
    toast.error(msg);
    throw new FetchError(msg, 0);
  }

  if (res.ok) {
    // 204 No Content
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // Non-2xx: extract the server's error message
  let serverMsg = '';
  let serverDetail = '';
  try {
    const body = (await res.json()) as ApiError;
    serverMsg = body.error || '';
    serverDetail = body.detail || '';
  } catch {
    // Response body is not JSON (HTML error page, etc.)
  }

  // Build a useful message for the caller
  const displayMsg = serverMsg || res.statusText || `请求失败 (${res.status})`;
  const fullMsg = serverDetail ? `${displayMsg}：${serverDetail}` : displayMsg;

  // Always toast the error unless caller opts out (e.g. batch operations, import dialog).
  // This ensures the user sees the actual server message (e.g. "未授权，请先登录")
  // instead of a generic "获取xxx失败".
  if (!init?.silent && res.status !== 422) {
    // 422 = validation error — the caller (form) shows field-level errors, don't double-toast
    toast.error(displayMsg);
  }

  throw new FetchError(fullMsg, res.status, serverDetail);
}
