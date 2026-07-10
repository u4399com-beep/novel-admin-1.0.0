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

  const page = Math.max(1, parseInt(params.get('page') || String(defaultPage)) || defaultPage);
  const pageSize = Math.min(
    Math.max(1, parseInt(params.get('pageSize') || String(defaultPageSize)) || defaultPageSize),
    maxPageSize
  );
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/**
 * Safely parse request body JSON with a size limit.
 */
export function safeJson<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

/**
 * Sanitize a user-provided text field: trim, strip control chars, limit length.
 * Returns empty string if input is not a string.
 */
export function sanitizeField(input: unknown, maxLength: number): string {
  return sanitizeString(input, maxLength);
}