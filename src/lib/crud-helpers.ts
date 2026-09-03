import { apiError } from './api-utils';
import { NextResponse } from 'next/server';

 
/**
 * Structural stand-ins for Prisma delegates. Prisma only exposes per-model arg
 * types (e.g. `Prisma.NovelFindManyArgs`), so the shared helpers accept any
 * delegate whose methods take a single args object and return arrays/entities.
 * Method shorthand keeps parameter checks bivariant against generated delegates.
 */
type ListModel = {
  findMany(args: any): Promise<unknown[]>;
  count(args: any): Promise<number>;
};

/** Prisma model subset needed for single-item lookup */
type GetModel = {
  findUnique(args: any): Promise<unknown>;
  findFirst(args: any): Promise<unknown>;
};

export interface PaginatedListOptions {
  page: number;
  pageSize: number;
  where?: unknown;
  orderBy?: unknown;
  include?: unknown;
  select?: unknown;
  /** Key name for the items array in the response (default: 'items') */
  itemsKey?: string;
}

/**
 * Standard paginated list: runs findMany + count in parallel and returns
 * a consistent `{ [itemsKey], total, page, pageSize, totalPages }` shape.
 *
 * Usage:
 * ```ts
 * const { page, pageSize, skip } = parsePagination(searchParams);
 * return paginatedList(db.novel, { page, pageSize, where, orderBy, include, itemsKey: 'novels' });
 * ```
 */
export async function paginatedList(
  model: ListModel,
  options: PaginatedListOptions,
): Promise<NextResponse> {
  const {
    page,
    pageSize,
    where,
    orderBy,
    include,
    select,
    itemsKey = 'items',
  } = options;

  const skip = (page - 1) * pageSize;

  const [items, total] = await Promise.all([
    model.findMany({
      where,
      orderBy,
      skip,
      take: pageSize,
      include,
      select,
    }),
    model.count({ where }),
  ]);

  return NextResponse.json({
    [itemsKey]: items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  });
}

/**
 * Fetch a single record or return a 404 error response.
 * Prefers `findUnique`; falls back to `findFirst` if the model doesn't have it.
 *
 * Usage:
 * ```ts
 * const novel = await getOrFail(db.novel, { id: novelId }, '小说不存在');
 * ```
 */
export async function getOrFail<T>(
  model: GetModel,
  where: unknown,
  errorMessage = '记录不存在',
): Promise<T> {
  const item = await model.findUnique({ where });
  if (!item) {
    throw new NotFoundError(errorMessage);
  }
  return item as T;
}
 

/** Custom error so callers can distinguish 404 from other errors */
export class NotFoundError extends Error {
  status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Validate that required string fields are present and non-empty in a body object.
 * Returns `{ valid: true }` on success, or `{ valid: false, missing, response }` on failure.
 *
 * Usage:
 * ```ts
 * const check = requireFields(body, ['name', 'slug']);
 * if (!check.valid) return check.response;
 * ```
 */
export function requireFields(
  body: unknown,
  fields: string[],
): { valid: true } | { valid: false; missing: string; response: NextResponse } {
  if (!body || typeof body !== 'object') {
    return { valid: false, missing: '', response: apiError('请求体格式错误', 400) };
  }
  const obj = body as Record<string, unknown>;
  for (const field of fields) {
    const value = obj[field];
    if (!value || (typeof value === 'string' && !value.trim())) {
      return { valid: false, missing: field, response: apiError(`缺少必填字段: ${field}`, 400) };
    }
  }
  return { valid: true };
}
