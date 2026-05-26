import { EventEmitter } from 'events';
import type {
  RateLimitConfig,
  UsageMetrics,
  RateLimitCheckResult,
  UsageEntry,
  ClientUsage,
} from './RateLimiterTypes.js';

export type { RateLimitConfig, UsageMetrics, RateLimitCheckResult } from './RateLimiterTypes.js';

/**
 * Enforces rate limits using a sliding window algorithm.
 *
 * Tracks per-model, per-client usage across minute and day windows,
 * plus concurrent request counts. Old entries are periodically purged.
 *
 * Events emitted:
 * - `limit-exceeded` - (modelName: string, clientId: string, limitType: string)
 * - `usage-tracked` - (modelName: string, clientId: string, usage: UsageMetrics)
 * - `limit-reset` - (modelName: string, clientId: string, window: string)
 */
export class RateLimiter extends EventEmitter {
  private limits: Map<string, RateLimitConfig> = new Map();
  private usage: Map<string, Map<string, ClientUsage>> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupInterval = 60000;

  constructor() {
    super();
    this.startCleanup();
  }

  /**
   * Configure rate limits for a model.
   *
   * @param modelName - Model name to limit
   * @param limits - Rate limit configuration
   * @throws Error if any limit value is negative
   */
  setLimits(modelName: string, limits: RateLimitConfig): void {
    for (const [key, value] of Object.entries(limits)) {
      if (typeof value === 'number' && value < 0) {
        throw new Error(`Invalid rate limit: ${key} cannot be negative (got ${value})`);
      }
    }

    console.log(`[RateLimiter] Setting limits for ${modelName}:`, limits);
    this.limits.set(modelName, limits);
  }

  /**
   * Get configured limits for a model.
   *
   * @param modelName - Model name to query
   * @returns Rate limit config or null if none configured
   */
  getLimits(modelName: string): RateLimitConfig | null {
    return this.limits.get(modelName) ?? null;
  }

  /**
   * Check whether a request is within rate limits.
   *
   * Evaluates all configured dimensions (TPM, RPM, TPD, RPD, concurrent)
   * and returns the first exceeded limit or an allowed result with remaining capacity.
   *
   * @param modelName - Model being requested
   * @param clientId - Client making the request
   * @param estimatedTokens - Estimated token count for this request
   * @returns Detailed rate limit check result
   */
  checkLimit(
    modelName: string,
    clientId: string,
    estimatedTokens: number = 0
  ): RateLimitCheckResult {
    const limits = this.limits.get(modelName);

    if (!limits) {
      return {
        allowed: true,
        usage: { tpm: 0, rpm: 0, tpd: 0, rpd: 0, concurrent: 0 },
        limits: {},
      };
    }

    const clientUsage = this.getClientUsage(modelName, clientId);
    this.cleanupClientUsage(clientUsage);
    const usage = this.calculateUsage(clientUsage);

    if (limits.concurrent !== undefined && usage.concurrent >= limits.concurrent) {
      return {
        allowed: false,
        limitExceeded: 'concurrent',
        reason: `Concurrent request limit exceeded: ${usage.concurrent}/${limits.concurrent}`,
        usage,
        limits,
      };
    }

    if (limits.tpm !== undefined) {
      const projectedTPM = usage.tpm + estimatedTokens;
      if (projectedTPM > limits.tpm) {
        return {
          allowed: false,
          limitExceeded: 'tpm',
          reason: `TPM limit exceeded: ${projectedTPM}/${limits.tpm}`,
          usage,
          limits,
          resetAt: this.getResetTime('minute'),
          remaining: {
            tpm: Math.max(0, limits.tpm - usage.tpm),
          },
        };
      }
    }

    if (limits.rpm !== undefined && usage.rpm >= limits.rpm) {
      return {
        allowed: false,
        limitExceeded: 'rpm',
        reason: `RPM limit exceeded: ${usage.rpm}/${limits.rpm}`,
        usage,
        limits,
        resetAt: this.getResetTime('minute'),
        remaining: {
          rpm: Math.max(0, limits.rpm - usage.rpm),
        },
      };
    }

    if (limits.tpd !== undefined) {
      const projectedTPD = usage.tpd + estimatedTokens;
      if (projectedTPD > limits.tpd) {
        return {
          allowed: false,
          limitExceeded: 'tpd',
          reason: `TPD limit exceeded: ${projectedTPD}/${limits.tpd}`,
          usage,
          limits,
          resetAt: this.getResetTime('day'),
          remaining: {
            tpd: Math.max(0, limits.tpd - usage.tpd),
          },
        };
      }
    }

    if (limits.rpd !== undefined && usage.rpd >= limits.rpd) {
      return {
        allowed: false,
        limitExceeded: 'rpd',
        reason: `RPD limit exceeded: ${usage.rpd}/${limits.rpd}`,
        usage,
        limits,
        resetAt: this.getResetTime('day'),
        remaining: {
          rpd: Math.max(0, limits.rpd - usage.rpd),
        },
      };
    }

    return {
      allowed: true,
      usage,
      limits,
      remaining: {
        tpm: limits.tpm ? limits.tpm - usage.tpm : undefined,
        rpm: limits.rpm ? limits.rpm - usage.rpm : undefined,
        tpd: limits.tpd ? limits.tpd - usage.tpd : undefined,
        rpd: limits.rpd ? limits.rpd - usage.rpd : undefined,
        concurrent: limits.concurrent ? limits.concurrent - usage.concurrent : undefined,
      },
    };
  }

