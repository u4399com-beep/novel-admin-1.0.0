/**
 * Scraper Service - Novel Management System
 * Port: 3099
 *
 * A standalone Bun mini-service handling all web scraping operations.
 * Architecture: Pluggable engine system (Cheerio / Playwright / Firecrawl / AgentQL / CloudBrowser)
 *   + Request Queue (PostgreSQL persistence) + Auto-retry + Multi-engine support
 */

// Global error handlers for process resilience
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err);
});

import { initEngines, closeAllEngines, getEngineNames } from "./src/engines";
import { handleScrapeList } from "./src/scrapers";
import { handleScrapeBook } from "./src/scrapers";
import { handleScrapeChapters } from "./src/scrapers";
import { handleScrapeContent } from "./src/scrapers";
import { handleClean } from "./src/cleaning";
import { handleDownloadCover } from "./src/scrapers";
import { handleGenerateRule, handlePreviewPage } from "./src/ai-rule-generator";
import { executeTask, recoverStaleTasks } from "./src/task-engine";
import { getQueueStats, cleanupQueue, requeueFailed, clearTaskQueue } from "./src/queue";
import { timingSafeEqual } from "node:crypto";
import type {
  ScrapeListRequest, ScrapeBookRequest, ScrapeChaptersRequest,
  ScrapeContentRequest, CleanRequest, DownloadCoverRequest, ExecuteTaskRequest,
} from "./src/types";

// ==================== Start ====================

const SERVICE_TOKEN = process.env.SCRAPER_SERVICE_TOKEN || "";
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB max request body
const SCRAPER_RATE_LIMIT = 60; // requests per minute
const MAX_SCRAPER_RATE_ENTRIES = 10000;
const MAX_CONCURRENT_TASKS = 3; // global concurrent task limit
const MAX_JSON_DEPTH = 20;
const MAX_JSON_KEYS = 200;
const ALLOWED_ORIGINS = [process.env.ALLOWED_ORIGIN || "http://localhost:3000"];
let activeTaskCount = 0;
const scraperRateStore = new Map<string, { count: number; resetAt: number }>();

// Track active tasks for graceful shutdown

let lastScraperRateCleanup = 0;
function lazyScraperRateCleanup(): void {
  const now = Date.now();
  if (now - lastScraperRateCleanup < 10_000) return;
  if (scraperRateStore.size < MAX_SCRAPER_RATE_ENTRIES * 0.8) return;
  lastScraperRateCleanup = now;
  for (const [ip, entry] of scraperRateStore) {
    if (now > entry.resetAt) scraperRateStore.delete(ip);
  }
}

function authenticateRequest(req: Request): boolean {
  // Health check doesn't need auth
  const url = new URL(req.url);
  if (url.pathname === "/health") return true;

  // Check Authorization header using timing-safe comparison
  const auth = req.headers.get("authorization");
  if (SERVICE_TOKEN && auth) {
    const expected = `Bearer ${SERVICE_TOKEN}`;
    const aBuf = Buffer.from(auth, "utf-8");
    const bBuf = Buffer.from(expected, "utf-8");
    try {
      if (aBuf.length === bBuf.length) {
        if (timingSafeEqual(aBuf, bBuf)) return true;
      } else {
        // Dummy comparison to maintain constant time on length mismatch
        timingSafeEqual(aBuf, aBuf);
      }
    } catch {}
  }

  // Reject if no token configured (force security)
  if (!SERVICE_TOKEN) {
    console.warn("[Auth] SCRAPER_SERVICE_TOKEN not set - all non-health requests rejected");
    return false;
  }

  return false;
}

function checkScraperRateLimit(ip: string): boolean {
  const now = Date.now();
  lazyScraperRateCleanup();

  let entry = scraperRateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    scraperRateStore.set(ip, entry);
  }
  entry.count++;
  return entry.count <= SCRAPER_RATE_LIMIT;
}

function validateDepth(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH) throw new Error("JSON nested too deep");
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) value.forEach((item) => validateDepth(item, depth + 1));
    else {
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.length > MAX_JSON_KEYS) throw new Error("JSON too many keys");
      for (const k of keys) validateDepth((value as Record<string, unknown>)[k], depth + 1);
    }
  }
}

