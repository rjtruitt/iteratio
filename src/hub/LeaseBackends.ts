import { ILeaseBackend, Lease, LeaseAcquisitionResult, LeaseRenewalResult } from './LeaseTypes.js';

/**
 * In-memory backend simulating etcd lease semantics.
 *
 * Provides atomic CAS acquisition, keep-alive renewal, voluntary release,
 * and watcher notifications. Fencing tokens are generated as monotonically
 * increasing revision counters (mimicking etcd key revisions).
 *
 * For production, replace the in-memory store with etcd3 client calls.
 */
export class EtcdLeaseBackend implements ILeaseBackend {
  private leases: Map<string, Lease> = new Map();
  private fencingCounters: Map<string, number> = new Map();
  private watchers: Map<string, Array<(lease: Lease | null) => void>> = new Map();
  private closed = false;

  /** @inheritdoc */
  async acquire(
    leaseKey: string,
    holderId: string,
    ttl: number,
    metadata?: Record<string, any>
  ): Promise<LeaseAcquisitionResult> {
    if (this.closed) {
      return { acquired: false, reason: 'Backend closed' };
    }

    const existing = this.leases.get(leaseKey);
    if (existing && Date.now() < existing.expiresAt) {
      return {
        acquired: false,
        currentHolder: existing.holderId,
        reason: 'Lease already held',
      };
    }

    const counter = (this.fencingCounters.get(leaseKey) ?? 0) + 1;
    this.fencingCounters.set(leaseKey, counter);

    const lease: Lease = {
      id: `etcd-lease-${counter}`,
      holderId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttl,
      ttl,
      fencingToken: counter,
      metadata,
    };

    this.leases.set(leaseKey, lease);
    this.notifyWatchers(leaseKey, lease);

    return { acquired: true, lease };
  }

  /** @inheritdoc */
  async renew(leaseKey: string, holderId: string, ttl: number): Promise<LeaseRenewalResult> {
    if (this.closed) {
      return { renewed: false, reason: 'Backend closed' };
    }

    const lease = this.leases.get(leaseKey);
    if (!lease) {
      return { renewed: false, reason: 'No lease exists' };
    }
    if (lease.holderId !== holderId) {
      return { renewed: false, reason: 'Not the lease holder' };
    }
    if (Date.now() > lease.expiresAt) {
      this.leases.delete(leaseKey);
      this.notifyWatchers(leaseKey, null);
      return { renewed: false, reason: 'Lease expired' };
    }

    lease.expiresAt = Date.now() + ttl;
    this.notifyWatchers(leaseKey, lease);

    return { renewed: true, expiresAt: lease.expiresAt };
  }

  /** @inheritdoc */
  async release(leaseKey: string, holderId: string): Promise<boolean> {
    if (this.closed) return false;

    const lease = this.leases.get(leaseKey);
    if (!lease || lease.holderId !== holderId) {
      return false;
    }

    this.leases.delete(leaseKey);
    this.notifyWatchers(leaseKey, null);
    return true;
  }

  /** @inheritdoc */
  async getLease(leaseKey: string): Promise<Lease | null> {
    if (this.closed) return null;

    const lease = this.leases.get(leaseKey);
    if (lease && Date.now() > lease.expiresAt) {
      this.leases.delete(leaseKey);
      return null;
    }
    return lease ?? null;
  }

  /** @inheritdoc */
  async watch(leaseKey: string, callback: (lease: Lease | null) => void): Promise<void> {
    if (!this.watchers.has(leaseKey)) {
      this.watchers.set(leaseKey, []);
    }
    this.watchers.get(leaseKey)!.push(callback);
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    this.closed = true;
    this.watchers.clear();
  }

  /**
   * Notify all registered watchers for a given lease key.
   *
   * @param leaseKey - The lease slot key being watched
   * @param lease - The updated lease state, or null if released/expired
   */
  private notifyWatchers(leaseKey: string, lease: Lease | null): void {
    const callbacks = this.watchers.get(leaseKey);
    if (callbacks) {
      for (const cb of callbacks) {
        cb(lease);
      }
    }
  }
}

