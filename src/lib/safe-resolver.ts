import { zodResolver } from "@hookform/resolvers/zod";

/** zod/v4 resolver: type assertion needed for @hookform/resolvers/zod type mismatch with zod v4 */
export const safeResolver = (schema: any) => zodResolver(schema) as any;