export function startServer(port: number = 3099) {
  // Warn if no service token configured
  if (!SERVICE_TOKEN) {
    console.warn("⚠️  SCRAPER_SERVICE_TOKEN not configured! Service will reject all authenticated requests.");
    console.warn("   Set SCRAPER_SERVICE_TOKEN environment variable to enable API access.");
  }

  // Initialize all engines
  initEngines();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // CORS - restrict to frontend origin only
      const requestOrigin = req.headers.get("origin") || "";
      const corsHeaders: Record<string, string> = {};
      if (ALLOWED_ORIGINS.includes(requestOrigin)) {
        corsHeaders["Access-Control-Allow-Origin"] = requestOrigin;
        corsHeaders["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
        corsHeaders["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
        corsHeaders["Access-Control-Max-Age"] = "86400";
      }

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Health check
      if (path === "/health" && method === "GET") {
        return Response.json({
          status: "ok",
          timestamp: new Date().toISOString(),
        });
      }

      // Authentication check for all non-health, non-OPTIONS requests
      if (!authenticateRequest(req)) {
        return Response.json(
          { error: "Unauthorized. Provide valid Bearer token." },
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Queue management endpoints (auth required)
      if (path === "/queue/stats" && method === "GET") {
        const taskId = url.searchParams.get("taskId") || undefined;
        const stats = await getQueueStats(taskId);
        return Response.json(stats, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/queue/requeue" && method === "POST") {
        const taskId = url.searchParams.get("taskId") || undefined;
        const count = await requeueFailed(taskId);
        return Response.json({ requeued: count }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/queue/cleanup" && method === "POST") {
        const count = await cleanupQueue();
        return Response.json({ cleaned: count }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/queue/clear" && method === "DELETE") {
        const taskId = url.searchParams.get("taskId");
        if (!taskId) {
          return Response.json({ error: "taskId is required" }, {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        await clearTaskQueue(taskId);
        return Response.json({ cleared: true }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Rate limiting (per client IP)
      // Use x-forwarded-for (last IP) as primary, fall back to x-real-ip
      const fwd = req.headers.get("x-forwarded-for");
      const clientIp = fwd ? fwd.split(",").pop()?.trim() || "unknown" : (req.headers.get("x-real-ip") || "unknown");
      if (!checkScraperRateLimit(clientIp)) {
        return Response.json(
          { error: "Rate limit exceeded. Try again later." },
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" } }
        );
      }

      // POST-only for scraping endpoints
      if (method !== "POST") {
        return Response.json(
          { error: "Method not allowed. Use POST." },
          { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Parse JSON body with size limit
      let body: unknown;
      try {
        const contentLength = parseInt(req.headers.get("content-length") || "0", 10);
        if (contentLength > MAX_BODY_SIZE) {
          return Response.json(
            { error: `Request body too large. Max ${MAX_BODY_SIZE / 1024 / 1024}MB.` },
            { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const text = await req.text();
        if (text.length > MAX_BODY_SIZE) {
          return Response.json(
            { error: `Request body too large. Max ${MAX_BODY_SIZE / 1024 / 1024}MB.` },
            { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return Response.json(
            { error: "Invalid JSON body" },
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        // Depth and key count validation (mirror Next.js safeJson)
        try { validateDepth(parsed, 0); } catch {
          return Response.json(
            { error: "JSON validation failed" },
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        body = parsed;
      } catch {
        return Response.json(
          { error: "Invalid JSON body" },
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };

      try {
        // Route to handlers
        if (path === "/scrape/list") {
          const result = await handleScrapeList(body as ScrapeListRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/book") {
          const result = await handleScrapeBook(body as ScrapeBookRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/chapters") {
          const result = await handleScrapeChapters(body as ScrapeChaptersRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/scrape/content") {
          const result = await handleScrapeContent(body as ScrapeContentRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/clean") {
          const result = handleClean(body as CleanRequest);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/download-cover") {
          const { url: coverUrl, savePath } = body as DownloadCoverRequest;
          if (!coverUrl || !savePath) {
            return Response.json({ error: "url and savePath are required" }, { status: 400, headers: jsonHeaders });
          }
          const result = await handleDownloadCover(coverUrl, savePath);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/execute-task") {
          const { taskId } = body as ExecuteTaskRequest;
          if (!taskId) {
            return Response.json({ error: "taskId is required" }, { status: 400, headers: jsonHeaders });
          }

          // Enforce global concurrent task limit
          if (activeTaskCount >= MAX_CONCURRENT_TASKS) {
            return Response.json(
              { error: "服务器繁忙，采集任务已达并发上限，请稍后再试" },
              { status: 503, headers: jsonHeaders }
            );
          }

          // Prevent duplicate task execution (same taskId)
          if (activeTasks.has(taskId)) {
            return Response.json(
              { error: "该任务已在执行中，请勿重复提交" },
              { status: 409, headers: jsonHeaders }
            );
          }

          activeTaskCount++;
          // Run task asynchronously
          activeTasks.add(taskId);
          executeTask(taskId).catch((err) => {
            console.error(`[Task ${taskId}] Fatal error:`, err);
            activeTasks.delete(taskId);
            // Update task as failed via API
            fetch(`${process.env.MAIN_APP_URL || "http://localhost:3000"}/api/scrape-tasks/${taskId}`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || ""}`,
              },
              body: JSON.stringify({
                status: "failed",
                errorMessage: String(err),
                completedAt: new Date().toISOString(),
              }),
            }).catch(() => {});
          }).finally(() => {
            activeTasks.delete(taskId);
            activeTaskCount--;
          });
          return Response.json(
            { message: "Task execution started", taskId },
            { headers: jsonHeaders }
          );
        }

        if (path === "/ai/generate-rule") {
          const { url, siteType } = body as { url: string; siteType?: string };
          if (!url) {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          const result = await handleGenerateRule(url, siteType);
          return Response.json(result, { headers: jsonHeaders });
        }

        if (path === "/ai/preview-page") {
          const { url } = body as { url: string };
          if (!url) {
            return Response.json({ error: "url is required" }, { status: 400, headers: jsonHeaders });
          }
          const result = await handlePreviewPage(url);
          return Response.json(result, { headers: jsonHeaders });
        }

        return Response.json(
          { error: `Unknown endpoint: ${path}` },
          { status: 404, headers: jsonHeaders }
        );
      } catch (err) {
        console.error(`[Server] Error handling ${path}:`, err);
        // Never leak internal error details to clients
        return Response.json(
          { error: "Internal server error" },
          { status: 500, headers: jsonHeaders }
        );
      }
    },
  });

  console.log(`🚀 Scraper Service v3.0 running on port ${server.port}`);
  if (process.env.DEBUG === "true") {
    console.log(`   Engines: ${getEngineNames().join(", ")}`);
    console.log(`   Endpoints:`);
    console.log(`   POST /scrape/list       - Scrape a list page`);
    console.log(`   POST /scrape/book       - Scrape book info`);
    console.log(`   POST /scrape/chapters   - Scrape chapter directory`);
    console.log(`   POST /scrape/content    - Scrape chapter content`);
    console.log(`   POST /clean             - Clean scraped content`);
    console.log(`   POST /download-cover    - Download & convert cover`);
    console.log(`   POST /execute-task      - Execute full scraping task`);
    console.log(`   GET  /health            - Health check (shows active engines)`);
    console.log(`   GET  /queue/stats       - Queue statistics`);
    console.log(`   POST /queue/requeue     - Requeue failed items`);
    console.log(`   POST /queue/cleanup     - Cleanup old completed items`);
    console.log(`   DELETE /queue/clear     - Clear task queue`);
    console.log(`   POST /ai/generate-rule - AI-generate scrape rules from URL`);
    console.log(`   POST /ai/preview-page   - Fetch page HTML for preview`);
  }

  return server;
}

// ==================== Start ====================

const PORT = parseInt(process.env.PORT || "3099", 10);
console.log(`[Config] PORT: ${PORT}, Auth: ${SERVICE_TOKEN ? "enabled" : "DISABLED"}`);
// Only log sensitive service URLs in debug mode
if (process.env.DEBUG === "true") {
  console.log(`[Config] API_BASE: ${process.env.MAIN_APP_URL || "http://localhost:3000"}`);
  console.log(`[Config] Firecrawl: ${process.env.FIRECRAWL_API_URL || "not configured"}`);
  console.log(`[Config] AgentQL: ${process.env.AGENTQL_API_URL || "not configured"}`);
  console.log(`[Config] CloudBrowser: ${process.env.CLOUD_BROWSER_PROVIDER || "browserless"}`);
}

// Recover any stale tasks from previous crashes before starting server
const recovered = await recoverStaleTasks();
if (recovered > 0) {
  console.log(`[Startup] Recovered ${recovered} stale tasks`);
}

startServer(PORT);

// ==================== Graceful Shutdown ====================

let isShuttingDown = false;
const activeTasks = new Set<string>();

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[${new Date().toISOString()}] Received ${signal}, shutting down gracefully...`);

  // Wait for active tasks to complete (with a 10s hard deadline)
  const deadline = Date.now() + 10000;

  await Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, 10000)),
    (async () => {
      // Wait for all active tasks to finish
      while (activeTasks.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }),
  ]);

  await closeAllEngines().catch(() => {});
  clearInterval(terminateTimer); // Clear force-terminate timer regardless
  console.log(`[${new Date().toISOString()}] Active tasks: ${activeTasks.size}, Engines closed. Exiting.`);

  process.exit(0);
};

// Terminate unfinished tasks if any
const terminateTimer = setInterval(() => {
  if (activeTasks.size > 0 && isShuttingDown) {
    // Tasks still running after deadline - force terminate
    console.warn(`[${new Date().toISOString()}] Force terminating ${activeTasks.size} active tasks`);
    for (const taskId of activeTasks) {
      fetch(`${process.env.MAIN_APP_URL || "http://localhost:3000"}/api/scrape-tasks/${taskId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || ""}`,
        },
        body: JSON.stringify({
          status: "failed",
          errorMessage: "服务正在关闭",
          completedAt: new Date().toISOString(),
        }),
      }).catch(() => {});
    }
    clearInterval(terminateTimer);
  }
}, 3000);

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));