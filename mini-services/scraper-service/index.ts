/**
 * Scraper Service - Novel Management System
 * Port: 3099
 *
 * A standalone Bun mini-service handling all web scraping operations.
 * Architecture: Pluggable engine system (Cheerio / Playwright / Firecrawl / AgentQL / CloudBrowser)
 *   + Request Queue (SQLite persistence) + Auto-retry + Multi-engine support
 */

import { initEngines, closeAllEngines, getEngineNames } from "./src/engines";
import { handleScrapeList } from "./src/scrapers";
import { handleScrapeBook } from "./src/scrapers";
import { handleScrapeChapters } from "./src/scrapers";
import { handleScrapeContent } from "./src/scrapers";
import { handleClean } from "./src/cleaning";
import { handleDownloadCover } from "./src/scrapers";
import { handleGenerateRule, handlePreviewPage } from "./src/ai-rule-generator";
import { executeTask } from "./src/task-engine";
import { getQueueStats, cleanupQueue, requeueFailed, clearTaskQueue } from "./src/queue";
import type {
  ScrapeListRequest, ScrapeBookRequest, ScrapeChaptersRequest,
  ScrapeContentRequest, CleanRequest, DownloadCoverRequest, ExecuteTaskRequest,
} from "./src/types";

// ==================== Start ====================

export function startServer(port: number = 3099) {
  // Initialize all engines
  initEngines();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // CORS - restrict to frontend origin only
      const allowedOrigins = [process.env.ALLOWED_ORIGIN || "http://localhost:3000"];
      const requestOrigin = req.headers.get("origin") || "";
      const corsOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
      const corsHeaders = {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      };

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // Health check
      if (path === "/health" && method === "GET") {
        return Response.json({
          status: "ok",
          service: "scraper-service",
          port: 3099,
          version: "3.0.0",
          engines: getEngineNames(),
          timestamp: new Date().toISOString(),
        });
      }

      // Queue management endpoints
      if (path === "/queue/stats" && method === "GET") {
        const taskId = url.searchParams.get("taskId") || undefined;
        return Response.json(getQueueStats(taskId), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/queue/requeue" && method === "POST") {
        const taskId = url.searchParams.get("taskId") || undefined;
        const count = requeueFailed(taskId);
        return Response.json({ requeued: count }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (path === "/queue/cleanup" && method === "POST") {
        const count = cleanupQueue();
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
        clearTaskQueue(taskId);
        return Response.json({ cleared: true }, {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // POST-only for scraping endpoints
      if (method !== "POST") {
        return Response.json(
          { error: "Method not allowed. Use POST." },
          { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Parse JSON body
      let body: unknown;
      try {
        const text = await req.text();
        body = text.trim() ? JSON.parse(text) : {};
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
          // Run task asynchronously
          executeTask(taskId).catch((err) => {
            console.error(`[Task ${taskId}] Fatal error:`, err);
            import("./src/task-engine").then(({ executeTask: et }) => {
              // Update task as failed via API
              fetch(`${process.env.MAIN_APP_URL || "http://localhost:3000"}/api/scrape-tasks/${taskId}`, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${process.env.SCRAPER_SERVICE_TOKEN || process.env.NEXTAUTH_SECRET || ""}`,
                },
                body: JSON.stringify({
                  status: "failed",
                  errorMessage: String(err),
                  completedAt: new Date().toISOString(),
                }),
              }).catch(() => {});
            });
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
        // Don't leak internal error details
        const message = err instanceof Error ? err.message : "Internal server error";
        return Response.json(
          { error: message },
          { status: 500, headers: jsonHeaders }
        );
      }
    },
  });

  console.log(`🚀 Scraper Service v3.0 running on port ${server.port}`);
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

  return server;
}

// ==================== Start ====================

const PORT = parseInt(process.env.PORT || "3099", 10);
console.log(`[Config] API_BASE: ${process.env.MAIN_APP_URL || "http://localhost:3000"}`);
console.log(`[Config] PORT: ${PORT}`);
console.log(`[Config] Firecrawl: ${process.env.FIRECRAWL_API_URL || "not configured (http://localhost:3002)"}`);
console.log(`[Config] AgentQL: ${process.env.AGENTQL_API_URL || "not configured (https://api.agentql.com)"}`);
console.log(`[Config] CloudBrowser: ${process.env.CLOUD_BROWSER_PROVIDER || "browserless"} (${process.env.BROWSERLESS_API_URL || process.env.STEEL_API_URL || "not configured"})`);
startServer(PORT);

// ==================== Graceful Shutdown ====================

let isShuttingDown = false;
const shutdown = (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[${new Date().toISOString()}] Received ${signal}, shutting down gracefully...`);

  closeAllEngines().then(() => {
    console.log(`[${new Date().toISOString()}] Engines closed. Exiting.`);
    process.exit(0);
  }).catch(() => {
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.log(`[${new Date().toISOString()}] Forced shutdown after grace period.`);
    process.exit(0);
  }, 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));