  /**
   * Record usage after a request completes.
   *
   * Adds entries to both the minute and day sliding windows and
   * increments the concurrent counter.
   *
   * @param modelName - Model that was used
   * @param clientId - Client that made the request
   * @param tokens - Actual tokens consumed
   */
  trackUsage(modelName: string, clientId: string, tokens: number): void {
    const clientUsage = this.getClientUsage(modelName, clientId);

    const now = Date.now();
    const entry: UsageEntry = {
      timestamp: now,
      tokens,
      requests: 1,
    };

    clientUsage.minuteWindow.push(entry);
    clientUsage.dayWindow.push(entry);
    clientUsage.concurrent++;

    const usage = this.calculateUsage(clientUsage);
    this.emit('usage-tracked', modelName, clientId, usage);

    console.log(
      `[RateLimiter] Tracked usage for ${modelName} (${clientId}): ` +
      `${tokens} tokens, ${usage.tpm} TPM, ${usage.rpm} RPM`
    );
  }

  /**
   * Increment the concurrent request counter (call before execution).
   *
   * @param modelName - Model being requested
   * @param clientId - Client making the request
   */
  requestStarted(modelName: string, clientId: string): void {
    const clientUsage = this.getClientUsage(modelName, clientId);
    clientUsage.concurrent++;
  }

  /**
   * Decrement the concurrent request counter (call after execution).
   *
   * @param modelName - Model that was used
   * @param clientId - Client that completed the request
   */
  requestCompleted(modelName: string, clientId: string): void {
    const clientUsage = this.getClientUsage(modelName, clientId);
    clientUsage.concurrent = Math.max(0, clientUsage.concurrent - 1);
  }

  /**
   * Get current usage metrics for a specific client and model.
   *
   * @param modelName - Model to query
   * @param clientId - Client to query
   * @returns Current usage metrics
   */
  getUsage(modelName: string, clientId: string): UsageMetrics {
    const clientUsage = this.getClientUsage(modelName, clientId);
    this.cleanupClientUsage(clientUsage);
    return this.calculateUsage(clientUsage);
  }

  /**
   * Reset all tracked usage for a specific client and model.
   *
   * @param modelName - Model to reset
   * @param clientId - Client to reset
   */
  resetUsage(modelName: string, clientId: string): void {
    const modelUsage = this.usage.get(modelName);
    if (modelUsage) {
      modelUsage.delete(clientId);
    }

    console.log(`[RateLimiter] Reset usage for ${modelName} (${clientId})`);
  }

  /**
   * Stop the rate limiter's cleanup timer and release resources.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private getClientUsage(modelName: string, clientId: string): ClientUsage {
    let modelUsage = this.usage.get(modelName);
    if (!modelUsage) {
      modelUsage = new Map();
      this.usage.set(modelName, modelUsage);
    }

    let clientUsage = modelUsage.get(clientId);
    if (!clientUsage) {
      clientUsage = {
        minuteWindow: [],
        dayWindow: [],
        concurrent: 0,
        lastCleanup: Date.now(),
      };
      modelUsage.set(clientId, clientUsage);
    }

    return clientUsage;
  }

  private calculateUsage(clientUsage: ClientUsage): UsageMetrics {
    const now = Date.now();
    const minuteAgo = now - 60000;
    const dayAgo = now - 86400000;

    let tpm = 0;
    let rpm = 0;
    for (const entry of clientUsage.minuteWindow) {
      if (entry.timestamp >= minuteAgo) {
        tpm += entry.tokens;
        rpm += entry.requests;
      }
    }

    let tpd = 0;
    let rpd = 0;
    for (const entry of clientUsage.dayWindow) {
      if (entry.timestamp >= dayAgo) {
        tpd += entry.tokens;
        rpd += entry.requests;
      }
    }

    return {
      tpm,
      rpm,
      tpd,
      rpd,
      concurrent: clientUsage.concurrent,
    };
  }

  private cleanupClientUsage(clientUsage: ClientUsage): void {
    const now = Date.now();
    const minuteAgo = now - 60000;
    const dayAgo = now - 86400000;

    clientUsage.minuteWindow = clientUsage.minuteWindow.filter(
      entry => entry.timestamp >= minuteAgo
    );

    clientUsage.dayWindow = clientUsage.dayWindow.filter(
      entry => entry.timestamp >= dayAgo
    );

    clientUsage.lastCleanup = now;
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupAll();
    }, this.cleanupInterval);
  }

  private cleanupAll(): void {
    const now = Date.now();

    for (const [_modelName, modelUsage] of this.usage.entries()) {
      for (const [clientId, clientUsage] of modelUsage.entries()) {
        if (now - clientUsage.lastCleanup > this.cleanupInterval) {
          this.cleanupClientUsage(clientUsage);

          if (
            clientUsage.minuteWindow.length === 0 &&
            clientUsage.dayWindow.length === 0 &&
            clientUsage.concurrent === 0
          ) {
            modelUsage.delete(clientId);
          }
        }
      }

      if (modelUsage.size === 0) {
        this.usage.delete(_modelName);
      }
    }
  }

  private getResetTime(window: 'minute' | 'day'): number {
    const now = Date.now();

    if (window === 'minute') {
      return Math.ceil(now / 60000) * 60000;
    } else {
      const date = new Date(now);
      date.setHours(24, 0, 0, 0);
      return date.getTime();
    }
  }
}
