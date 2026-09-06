/**
 * Error Recovery System
 *
 * Classifies scraping errors into recovery categories and defines
 * escalation strategies for each category. Tracks error patterns
 * per domain for proactive avoidance and automatic rule adjustment.
 *
 * Categories:
 *   - retryable: transient errors, retry with backoff
 *   - auth_needed: login/auth required, escalate to credential provider
 *   - proxy_needed: IP blocked, rotate proxy
 *   - skip: permanent failure, skip this URL
 *   - rule_adjust: rule needs adjustment, re-generate or tweak
 *
 * Features:
 *   - Error classification with recovery category mapping
 *   - Escalation strategies per category (with increasing severity)
 *   - Per-domain error pattern tracking for proactive avoidance
 *   - Automatic rule adjustment on repeated failures
 *   - Recovery metrics (recovery rate, time-to-recovery)
 */

import { logger } from './logger';
const log = logger.child('ErrorRecovery');

import { ScrapeError, ErrorCategory, classifyErrorTaxonomy } from './error-handler';

// ==================== Types ====================

export type RecoveryCategory = 'retryable' | 'auth_needed' | 'proxy_needed' | 'skip' | 'rule_adjust';

export interface RecoveryStrategy {
  /** Recovery category */
  category: RecoveryCategory;
  /** Escal'ation level (0=initial, 1=escalated, 2=max) */
  escalationLevel: number;
  /** Actions to take */
  actions: RecoveryAction[];
  /** Delay before next attempt (ms) */
  delayMs: number;
  /** Whether to retry the request */
  shouldRetry: boolean;
  /** Human-readable description */
  description: string;
}

export type RecoveryAction =
  | 'retry_with_backoff'
  | 'rotate_proxy'
  | 'upgrade_engine'
  | 'provide_credentials'
  | 'adjust_delay'
  | 'rebuild_rule'
  | 'skip_url'
  | 'cool_down_domain'
  | 'wait_and_retry';

export interface DomainErrorProfile {
  domain: string;
  /** Error counts by category */
  errorCounts: Record<RecoveryCategory, number>;
  /** Total error count */
  totalErrors: number;
  /** Consecutive error count */
  consecutiveErrors: number;
  /** Best known recovery strategy per category */
  bestStrategies: Partial<Record<RecoveryCategory, string>>;
  /** Last error timestamp */
  lastErrorTime: number;
  /** Domain cooldown until timestamp (0 = no cooldown) */
  cooldownUntil: number;
  /** Whether this domain should be temporarily avoided */
  shouldAvoid: boolean;
}

export interface RecoveryMetrics {
  /** Total recovery attempts */
  totalAttempts: number;
  /** Successful recoveries */
  successfulRecoveries: number;
  /** Recovery rate (0-1) */
  recoveryRate: number;
  /** Average time to recovery (ms) */
  avgTimeToRecovery: number;
  /** Recoveries by category */
  recoveriesByCategory: Record<RecoveryCategory, number>;
}

// ==================== Error Classification → Recovery Category ====================

const CATEGORY_TO_RECOVERY: Record<ErrorCategory, RecoveryCategory> = {
  network_transient: 'retryable',
  network_permanent: 'skip',
  proxy_failure: 'proxy_needed',
  rate_limit_soft: 'retryable',
  rate_limit_hard: 'proxy_needed',
  captcha_challenge: 'retryable',
  auth_failure: 'auth_needed',
  content_block: 'proxy_needed',
  content_invalid: 'rule_adjust',
  content_empty: 'rule_adjust',
  server_error: 'retryable',
  engine_crash: 'retryable',
  resource_exhausted: 'retryable',
  unknown: 'retryable',
};

/**
 * Classify a scraping error into a recovery category.
 */
export function classifyRecovery(error: unknown, statusCode?: number): RecoveryCategory {
  const classification = classifyErrorTaxonomy(error, statusCode);
  return CATEGORY_TO_RECOVERY[classification.category] || 'retryable';
}

// ==================== Escalation Strategies ====================

