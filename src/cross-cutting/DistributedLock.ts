export interface LockOptions {
  /** Lock key */
  key: string;
  /** Lock owner ID */
  owner: string;
  /** Lock TTL in ms */
  ttlMs: number;
  /** Fencing token (monotonic, prevents stale owners) */
  fencingToken?: number;
}

export interface LockResult {
  acquired: boolean;
  key: string;
  owner: string;
  fencingToken: number;
  expiresAt: number;
}

/**
 * Distributed lock backed by Redis with fencing token support.
 * Provides acquire, release, extend, and inspection operations with
 * stale-owner detection via monotonically increasing fencing tokens.
 */
export class DistributedLock {
  private redis: any;
  private locks = new Map<string, { owner: string; fencingToken: number; expiresAt: number }>();
  private fencingCounter = 0;
  private _operations: Array<{ op: string; key: string; owner: string; timestamp: number; success: boolean }> = [];

  /**
   * Construct a new DistributedLock backed by a Redis client.
   *
   * @param redis - Redis client instance (any compatible client with get/set/del/subscribe)
   */
  constructor(redis: any) {
    this.redis = redis;
  }

  get operations() { return this._operations; }

  /**
   * Attempt to acquire a distributed lock with fencing token.
   * Uses Redis SET NX PX for atomic acquisition.
   *
   * @param options - Lock parameters including key, owner, TTL, and optional fencing token
   * @returns Result indicating whether the lock was acquired, with fencing token and expiry
   */
  async acquire(options: LockOptions): Promise<LockResult> {
    const { key, owner, ttlMs } = options;
    const fencingToken = ++this.fencingCounter;

    try {
      const result = await this.redis.set(
        `lock:${key}`,
        JSON.stringify({ owner, fencingToken }),
        'NX', 'PX', ttlMs
      );

      const acquired = result === 'OK';
      const expiresAt = acquired ? Date.now() + ttlMs : 0;

      if (acquired) {
        this.locks.set(key, { owner, fencingToken, expiresAt });
      }

      this._operations.push({ op: 'acquire', key, owner, timestamp: Date.now(), success: acquired });

      return { acquired, key, owner, fencingToken: acquired ? fencingToken : 0, expiresAt };
    } catch (error) {
      this._operations.push({ op: 'acquire', key, owner, timestamp: Date.now(), success: false });
      return { acquired: false, key, owner, fencingToken: 0, expiresAt: 0 };
    }
  }

  /**
   * Release a distributed lock. Only succeeds if the caller is the current owner.
   *
   * @param key - Lock key to release
   * @param owner - Owner ID that acquired the lock
   * @returns true if the lock was successfully released
   */
  async release(key: string, owner: string): Promise<boolean> {
    try {
      const data = await this.redis.get(`lock:${key}`);
      if (!data) {
        this._operations.push({ op: 'release', key, owner, timestamp: Date.now(), success: false });
        return false;
      }

      const lockData = JSON.parse(data);
      if (lockData.owner !== owner) {
        this._operations.push({ op: 'release', key, owner, timestamp: Date.now(), success: false });
        return false;
      }

      await this.redis.del(`lock:${key}`);
      this.locks.delete(key);
      this._operations.push({ op: 'release', key, owner, timestamp: Date.now(), success: true });
      return true;
    } catch {
      this._operations.push({ op: 'release', key, owner, timestamp: Date.now(), success: false });
      return false;
    }
  }

  /**
   * Extend the TTL of an existing lock. Only succeeds if the caller is the current owner.
   *
   * @param key - Lock key to extend
   * @param owner - Owner ID that holds the lock
   * @param newTtlMs - New TTL in milliseconds
   * @returns true if the lock was successfully extended
   */
  async extend(key: string, owner: string, newTtlMs: number): Promise<boolean> {
    try {
      const data = await this.redis.get(`lock:${key}`);
      if (!data) return false;

      const lockData = JSON.parse(data);
      if (lockData.owner !== owner) return false;

      await this.redis.set(`lock:${key}`, data, 'PX', newTtlMs);
      const lock = this.locks.get(key);
      if (lock) lock.expiresAt = Date.now() + newTtlMs;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Inspect the current state of a lock without modifying it.
   *
   * @param key - Lock key to inspect
   * @returns Lock state if locked, or `{ locked: false }` if free, or null on error
   */
  async inspect(key: string): Promise<{ locked: boolean; owner?: string; fencingToken?: number } | null> {
    try {
      const data = await this.redis.get(`lock:${key}`);
      if (!data) return { locked: false };
      const lockData = JSON.parse(data);
      return { locked: true, owner: lockData.owner, fencingToken: lockData.fencingToken };
    } catch {
      return null;
    }
  }

  /**
   * Validate that a fencing token is valid for a given lock key.
   *
   * @param key - Lock key to check against
   * @param token - Fencing token to validate
   * @returns true if the token is at least as recent as the current lock's token
   */
  validateFencingToken(key: string, token: number): boolean {
    const lock = this.locks.get(key);
    if (!lock) return false;
    return token >= lock.fencingToken;
  }

  /**
   * Clean up expired locks from the local tracking map and Redis.
   *
   * @returns Array of lock keys that were cleaned up
   */
  async cleanupExpired(): Promise<string[]> {
    const cleaned: string[] = [];
    const now = Date.now();
    for (const [key, lock] of this.locks) {
      if (lock.expiresAt <= now) {
        await this.redis.del(`lock:${key}`);
        this.locks.delete(key);
        cleaned.push(key);
      }
    }
    return cleaned;
  }

  /**
   * Reset all lock state, clearing local tracking and operation history.
   */
  reset(): void {
    this.locks.clear();
    this._operations = [];
    this.fencingCounter = 0;
  }
}
