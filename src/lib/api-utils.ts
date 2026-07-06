import { NextResponse } from 'next/server';

type ApiSuccessResponse<T> = T;
type ApiErrorResponse = { error: string };

export function apiSuccess<T>(data: T, status?: number) {
  return NextResponse.json(data as ApiSuccessResponse<T>, { status });
}

export function apiError(message: string, status: number = 500) {
  return NextResponse.json({ error: message } as ApiErrorResponse, { status });
}

export function parsePagination(params: URLSearchParams) {
  const page = Math.max(1, parseInt(params.get('page') || '1') || 1);
  const pageSize = Math.min(Math.max(1, parseInt(params.get('pageSize') || '20') || 20), 100);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function safeJson<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}