const ESCALATION_STRATEGIES: Record<RecoveryCategory, Array<{
  level: number;
  actions: RecoveryAction[];
  delayMs: number;
  shouldRetry: boolean;
  description: string;
}>> = {
  retryable: [
    { level: 0, actions: ['retry_with_backoff'], delayMs: 2000, shouldRetry: true, description: 'Retry with exponential backoff' },
    { level: 1, actions: ['rotate_proxy', 'retry_with_backoff'], delayMs: 5000, shouldRetry: true, description: 'Rotate proxy and retry' },
    { level: 2, actions: ['upgrade_engine', 'retry_with_backoff'], delayMs: 10000, shouldRetry: true, description: 'Upgrade engine and retry' },
  ],
  auth_needed: [
    { level: 0, actions: ['provide_credentials'], delayMs: 1000, shouldRetry: true, description: 'Provide credentials and retry' },
    { level: 1, actions: ['cool_down_domain'], delayMs: 60000, shouldRetry: false, description: 'Cool down domain, cannot authenticate' },
    { level: 2, actions: ['skip_url'], delayMs: 0, shouldRetry: false, description: 'Skip URL, authentication not available' },
  ],
  proxy_needed: [
    { level: 0, actions: ['rotate_proxy', 'retry_with_backoff'], delayMs: 3000, shouldRetry: true, description: 'Rotate proxy and retry' },
    { level: 1, actions: ['upgrade_engine', 'rotate_proxy'], delayMs: 5000, shouldRetry: true, description: 'Upgrade engine with new proxy' },
    { level: 2, actions: ['cool_down_domain'], delayMs: 30000, shouldRetry: false, description: 'Cool down domain, all proxies exhausted' },
  ],
  skip: [
    { level: 0, actions: ['skip_url'], delayMs: 0, shouldRetry: false, description: 'Skip URL (permanent failure)' },
    { level: 1, actions: ['skip_url'], delayMs: 0, shouldRetry: false, description: 'Skip URL (permanent failure)' },
    { level: 2, actions: ['skip_url'], delayMs: 0, shouldRetry: false, description: 'Skip URL (permanent failure)' },
  ],
  rule_adjust: [
    { level: 0, actions: ['adjust_delay', 'retry_with_backoff'], delayMs: 3000, shouldRetry: true, description: 'Adjust delay and retry' },
    { level: 1, actions: ['rebuild_rule'], delayMs: 5000, shouldRetry: true, description: 'Rebuild rule and retry' },
    { level: 2, actions: ['skip_url'], delayMs: 0, shouldRetry: false, description: 'Skip URL after rule adjustment failures' },
  ],
};

// ==================== Domain Error Tracking ====================

const domainProfiles = new Map<string, DomainErrorProfile>();
const MAX_DOMAIN_PROFILES = 500;

function getOrCreateProfile(domain: string): DomainErrorProfile {
  let profile = domainProfiles.get(domain);
  if (!profile) {
    if (domainProfiles.size >= MAX_DOMAIN_PROFILES) {
      // Evict oldest
      let oldest = '';
      let oldestTime = Infinity;
      for (const [d, p] of domainProfiles) {
        if (p.lastErrorTime < oldestTime) { oldestTime = p.lastErrorTime; oldest = d; }
      }
      if (oldest) domainProfiles.delete(oldest);
    }
    profile = {
      domain,
      errorCounts: { retryable: 0, auth_needed: 0, proxy_needed: 0, skip: 0, rule_adjust: 0 },
      totalErrors: 0,
      consecutiveErrors: 0,
      bestStrategies: {},
      lastErrorTime: 0,
      cooldownUntil: 0,
      shouldAvoid: false,
    };
    domainProfiles.set(domain, profile);
  }
  return profile;
}

// ==================== Recovery Metrics ====================

const metrics: RecoveryMetrics = {
  totalAttempts: 0,
  successfulRecoveries: 0,
  recoveryRate: 0,
  avgTimeToRecovery: 0,
  recoveriesByCategory: { retryable: 0, auth_needed: 0, proxy_needed: 0, skip: 0, rule_adjust: 0 },
};

// Track recovery start times for time-to-recovery calculation
const recoveryStartTimes = new Map<string, number>();

// ==================== Main Recovery Function ====================

/**
 * Determine the recovery strategy for a scraping error.
 *
 * @param error - The error that occurred
 * @param domain - The domain being scraped
 * @param url - The URL being scraped
 * @param statusCode - HTTP status code (if available)
 * @param retryCount - Current retry count
 * @returns Recovery strategy with actions and delay
 */
