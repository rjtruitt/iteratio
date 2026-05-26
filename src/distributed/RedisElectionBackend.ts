import type { IElectionBackend } from './LeaderElection.js';

/** Redis-backed implementation of IElectionBackend using atomic SET NX for distributed locking. */
export class RedisElectionBackend implements IElectionBackend {
  private redis: any;
  private watchers: Map<string, { interval: any; lastLeader: string | null }> = new Map();

  constructor(redis: any) {
    this.redis = redis;
  }

  /**
   * Attempts to become the leader for the given election key using Redis SET NX.
   * If this candidate already holds the key, extends its TTL.
   */
  async campaign(electionKey: string, candidateId: string, ttl: number): Promise<boolean> {
    const result = await this.redis.set(electionKey, candidateId, 'NX', 'PX', ttl);
    if (result === 'OK') {
      return true;
    }
    const current = await this.redis.get(electionKey);
    if (current === candidateId) {
      await this.redis.expire(electionKey, Math.ceil(ttl / 1000));
      return true;
    }
    return false;
  }

  /** Gets the current leader ID for the election key, or null. */
  async getLeader(electionKey: string): Promise<string | null> {
    return await this.redis.get(electionKey);
  }

  /** Resigns leadership by deleting the election key if this candidate holds it. */
  async resign(electionKey: string, candidateId: string): Promise<void> {
    const current = await this.redis.get(electionKey);
    if (current === candidateId) {
      await this.redis.del(electionKey);
    }
  }

  /**
   * Polls the Redis key every 500ms and invokes the callback when the leader changes.
   * If the backend becomes unreachable, the callback is invoked with null.
   */
  async watch(electionKey: string, callback: (leader: string | null) => void): Promise<void> {
    let lastLeader = await this.redis.get(electionKey);
    const interval = setInterval(async () => {
      try {
        const currentLeader = await this.redis.get(electionKey);
        if (currentLeader !== lastLeader) {
          lastLeader = currentLeader;
          callback(currentLeader);
        }
      } catch {
        if (lastLeader !== null) {
          lastLeader = null;
          callback(null);
        }
      }
    }, 500); // Poll every 500ms

    this.watchers.set(electionKey, { interval, lastLeader });
  }

  /** Stops watching a specific election key. */
  async stopWatch(electionKey: string): Promise<void> {
    const watcher = this.watchers.get(electionKey);
    if (watcher) {
      clearInterval(watcher.interval);
      this.watchers.delete(electionKey);
    }
  }

  /** Closes all watchers and releases resources. */
  async close(): Promise<void> {
    for (const [key, watcher] of this.watchers) {
      clearInterval(watcher.interval);
    }
    this.watchers.clear();
  }
}
