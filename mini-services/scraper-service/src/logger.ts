/**
 * Structured Logger for Scraper Service
 *
 * Replaces console.log/error/warn with a proper structured logger:
 *   - Levels: debug, info, warn, error
 *   - Format: [${timestamp}] [${level}] [${module}] ${message} ${meta?}
 *   - Production: info+ ; Development: debug+
 *   - Per-domain log buffering (flush every 5s or 100 entries)
 */

// ==================== Types ====================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  meta?: Record<string, unknown>;
  domain?: string;
}

// ==================== Constants ====================

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const BUFFER_FLUSH_INTERVAL_MS = 5_000;
const BUFFER_MAX_ENTRIES = 100;

// ==================== Log Buffer ====================

interface BufferEntry {
  formatted: string;
  level: LogLevel;
}

class LogBuffer {
  private entries: BufferEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxEntries: number;
  private readonly flushIntervalMs: number;

  constructor(maxEntries = BUFFER_MAX_ENTRIES, flushIntervalMs = BUFFER_FLUSH_INTERVAL_MS) {
    this.maxEntries = maxEntries;
    this.flushIntervalMs = flushIntervalMs;
    this.startFlushTimer();
  }

  add(formatted: string, level: LogLevel): void {
    this.entries.push({ formatted, level });
    if (this.entries.length >= this.maxEntries) {
      this.flush();
    }
  }

  flush(): void {
    if (this.entries.length === 0) return;
    // Write all buffered entries
    for (const entry of this.entries) {
      writeRaw(entry.formatted, entry.level);
    }
    this.entries = [];
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.flushTimer.unref) {
      this.flushTimer.unref(); // Don't keep process alive for timer
    }
  }

  destroy(): void {
    this.flush();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ==================== Raw Write ====================

function writeRaw(formatted: string, level: LogLevel): void {
  switch (level) {
    case 'error':
      process.stderr.write(formatted + '\n');
      break;
    case 'warn':
      process.stderr.write(formatted + '\n');
      break;
    default:
      process.stdout.write(formatted + '\n');
      break;
  }
}

// ==================== Format ====================

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').replace('Z', '');
}

function formatLogEntry(entry: LogEntry): string {
  const ts = formatTimestamp();
  const metaStr = entry.meta ? ' ' + JSON.stringify(entry.meta) : '';
  const domainStr = entry.domain ? ` [${entry.domain}]` : '';
  return `[${ts}] [${entry.level.toUpperCase()}] [${entry.module}]${domainStr} ${entry.message}${metaStr}`;
}

// ==================== ScraperLogger ====================

class ScraperLogger {
  private minLevel: LogLevel;
  private buffer: LogBuffer;
  private domainBuffers: Map<string, LogBuffer> = new Map();

  constructor() {
    const envLevel = (process.env.LOG_LEVEL || '').toLowerCase();
    const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
    this.minLevel = (envLevel in LEVEL_PRIORITY)
      ? envLevel as LogLevel
      : (isDev ? 'debug' : 'info');
    this.buffer = new LogBuffer();
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private emit(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;
    const formatted = formatLogEntry(entry);

    // Domain-specific buffering
    if (entry.domain) {
      let domainBuf = this.domainBuffers.get(entry.domain);
      if (!domainBuf) {
        domainBuf = new LogBuffer();
        this.domainBuffers.set(entry.domain, domainBuf);
        // Limit total domain buffers
        if (this.domainBuffers.size > 200) {
          const oldest = this.domainBuffers.keys().next().value;
          if (oldest) {
            const old = this.domainBuffers.get(oldest);
            old?.destroy();
            this.domainBuffers.delete(oldest);
          }
        }
      }
      domainBuf.add(formatted, entry.level);
    } else {
      // Immediate write for non-domain logs
      writeRaw(formatted, entry.level);
    }
  }

  // ---- Public API ----

  debug(module: string, message: string, meta?: Record<string, unknown>, domain?: string): void {
    this.emit({ timestamp: new Date().toISOString(), level: 'debug', module, message, meta, domain });
  }

  info(module: string, message: string, meta?: Record<string, unknown>, domain?: string): void {
    this.emit({ timestamp: new Date().toISOString(), level: 'info', module, message, meta, domain });
  }

  warn(module: string, message: string, meta?: Record<string, unknown>, domain?: string): void {
    this.emit({ timestamp: new Date().toISOString(), level: 'warn', module, message, meta, domain });
  }

  error(module: string, message: string, meta?: Record<string, unknown>, domain?: string): void {
    this.emit({ timestamp: new Date().toISOString(), level: 'error', module, message, meta, domain });
  }

  /**
   * Create a child logger bound to a specific module.
   */
  child(module: string): ModuleLogger {
    return new ModuleLogger(this, module);
  }

  /**
   * Flush all buffers (for graceful shutdown).
   */
  flush(): void {
    this.buffer.flush();
    for (const buf of this.domainBuffers.values()) {
      buf.flush();
    }
  }

  /**
   * Destroy all buffers (for graceful shutdown).
   */
  destroy(): void {
    this.buffer.destroy();
    for (const buf of this.domainBuffers.values()) {
      buf.destroy();
    }
    this.domainBuffers.clear();
  }

  /**
   * Set log level at runtime.
   */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * Get current log level.
   */
  getLevel(): LogLevel {
    return this.minLevel;
  }
}

// ==================== Module Logger ====================

export class ModuleLogger {
  constructor(private root: ScraperLogger, private module: string) {}

  debug(message: string, meta?: Record<string, unknown>, domain?: string): void {
    this.root.debug(this.module, message, meta, domain);
  }

  info(message: string, meta?: Record<string, unknown>, domain?: string): void {
    this.root.info(this.module, message, meta, domain);
  }

  warn(message: string, meta?: Record<string, unknown>, domain?: string): void {
    this.root.warn(this.module, message, meta, domain);
  }

  error(message: string, meta?: Record<string, unknown>, domain?: string): void {
    this.root.error(this.module, message, meta, domain);
  }
}

// ==================== Singleton ====================

export const logger = new ScraperLogger();
