import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { withPublicRateLimit } from "@/lib/api-auth";

/**
 * Health endpoint for load balancer / Docker health checks.
 * NO AUTH required — returns minimal info only (no internal service details exposed).
 * Rate limited to prevent DoS abuse.
 */
export const GET = withPublicRateLimit({ capacity: 120, refillRate: 4 }, async function GET() {
  try {
    const startTime = Date.now();
    await db.$queryRaw`SELECT 1`;
    const dbLatency = Date.now() - startTime;

    const isHealthy = dbLatency < 5000;

    return NextResponse.json(
      {
        status: isHealthy ? "healthy" : "degraded",
        timestamp: new Date().toISOString(),
      },
      { status: isHealthy ? 200 : 503 }
    );
  } catch {
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
});