export function determineRecoveryStrategy(
  error: unknown,
  domain: string,
  url: string,
  statusCode?: number,
  retryCount: number = 0,
): RecoveryStrategy {
  const category = classifyRecovery(error, statusCode);
  const profile = getOrCreateProfile(domain);

  // Update domain error profile
  profile.errorCounts[category]++;
  profile.totalErrors++;
  profile.consecutiveErrors++;
  profile.lastErrorTime = Date.now();

  // Determine escalation level based on retry count and consecutive errors
  let escalationLevel = 0;
  if (retryCount >= 3 || profile.consecutiveErrors >= 5) escalationLevel = 1;
  if (retryCount >= 6 || profile.consecutiveErrors >= 10) escalationLevel = 2;

  // Get strategy for this escalation level
  const strategies = ESCALATION_STRATEGIES[category];
  const strategy = strategies[Math.min(escalationLevel, strategies.length - 1)]!;

  // Additional logic based on domain profile
  const actions = [...strategy.actions];
  let delayMs = strategy.delayMs;

  // If domain has many proxy_needed errors, add cooldown
  if (profile.errorCounts.proxy_needed >= 5 && !actions.includes('cool_down_domain')) {
    actions.push('cool_down_domain');
    profile.cooldownUntil = Date.now() + 5 * 60_000; // 5 minute cooldown
    log.info(`Domain ${domain} added to cooldown (5 min) due to repeated proxy failures`);
  }

  // If domain has many auth_needed errors, mark as shouldAvoid
  if (profile.errorCounts.auth_needed >= 3) {
    profile.shouldAvoid = true;
    log.info(`Domain ${domain} marked as should-avoid due to repeated auth failures`);
  }

  // If domain has many rule_adjust errors, suggest rule rebuild
  if (profile.errorCounts.rule_adjust >= 3 && !actions.includes('rebuild_rule')) {
    actions.push('rebuild_rule');
    log.info(`Domain ${domain} flagged for rule rebuild due to repeated content issues`);
  }

  // Apply exponential backoff for retryable errors
  if (category === 'retryable') {
    const cappedRetry = Math.min(retryCount, 10);
    delayMs = Math.min(delayMs * Math.pow(2, cappedRetry), 120_000);
  }

  // Record recovery attempt
  metrics.totalAttempts++;
  recoveryStartTimes.set(url, Date.now());

  log.info(`Recovery: [${category}] L${escalationLevel} for ${domain} - ${strategy.description}`);

  return {
    category,
    escalationLevel,
    actions,
    delayMs,
    shouldRetry: strategy.shouldRetry,
    description: strategy.description,
  };
}

/**
 * Record a successful recovery for metrics and domain profile.
 */
export function recordSuccessfulRecovery(
  domain: string,
  url: string,
  category: RecoveryCategory,
): void {
  const profile = domainProfiles.get(domain);
  if (profile) {
    profile.consecutiveErrors = 0;
    profile.shouldAvoid = false;
    profile.bestStrategies[category] = 'retry_with_backoff';
  }

  // Update metrics
  metrics.successfulRecoveries++;
  metrics.recoveriesByCategory[category]++;
  if (metrics.totalAttempts > 0) {
    metrics.recoveryRate = metrics.successfulRecoveries / metrics.totalAttempts;
  }

  // Track time-to-recovery
  const startTime = recoveryStartTimes.get(url);
  if (startTime) {
    const ttr = Date.now() - startTime;
    metrics.avgTimeToRecovery = metrics.avgTimeToRecovery * 0.9 + ttr * 0.1;
    recoveryStartTimes.delete(url);
  }
}

/**
 * Check if a domain is currently in cooldown.
 */
export function isDomainInCooldown(domain: string): boolean {
  const profile = domainProfiles.get(domain);
  if (!profile) return false;
  if (profile.cooldownUntil > Date.now()) return true;
  // Clear expired cooldown
  profile.cooldownUntil = 0;
  return false;
}

/**
 * Get the cooldown remaining time for a domain (ms).
 */
export function getDomainCooldownRemaining(domain: string): number {
  const profile = domainProfiles.get(domain);
  if (!profile || profile.cooldownUntil === 0) return 0;
  return Math.max(0, profile.cooldownUntil - Date.now());
}

/**
 * Check if a domain should be avoided due to repeated failures.
 */
export function shouldAvoidDomain(domain: string): boolean {
  const profile = domainProfiles.get(domain);
  return profile?.shouldAvoid === true;
}

/**
 * Clear a domain's avoidance flag (manual override).
 */
export function clearDomainAvoidance(domain: string): void {
  const profile = domainProfiles.get(domain);
  if (profile) {
    profile.shouldAvoid = false;
    profile.consecutiveErrors = 0;
    profile.cooldownUntil = 0;
  }
}

/**
 * Get the error profile for a domain.
 */
export function getDomainProfile(domain: string): DomainErrorProfile | undefined {
  const profile = domainProfiles.get(domain);
  return profile ? { ...profile, errorCounts: { ...profile.errorCounts }, bestStrategies: { ...profile.bestStrategies } } : undefined;
}

/**
 * Get all domain error profiles (for dashboard).
 */
export function getAllDomainProfiles(): DomainErrorProfile[] {
  return Array.from(domainProfiles.values())
    .map(p => ({ ...p, errorCounts: { ...p.errorCounts }, bestStrategies: { ...p.bestStrategies } }))
    .sort((a, b) => b.totalErrors - a.totalErrors);
}

/**
 * Get recovery metrics.
 */
export function getRecoveryMetrics(): RecoveryMetrics {
  return { ...metrics, recoveriesByCategory: { ...metrics.recoveriesByCategory } };
}

/**
 * Reset all error recovery state.
 */
export function resetErrorRecovery(): void {
  domainProfiles.clear();
  recoveryStartTimes.clear();
  metrics.totalAttempts = 0;
  metrics.successfulRecoveries = 0;
  metrics.recoveryRate = 0;
  metrics.avgTimeToRecovery = 0;
  metrics.recoveriesByCategory = { retryable: 0, auth_needed: 0, proxy_needed: 0, skip: 0, rule_adjust: 0 };
}
