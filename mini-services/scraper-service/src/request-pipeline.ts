/**
 * Request Pipeline Architecture
 *
 * Middleware-style request pipeline for the scraper service.
 * Each request goes through ordered stages:
 *   fingerprint → delay → proxy → execute → validate → retry
 *
 * Features:
 *   - Before/after hooks for each stage
 *   - Pipeline-level metrics and timing
 *   - Stage-specific error handling
 *   - Composable middleware chains
 */

import type { EngineType, FetchResult } from './types';
import { logger } from './logger';

const log = logger.child('RequestPipeline');

// ==================== Types ====================

/** Pipeline stage names in execution order */
export type PipelineStage =
  | 'fingerprint'   // Apply fingerprint/stealth headers
  | 'delay'         // Apply rate limit delay
  | 'proxy'         // Select and configure proxy
  | 'execute'       // Execute the actual HTTP request
  | 'validate'      // Validate response (anti-crawl, CAPTCHA, content)
  | 'retry';        // Handle retry if needed

const ALL_STAGES: PipelineStage[] = ['fingerprint', 'delay', 'proxy', 'execute', 'validate', 'retry'];

/** Pipeline context carried through all stages */
export interface PipelineContext {
  /** Request URL */
  url: string;
  /** Target domain */
  domain: string;
  /** Engine type to use */
  engine: EngineType;
  /** Request headers (built up through pipeline) */
  headers: Record<string, string>;
  /** Proxy URL (set by proxy stage) */
  proxyUrl?: string;
  /** User agent (set by fingerprint stage) */
  userAgent?: string;
  /** Abort signal */
  signal?: AbortSignal;
  /** Arbitrary metadata for inter-stage communication */
  metadata: Record<string, unknown>;
  /** Result from execute stage */
  result?: FetchResult;
  /** Whether the pipeline should retry */
  shouldRetry: boolean;
  /** Retry count */
  retryCount: number;
  /** Max retries */
  maxRetries: number;
}

/** Before hook: called before a stage executes. Return false to skip the stage. */
export type BeforeHook = (stage: PipelineStage, ctx: PipelineContext) => boolean | Promise<boolean>;

/** After hook: called after a stage executes. Return false to abort the pipeline. */
export type AfterHook = (stage: PipelineStage, ctx: PipelineContext, error?: Error) => boolean | Promise<boolean>;

/** Stage executor function */
export type StageExecutor = (ctx: PipelineContext) => Promise<PipelineContext>;

/** Timing record for a single stage execution */
export interface StageTiming {
  stage: PipelineStage;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** Pipeline execution result */
export interface PipelineResult {
  /** Final context after all stages */
  context: PipelineContext;
  /** Stage-by-stage timing */
  timings: StageTiming[];
  /** Total pipeline duration */
  totalDurationMs: number;
  /** Whether the pipeline completed successfully */
  success: boolean;
  /** Final error if pipeline failed */
  error?: string;
}

// ==================== Pipeline Metrics ====================

class PipelineMetricsCollector {
  private stageMetrics = new Map<PipelineStage, {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalDurationMs: number;
    maxDurationMs: number;
  }>();

  private pipelineMetrics = {
    totalExecutions: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    totalDurationMs: 0,
  };

  recordStage(stage: PipelineStage, durationMs: number, success: boolean): void {
    let metrics = this.stageMetrics.get(stage);
    if (!metrics) {
      metrics = { totalExecutions: 0, totalSuccesses: 0, totalFailures: 0, totalDurationMs: 0, maxDurationMs: 0 };
      this.stageMetrics.set(stage, metrics);
    }
    metrics.totalExecutions++;
    metrics.totalDurationMs += durationMs;
    if (success) metrics.totalSuccesses++;
    else metrics.totalFailures++;
    if (durationMs > metrics.maxDurationMs) metrics.maxDurationMs = durationMs;
  }

  recordPipeline(durationMs: number, success: boolean): void {
    this.pipelineMetrics.totalExecutions++;
    this.pipelineMetrics.totalDurationMs += durationMs;
    if (success) this.pipelineMetrics.totalSuccesses++;
    else this.pipelineMetrics.totalFailures++;
  }

  getStats(): {
    stages: Record<string, {
      executions: number;
      successes: number;
      failures: number;
      avgDurationMs: number;
      maxDurationMs: number;
      successRate: number;
    }>;
    pipeline: {
      executions: number;
      successes: number;
      failures: number;
      avgDurationMs: number;
      successRate: number;
    };
  } {
    const stages: Record<string, {
      executions: number;
      successes: number;
      failures: number;
      avgDurationMs: number;
      maxDurationMs: number;
      successRate: number;
    }> = {};

    for (const [stage, m] of this.stageMetrics) {
      stages[stage] = {
        executions: m.totalExecutions,
        successes: m.totalSuccesses,
        failures: m.totalFailures,
        avgDurationMs: m.totalExecutions > 0 ? Math.round(m.totalDurationMs / m.totalExecutions) : 0,
        maxDurationMs: m.maxDurationMs,
        successRate: m.totalExecutions > 0 ? m.totalSuccesses / m.totalExecutions : 0,
      };
    }

    const pm = this.pipelineMetrics;
    return {
      stages,
      pipeline: {
        executions: pm.totalExecutions,
        successes: pm.totalSuccesses,
        failures: pm.totalFailures,
        avgDurationMs: pm.totalExecutions > 0 ? Math.round(pm.totalDurationMs / pm.totalExecutions) : 0,
        successRate: pm.totalExecutions > 0 ? pm.totalSuccesses / pm.totalExecutions : 0,
      },
    };
  }
}

export const pipelineMetrics = new PipelineMetricsCollector();

// ==================== Request Pipeline ====================

export class RequestPipeline {
  private stages = new Map<PipelineStage, StageExecutor>();
  private beforeHooks: BeforeHook[] = [];
  private afterHooks: AfterHook[] = [];
  private metrics = pipelineMetrics;

