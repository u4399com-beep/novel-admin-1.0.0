import { zodResolver } from "@hookform/resolvers/zod";
import type { FieldValues, Resolver } from "react-hook-form";
import type { $ZodType } from "zod/v4/core";

/**
 * Type-safe zod/v4 resolver wrapper.
 *
 * Constrains the schema to `$ZodType<unknown, FieldValues>` which matches
 * the zod v4 overload signature expected by `@hookform/resolvers` v5.
 *
 * The result is intentionally typed as `Resolver<any, any, any>`: for schemas
 * whose input type differs from their output type (z.coerce.*, .default()),
 * react-hook-form 7.6x's invariant `ResolverOptions<TFieldValues>` makes the
 * resolver structurally unassignable to `useForm<Output>` even though it is
 * correct at runtime. Callers keep full type safety on `useForm<Output>`;
 * only the resolver's own parameter checking is relaxed.
 */
export const safeResolver = <T extends $ZodType<unknown, FieldValues>>(
  schema: T,
): Resolver<any, any, any> => zodResolver(schema);
