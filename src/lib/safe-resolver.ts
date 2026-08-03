import { zodResolver } from "@hookform/resolvers/zod";

/**
 * zod/v4 resolver wrapper.
 *
 * Why `any` is necessary here:
 * - zod v4 uses `ZodType<unknown, unknown, ...>` which is NOT assignable to
 *   the `Zod3Type<unknown, FieldValues>` that @hookform/resolvers expects.
 * - Attempting generic constraints like `<T extends ZodType>` fails because
 *   zod v4's internal `$ZodTypeInternals` types are structurally incompatible.
 * - This is a known upstream issue between zod v4 and @hookform/resolvers.
 * - The runtime behavior is correct; only the compile-time types disagree.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const safeResolver = (schema: any) => zodResolver(schema) as any;