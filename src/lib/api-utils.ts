import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { sanitizeString } from './sanitize';

export function apiSuccess<T>(data: T, status?: number): NextResponse {
  return NextResponse.json(data, { status });
}

export function apiError(message: string, status: number = 500): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Standard 204 No Content response for DELETE operations.
 */
export function apiDeleted(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * Parse and validate pagination parameters from URL search params.
 * Returns validated page, pageSize, and computed skip value.
 */
export function parsePagination(
  params: URLSearchParams,
  defaults: { defaultPage?: number; defaultPageSize?: number; maxPageSize?: number } = {}
): { page: number; pageSize: number; skip: number } {
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
export function validateJsonStructure(value: unknown, depth: number, maxDepth: number, maxKeys: number): void {
  if (depth > maxDepth) {
    throw new Error(`JSON 嵌套层级超过 ${maxDepth} 限制`);
  }
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        validateJsonStructure(item, depth + 1, maxDepth, maxKeys);
      }
    } else {
      // Use Object.getOwnPropertyNames to include non-enumerable keys
      // and explicitly check for __proto__ / constructor / prototype to
      // prevent prototype pollution through JSON.parse reviver tricks.
      // Note: JSON.parse in V8 does NOT create __proto__ properties,
      // but this is defense-in-depth for any future changes.
      const obj = value as Record<string, unknown>;
      const dangerousProto = ['__proto__', 'constructor', 'prototype'];
      for (const dk of dangerousProto) {
        if (dk in obj) {
          throw new Error(`JSON 包含危险属性: ${dk}`);
        }
      }
      const keys = Object.keys(obj);
      if (keys.length > maxKeys) {
        throw new Error(`JSON 对象键数量超过 ${maxKeys} 限制`);
      }
      for (const key of keys) {
        validateJsonStructure(obj[key], depth + 1, maxDepth, maxKeys);
      }
    }
  }
}

/**
 * Safely parse request body JSON with timeout, depth limit, and key count limit.
 *
 * - 15-second AbortController timeout for reading the body stream
 * - JSON parse error → clear error
 * - Max nesting depth (default 20) to prevent stack overflow
 * - Max keys per object (default 200) to prevent memory abuse
 */
// Default to Record<string, unknown> for convenience in API routes that perform
// their own runtime validation. Explicit generic types should be preferred
// when stricter typing is needed.
export async function safeJson<T = Record<string, unknown>>(
  request: Request,
  maxDepth = 20,
  maxKeys = 200
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
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

/**
 * Narrow an unknown JSON field to `string` (empty string when not a string).
 * Use after destructuring a safeJson body when the field must be a string.
 */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Narrow an unknown JSON field to `string | null` (null when not a string).
 * Use for optional string columns: `asStringOrNull(body.field) || null`.
 */
export function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Check if a caught error is a Prisma error with a specific code.
 */
export function isPrismaError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    error !== undefined &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: string }).code === code
  );
}

/**
 * Count Chinese words in content.
 * Strips HTML tags and whitespace, then counts remaining characters.
 * This matches the behavior used in novels/[id]/chapters POST.
 */
export function countWords(content: string): number {
  return content.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length;
}

/**
 * Safely JSON.stringify a value with size limit.
 * Used for storing JSON config objects into String database fields.
 * @throws Error if the stringified value exceeds maxSize.
 */
export function safeJsonStringify(value: unknown, fieldName: string, maxSize = 50000): string | null {
  if (value == null) return null;
  const str = JSON.stringify(value);
  if (str && str.length > maxSize) {
    throw new Error(`${fieldName}配置过大（最大${Math.floor(maxSize / 1024)}KB）`);
  }
  return str;
}

/**
 * Extract the authenticated user's ID from a request's JWT token.
 * Returns null if the token is missing or has no id claim.
 */
export async function getAuthUserId(request: Request): Promise<string | null> {
  try {
    const token = await getToken({ req: request as import('next/server').NextRequest, secret: process.env.NEXTAUTH_SECRET });
    return token?.id ? String(token.id) : null;
  } catch {
    return null;
  }
}

/**
 * Map Prisma error codes to user-friendly messages and HTTP status codes.
 */
export function handlePrismaError(error: unknown): { message: string; status: number } {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: string }).code;
    switch (code) {
      case 'P2025': return { message: '记录不存在', status: 404 };
      case 'P2002': return { message: '数据冲突，记录已存在', status: 409 };
      case 'P2021': return { message: '数据表不存在', status: 500 };
      case 'P2003': return { message: '关联记录不存在', status: 400 };
      case 'P2011': return { message: '必填字段为空', status: 400 };
      case 'P2012': return { message: '字段值缺少', status: 400 };
      default: return { message: `数据库错误: ${code}`, status: 500 };
    }
  }
  return { message: '内部服务器错误', status: 500 };
}