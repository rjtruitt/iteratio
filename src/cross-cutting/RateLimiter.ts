export interface RateLimiterConfig {
  /** Max tokens per window */
  maxTokens: number;
  /** Window duration in ms */
  windowMs: number;
  /** Scope: per-agent or per-pool */
  scope?: 'per-agent' | 'per-pool';
  /** Fair distribution among agents */
  fairDistribution?: boolean;
  /** Redis client for distributed coordination */
  redis?: any;
  /** Identifier for this limiter instance */
  id?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterMs?: number;
  queuePosition?: number;
}

interface QueuedRequest {
  id: string;
  resolve: (result: RateLimitResult) => void;
  priority: number;
  timestamp: number;
  agentId?: string;
}

/**
 * Token-bucket rate limiter with optional fair distribution across agents,
 * queuing for delayed processing, and Redis-backed distributed coordination.
 */
export class RateLimiter {
  private config: RateLimiterConfig;
  private tokens: number;
  private windowStart: number;
  private queue: QueuedRequest[] = [];
  private _requests: Array<{ agentId?: string; timestamp: number; allowed: boolean }> = [];
  private refillTimer?: any;
  private redisConnected: boolean;
  private agentUsage = new Map<string, number>();

  /**
   * Create a new RateLimiter with the given token-bucket configuration.
   *
   * @param config - Rate limiter configuration (max tokens, window, scope, Redis client, etc.)
   */
  constructor(config: RateLimiterConfig) {
    this.config = config;
    this.tokens = config.maxTokens;
    this.windowStart = Date.now();
    this.redisConnected = !!config.redis;
  }

  get requests() { return this._requests; }
  get currentTokens() { return this.tokens; }
  get queueLength() { return this.queue.length; }

  /**
   * Try to acquire a token
   */
  async tryAcquire(agentId?: string, priority: number = 0): Promise<RateLimitResult> {
    this.refillIfNeeded();

    if (this.config.fairDistribution && agentId) {
      const usage = this.agentUsage.get(agentId) || 0;
      const agentCount = Math.max(this.agentUsage.size, 1);
      const fairShare = Math.floor(this.config.maxTokens / agentCount);
      if (usage >= fairShare && this.tokens < this.config.maxTokens * 0.5) {
        const result: RateLimitResult = {
          allowed: false,
          remainingTokens: this.tokens,
          retryAfterMs: this.timeUntilRefill(),
        };
        this._requests.push({ agentId, timestamp: Date.now(), allowed: false });
        return result;
      }
    }

    if (this.tokens > 0) {
      this.tokens--;
      if (agentId) {
        this.agentUsage.set(agentId, (this.agentUsage.get(agentId) || 0) + 1);
      }
      const result: RateLimitResult = { allowed: true, remainingTokens: this.tokens };
      this._requests.push({ agentId, timestamp: Date.now(), allowed: true });

      if (this.config.redis && this.redisConnected) {
        try {
          await this.syncToRedis();
        } catch {
          this.redisConnected = false;
        }
      }

      return result;
    }

    const result: RateLimitResult = {
      allowed: false,
      remainingTokens: 0,
      retryAfterMs: this.timeUntilRefill(),
    };
    this._requests.push({ agentId, timestamp: Date.now(), allowed: false });
    return result;
  }

  /**
   * Queue a request for when tokens become available
   */
  enqueue(agentId?: string, priority: number = 0): Promise<RateLimitResult> {
    return new Promise((resolve) => {
      const request: QueuedRequest = {
        id: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        resolve,
        priority,
        timestamp: Date.now(),
        agentId,
      };
      this.queue.push(request);
      this.queue.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);
    });
  }

  /**
   * Process queued requests (called after refill)
   */
  processQueue(): number {
    let processed = 0;
    while (this.queue.length > 0 && this.tokens > 0) {
      const request = this.queue.shift()!;
      this.tokens--;
      if (request.agentId) {
        this.agentUsage.set(request.agentId, (this.agentUsage.get(request.agentId) || 0) + 1);
      }
      request.resolve({ allowed: true, remainingTokens: this.tokens });
      processed++;
    }
    return processed;
  }

  /**
   * Cancel queued requests (e.g., on timeout)
   */
  cancelQueued(predicate: (req: QueuedRequest) => boolean): number {
    const before = this.queue.length;
    const cancelled = this.queue.filter(predicate);
    this.queue = this.queue.filter(r => !predicate(r));
    for (const req of cancelled) {
      req.resolve({ allowed: false, remainingTokens: this.tokens, retryAfterMs: -1 });
    }
    return before - this.queue.length;
  }

  /**
   * Force refill tokens (simulates window reset)
   */
  refill(): void {
    this.tokens = this.config.maxTokens;
    this.windowStart = Date.now();
    this.agentUsage.clear();
    this.processQueue();
  }

  /**
   * Consume tokens from external source (e.g., another machine used some)
   */
  consumeExternal(count: number): void {
    this.tokens = Math.max(0, this.tokens - count);
  }

  /**
   * Sync state from Redis (for distributed coordination)
   */
  async syncFromRedis(): Promise<void> {
    if (!this.config.redis) return;
    try {
      const key = `ratelimit:${this.config.id || 'default'}`;
      const val = await this.config.redis.get(key);
      if (val !== null) {
        const state = JSON.parse(val);
        this.tokens = Math.min(this.tokens, state.tokens);
      }
      this.redisConnected = true;
    } catch {
      this.redisConnected = false;
    }
  }

  /**
   * Synchronize the current token state to Redis for distributed coordination.
   */
  private async syncToRedis(): Promise<void> {
    if (!this.config.redis) return;
    const key = `ratelimit:${this.config.id || 'default'}`;
    await this.config.redis.set(key, JSON.stringify({ tokens: this.tokens, windowStart: this.windowStart }));
  }

  /**
   * Refill tokens if the current window has elapsed.
   */
  private refillIfNeeded(): void {
    const elapsed = Date.now() - this.windowStart;
    if (elapsed >= this.config.windowMs) {
      this.refill();
    }
  }

  /**
   * Calculate milliseconds until the next token refill.
   *
   * @returns Milliseconds until refill (0 if due now)
   */
  private timeUntilRefill(): number {
    const elapsed = Date.now() - this.windowStart;
    return Math.max(0, this.config.windowMs - elapsed);
  }

  getUsageByAgent(): Map<string, number> {
    return new Map(this.agentUsage);
  }

  isRedisConnected(): boolean {
    return this.redisConnected;
  }

  setRedisConnected(connected: boolean): void {
    this.redisConnected = connected;
  }

  reset(): void {
    this.tokens = this.config.maxTokens;
    this.windowStart = Date.now();
    this.queue = [];
    this._requests = [];
    this.agentUsage.clear();
  }
}
