import { NextResponse } from 'next/server';
import { sanitizeString } from './sanitize';

type ApiSuccessResponse<T> = T;
type ApiErrorResponse = { error: string };

export function apiSuccess<T>(data: T, status?: number) {
  return NextResponse.json(data as ApiSuccessResponse<T>, { status });
}

export function apiError(message: string, status: number = 500) {
  return NextResponse.json({ error: message } as ApiErrorResponse, { status });
}

/**
 * Parse and validate pagination parameters from URL search params.
 * Returns validated page, pageSize, and computed skip value.
 */
export function parsePagination(
  params: URLSearchParams,
  defaults: { defaultPage?: number; defaultPageSize?: number; maxPageSize?: number } = {}
) {
  const {
    defaultPage = 1,
    defaultPageSize = 20,
    maxPageSize = 100,
  } = defaults;

  const page = Math.min(10000, Math.max(1, parseInt(params.get('page') || String(defaultPage)) || defaultPage));
  const pageSize = Math.min(
    Math.max(1, parseInt(params.get('pageSize') || String(defaultPageSize)) || defaultPageSize),
    maxPageSize
  );
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/**
 * Recursively validate JSON structure depth and key count.
 * @throws Error if maxDepth or maxKeys is exceeded.
 */
function validateJsonStructure(value: unknown, depth: number, maxDepth: number, maxKeys: number): void {
  if (depth > maxDepth) {
    throw new Error(`JSON 嵌套层级超过 ${maxDepth} 限制`);
  }
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        validateJsonStructure(item, depth + 1, maxDepth, maxKeys);
      }
    } else {
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.length > maxKeys) {
        throw new Error(`JSON 对象键数量超过 ${maxKeys} 限制`);
      }
      for (const key of keys) {
        validateJsonStructure((value as Record<string, unknown>)[key], depth + 1, maxDepth, maxKeys);
      }
    }
  }
}

/**
 * Safely parse request body JSON with timeout, depth limit, and key count limit.
 *
 * - 10-second AbortController timeout for reading the body stream
 * - JSON parse error → clear error
 * - Max nesting depth (default 20) to prevent stack overflow
 * - Max keys per object (default 200) to prevent memory abuse
 */
export async function safeJson<T>(
  request: Request,
  maxDepth = 20,
  maxKeys = 200
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  try {
    const text = await Promise.race([
      request.text(),
      new Promise<never>((_, reject) =>
        timeoutId = setTimeout(() => reject(new Error('请求体读取超时')), 15_000)
      ),
    ]);

    // Enforce actual body size limit (1MB) to prevent Content-Length spoofing
    if (text.length > 1024 * 1024) {
      throw new Error("请求体过大");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("请求数据格式错误");
    }

    validateJsonStructure(parsed, 0, maxDepth, maxKeys);

    return parsed as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("请求数据格式错误");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Sanitize a user-provided text field: trim, strip control chars, limit length.
 * Returns empty string if input is not a string.
 */
export function sanitizeField(input: unknown, maxLength: number): string {
  return sanitizeString(input, maxLength);
}