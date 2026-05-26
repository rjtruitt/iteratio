/**
 * Rate limit configuration for a provider.
 */
export interface RateLimitConfig {
  /** Tokens per minute limit. */
  tpm?: number;

  /** Requests per minute limit. */
  rpm?: number;

  /** Tokens per day limit. */
  tpd?: number;

  /** Requests per day limit. */
  rpd?: number;

  /** Maximum concurrent requests. */
  concurrent?: number;
}

/**
 * Current usage metrics across all tracked dimensions.
 */
export interface UsageMetrics {
  /** Tokens consumed in the current minute window. */
  tpm: number;

  /** Requests made in the current minute window. */
  rpm: number;

  /** Tokens consumed in the current day window. */
  tpd: number;

  /** Requests made in the current day window. */
  rpd: number;

  /** Currently in-flight requests. */
  concurrent: number;
}

/**
 * Detailed result of a rate limit check, indicating whether a request
 * is permitted and providing current usage context.
 */
export interface RateLimitCheckResult {
  /** Whether the request is allowed under current limits. */
  allowed: boolean;

  /** Which limit was exceeded (present when allowed is false). */
  limitExceeded?: 'tpm' | 'rpm' | 'tpd' | 'rpd' | 'concurrent';

  /** Human-readable rejection reason. */
  reason?: string;

  /** Current usage metrics at time of check. */
  usage: UsageMetrics;

  /** Configured limits being enforced. */
  limits: RateLimitConfig;

  /** Timestamp when the exceeded limit will reset. */
  resetAt?: number;

  /** Remaining capacity per dimension. */
  remaining?: {
    tpm?: number;
    rpm?: number;
    tpd?: number;
    rpd?: number;
    concurrent?: number;
  };
}

/** A single usage entry in a sliding window. */
export interface UsageEntry {
  timestamp: number;
  tokens: number;
  requests: number;
}

/** Per-client usage tracking state. */
export interface ClientUsage {
  minuteWindow: UsageEntry[];
  dayWindow: UsageEntry[];
  concurrent: number;
  lastCleanup: number;
}