/**
 * In-memory backend simulating Redis lease semantics.
 *
 * Provides SET NX EX style atomic acquisition, Lua-script-style holder
 * validation for renewal/release, INCR-based fencing tokens, and
 * pub/sub-style watcher notifications.
 *
 * For production, replace with ioredis client using Lua scripts for atomicity.
 */
export class RedisLeaseBackend implements ILeaseBackend {
  private leases: Map<string, Lease> = new Map();
  private fencingCounters: Map<string, number> = new Map();
  private watchers: Map<string, Array<(lease: Lease | null) => void>> = new Map();
  private closed = false;

  /** @inheritdoc */
  async acquire(
    leaseKey: string,
    holderId: string,
    ttl: number,
    metadata?: Record<string, any>
  ): Promise<LeaseAcquisitionResult> {
    if (this.closed) {
      return { acquired: false, reason: 'Backend closed' };
    }

    const existing = this.leases.get(leaseKey);
    if (existing && Date.now() < existing.expiresAt) {
      return {
        acquired: false,
        currentHolder: existing.holderId,
        reason: 'Lease already held',
      };
    }

    const counter = (this.fencingCounters.get(leaseKey) ?? 0) + 1;
    this.fencingCounters.set(leaseKey, counter);

    const lease: Lease = {
      id: `redis-lease-${counter}`,
      holderId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttl,
      ttl,
      fencingToken: counter,
      metadata,
    };

    this.leases.set(leaseKey, lease);
    this.notifyWatchers(leaseKey, lease);

    return { acquired: true, lease };
  }

  /** @inheritdoc */
  async renew(leaseKey: string, holderId: string, ttl: number): Promise<LeaseRenewalResult> {
    if (this.closed) {
      return { renewed: false, reason: 'Backend closed' };
    }

    const lease = this.leases.get(leaseKey);
    if (!lease) {
      return { renewed: false, reason: 'No lease exists' };
    }
    if (lease.holderId !== holderId) {
      return { renewed: false, reason: 'Not the lease holder' };
    }
    if (Date.now() > lease.expiresAt) {
      this.leases.delete(leaseKey);
      this.notifyWatchers(leaseKey, null);
      return { renewed: false, reason: 'Lease expired' };
    }

    lease.expiresAt = Date.now() + ttl;
    this.notifyWatchers(leaseKey, lease);

    return { renewed: true, expiresAt: lease.expiresAt };
  }

  /** @inheritdoc */
  async release(leaseKey: string, holderId: string): Promise<boolean> {
    if (this.closed) return false;

    const lease = this.leases.get(leaseKey);
    if (!lease || lease.holderId !== holderId) {
      return false;
    }

    this.leases.delete(leaseKey);
    this.notifyWatchers(leaseKey, null);
    return true;
  }

  /** @inheritdoc */
  async getLease(leaseKey: string): Promise<Lease | null> {
    if (this.closed) return null;

    const lease = this.leases.get(leaseKey);
    if (lease && Date.now() > lease.expiresAt) {
      this.leases.delete(leaseKey);
      return null;
    }
    return lease ?? null;
  }

  /** @inheritdoc */
  async watch(leaseKey: string, callback: (lease: Lease | null) => void): Promise<void> {
    if (!this.watchers.has(leaseKey)) {
      this.watchers.set(leaseKey, []);
    }
    this.watchers.get(leaseKey)!.push(callback);
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    this.closed = true;
    this.watchers.clear();
  }

  /**
   * Notify all registered watchers for a given lease key.
   *
   * @param leaseKey - The lease slot key being watched
   * @param lease - The updated lease state, or null if released/expired
   */
  private notifyWatchers(leaseKey: string, lease: Lease | null): void {
    const callbacks = this.watchers.get(leaseKey);
    if (callbacks) {
      for (const cb of callbacks) {
        cb(lease);
      }
    }
  }
}
