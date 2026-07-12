import { db } from "@/lib/db";
import { NextResponse } from "next/server";

// Health endpoint - NO AUTH required for load balancer / Docker health checks
export async function GET() {
  try {
    const startTime = Date.now();
    await db.$queryRaw`SELECT 1`;
    const dbLatency = Date.now() - startTime;

    // Check scraper-service health (non-blocking, 3s timeout)
    let scraperStatus: string = "unreachable";
    try {
      const scraperUrl = process.env.SCRAPER_SERVICE_URL || "http://localhost:3099";
      const scraperRes = await fetch(`${scraperUrl}/health`, { signal: AbortSignal.timeout(3000) });
      scraperStatus = scraperRes.ok ? "ok" : "error";
    } catch {
      // scraper-service is optional
    }

    const isHealthy = dbLatency < 5000;

    return NextResponse.json(
      {
        status: isHealthy ? "healthy" : "degraded",
        timestamp: new Date().toISOString(),
        services: {
          database: dbLatency < 5000 ? "ok" : "slow",
          scraperService: scraperStatus,
        },
      },
      { status: isHealthy ? 200 : 503 }
    );
  } catch {
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        services: {
          database: "error",
          scraperService: "unknown",
        },
      },
      { status: 503 }
    );
  }
}