  /**
   * Register a stage executor.
   */
  registerStage(stage: PipelineStage, executor: StageExecutor): this {
    this.stages.set(stage, executor);
    return this;
  }

  /**
   * Add a before hook (called before each stage).
   * Return false from the hook to skip the stage.
   */
  before(hook: BeforeHook): this {
    this.beforeHooks.push(hook);
    return this;
  }

  /**
   * Add an after hook (called after each stage).
   * Return false from the hook to abort the pipeline.
   */
  after(hook: AfterHook): this {
    this.afterHooks.push(hook);
    return this;
  }

  /**
   * Execute the pipeline for a given context.
   * Runs through all registered stages in order, calling hooks.
   */
  async execute(ctx: PipelineContext): Promise<PipelineResult> {
    const startTime = Date.now();
    const timings: StageTiming[] = [];
    let currentCtx = ctx;
    let success = true;
    let finalError: string | undefined;

    for (const stageName of ALL_STAGES) {
      const executor = this.stages.get(stageName);
      if (!executor) continue; // Skip unregistered stages

      // Run before hooks
      let shouldExecute = true;
      for (const hook of this.beforeHooks) {
        try {
          const result = await hook(stageName, currentCtx);
          if (!result) {
            shouldExecute = false;
            break;
          }
        } catch (err) {
          log.warn(`Before hook error in ${stageName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!shouldExecute) {
        timings.push({ stage: stageName, durationMs: 0, success: true });
        continue;
      }

      // Execute the stage
      const stageStart = Date.now();
      try {
        currentCtx = await executor(currentCtx);
        const durationMs = Date.now() - stageStart;
        timings.push({ stage: stageName, durationMs, success: true });
        this.metrics.recordStage(stageName, durationMs, true);

        // Run after hooks
        for (const hook of this.afterHooks) {
                   try {
            const result = await hook(stageName, currentCtx);
            if (!result) {
              throw new Error(`Pipeline aborted by after hook in stage ${stageName}`);
            }
          } catch (err) {
            if (err instanceof Error && err.message.startsWith('Pipeline aborted')) throw err;
            log.warn(`After hook error in ${stageName}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        const durationMs = Date.now() - stageStart;
        const errMsg = err instanceof Error ? err.message : String(err);
        timings.push({ stage: stageName, durationMs, success: false, error: errMsg.slice(0, 200) });
        this.metrics.recordStage(stageName, durationMs, false);

        // Run after hooks even on failure
        for (const hook of this.afterHooks) {
          try {
            const result = await hook(stageName, currentCtx, err instanceof Error ? err : new Error(errMsg));
            if (!result) break;
          } catch {
            // Hook errors are non-fatal
          }
        }

        success = false;
        finalError = errMsg.slice(0, 500);
        break;
      }
    }

    const totalDurationMs = Date.now() - startTime;
    this.metrics.recordPipeline(totalDurationMs, success);

    return {
      context: currentCtx,
      timings,
      totalDurationMs,
      success,
      error: finalError,
    };
  }

  /**
   * Get pipeline metrics.
   */
  getMetrics(): ReturnType<PipelineMetricsCollector['getStats']> {
    return this.metrics.getStats();
  }
}

// ==================== Default Pipeline Factory ====================

/**
 * Create a default request pipeline with standard stages.
 * Stages are no-ops by default — callers should register their own executors
 * or use the convenience registration methods.
 */
export function createRequestPipeline(): RequestPipeline {
  return new RequestPipeline();
}

/**
 * Create a fully-configured request pipeline with all default stage executors.
 * This provides a production-ready pipeline that integrates with the existing
 * stealth, rate-limiter, proxy, and retry systems.
 */
export function createDefaultPipeline(deps: {
  applyFingerprint: (ctx: PipelineContext) => Promise<PipelineContext>;
  applyDelay: (ctx: PipelineContext) => Promise<PipelineContext>;
  selectProxy: (ctx: PipelineContext) => Promise<PipelineContext>;
  executeRequest: (ctx: PipelineContext) => Promise<PipelineContext>;
  validateResponse: (ctx: PipelineContext) => Promise<PipelineContext>;
  handleRetry: (ctx: PipelineContext) => Promise<PipelineContext>;
}): RequestPipeline {
  const pipeline = new RequestPipeline();

  pipeline
    .registerStage('fingerprint', deps.applyFingerprint)
    .registerStage('delay', deps.applyDelay)
    .registerStage('proxy', deps.selectProxy)
    .registerStage('execute', deps.executeRequest)
    .registerStage('validate', deps.validateResponse)
    .registerStage('retry', deps.handleRetry);

  // Default after hook: log slow stages
  pipeline.after((stage, ctx, error) => {
    if (error) {
      log.warn(`Pipeline stage ${stage} failed for ${ctx.domain}: ${error.message?.slice(0, 100)}`);
    }
    return true; // Continue pipeline
  });

  return pipeline;
}
