import { zodResolver } from "@hookform/resolvers/zod";
import type { FieldValues } from "react-hook-form";
import type { $ZodType } from "zod/v4/core";

/**
 * Type-safe zod/v4 resolver wrapper.
 *
 * Constrains the schema to `$ZodType<unknown, FieldValues>` which matches
 * the zod v4 overload signature expected by `@hookform/resolvers` v5.
 */
export const safeResolver = <T extends $ZodType<unknown, FieldValues>>(schema: T) => zodResolver(schema);
