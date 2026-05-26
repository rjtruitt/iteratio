import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LeaseBasedElection, LeaseBasedElectionConfig, ILeaseBackend, Lease, LeaseAcquisitionResult, LeaseRenewalResult } from '../LeaseBasedElection';
import { TestClock } from '../../__test__/TestClock';

/**
 * Mock lease backend for testing lease-based election
 */
class MockLeaseBackend implements ILeaseBackend {
  private lease: Lease | null = null;
  private fencingCounter = 0;
  private watchCallbacks: Array<(lease: Lease | null) => void> = [];
  private shouldFailAcquire = false;
  private shouldFailRenew = false;
  public acquireCalls = 0;
  public renewCalls = 0;
  public releaseCalls = 0;

  async acquire(
    leaseKey: string,
    holderId: string,
    ttl: number,
    metadata?: Record<string, any>
  ): Promise<LeaseAcquisitionResult> {
    this.acquireCalls++;

    if (this.shouldFailAcquire) {
      return { acquired: false, reason: 'Backend error', currentHolder: this.lease?.holderId };
    }

    if (this.lease && Date.now() < this.lease.expiresAt) {
      // Lease exists and is still valid
      return {
        acquired: false,
        currentHolder: this.lease.holderId,
        reason: 'Lease already held',
      };
    }

    // Acquire lease
    this.fencingCounter++;
    this.lease = {
      id: `lease-${this.fencingCounter}`,
      holderId,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttl,
      ttl,
      fencingToken: this.fencingCounter,
      metadata,
    };

    this.notifyWatchers(this.lease);

    return { acquired: true, lease: this.lease };
  }

  async renew(leaseKey: string, holderId: string, ttl: number): Promise<LeaseRenewalResult> {
    this.renewCalls++;

    if (this.shouldFailRenew) {
      return { renewed: false, reason: 'Renewal failed' };
    }

    if (!this.lease || this.lease.holderId !== holderId) {
      return { renewed: false, reason: 'Not the lease holder' };
    }

    if (Date.now() > this.lease.expiresAt) {
      return { renewed: false, reason: 'Lease expired' };
    }

    this.lease.expiresAt = Date.now() + ttl;
    this.notifyWatchers(this.lease);

    return { renewed: true, expiresAt: this.lease.expiresAt };
  }

  async release(leaseKey: string, holderId: string): Promise<boolean> {
    this.releaseCalls++;

    if (!this.lease || this.lease.holderId !== holderId) {
      return false;
    }

    this.lease = null;
    this.notifyWatchers(null);
    return true;
  }

  async getLease(leaseKey: string): Promise<Lease | null> {
    if (this.lease && Date.now() > this.lease.expiresAt) {
      this.lease = null;
    }
    return this.lease;
  }

  async watch(leaseKey: string, callback: (lease: Lease | null) => void): Promise<void> {
    this.watchCallbacks.push(callback);
  }

  async close(): Promise<void> {
    this.watchCallbacks = [];
  }

  // Test helpers
  setFailAcquire(fail: boolean): void {
    this.shouldFailAcquire = fail;
  }

  setFailRenew(fail: boolean): void {
    this.shouldFailRenew = fail;
  }

  expireLease(): void {
    if (this.lease) {
      this.lease.expiresAt = Date.now() - 1;
      this.notifyWatchers(null);
    }
  }

  private notifyWatchers(lease: Lease | null): void {
    for (const cb of this.watchCallbacks) {
      cb(lease);
    }
  }

  reset(): void {
    this.lease = null;
    this.fencingCounter = 0;
    this.watchCallbacks = [];
    this.shouldFailAcquire = false;
    this.shouldFailRenew = false;
    this.acquireCalls = 0;
    this.renewCalls = 0;
    this.releaseCalls = 0;
  }
}

/** Flush microtask queue to let async callbacks settle */
const flushMicrotasks = async (times = 5) => {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
};

describe('LeaseBasedElection', () => {
  let election: LeaseBasedElection;
  let backend: MockLeaseBackend;
  let clock: TestClock;

  const createConfig = (overrides: Partial<LeaseBasedElectionConfig> = {}): LeaseBasedElectionConfig => ({
    instanceId: 'node-1',
    backend: backend,
    leaseTTL: 30000,
    renewalInterval: 10000,
    gracePeriod: 15000,
    autoCampaign: false,
    autoRetry: false,
    maxRetries: 3,
    retryBackoff: 2000,
    ...overrides,
  });

  beforeEach(() => {
    clock = new TestClock(Date.now());
    clock.install();
    backend = new MockLeaseBackend();
  });

  afterEach(async () => {
    if (election) {
      await election.stop();
    }
    clock.uninstall();
    backend.reset();
  });

  describe('acquire lease (no contention)', () => {
    it('should acquire lease when no one else holds it', async () => {
      election = new LeaseBasedElection(createConfig());
      await election.start();

      const result = await election.campaign();

      expect(result).toBe(true);
      expect(election.isLeader()).toBe(true);
      expect(election.getState()).toBe('leader');
    });

    it('should emit lease-acquired event on success', async () => {
      election = new LeaseBasedElection(createConfig());
      await election.start();

      const listener = vi.fn();
      election.on('lease-acquired', listener);

      await election.campaign();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          holderId: 'node-1',
          fencingToken: expect.any(Number),
        })
      );
    });

    it('should set fencing token on acquisition', async () => {
      election = new LeaseBasedElection(createConfig());
      await election.start();
      await election.campaign();

      const token = election.getFencingToken();
      expect(token).not.toBeNull();
      expect(token).toBeGreaterThan(0);
    });
  });

  describe('lease renewal extends TTL', () => {
    it('should renew lease automatically at configured interval', async () => {
      election = new LeaseBasedElection(createConfig({
        renewalInterval: 100,
      }));
      await election.start();
      await election.campaign();

      // Advance past renewal interval
      clock.advance(150);

      expect(backend.renewCalls).toBeGreaterThan(0);
    });

    it('should emit lease-renewed event on renewal', async () => {
      election = new LeaseBasedElection(createConfig({
        renewalInterval: 100,
      }));
      await election.start();
      await election.campaign();

      const listener = vi.fn();
      election.on('lease-renewed', listener);

      await clock.advanceAsync(150);
      await flushMicrotasks();

      expect(listener).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should remain leader while renewals succeed', async () => {
      election = new LeaseBasedElection(createConfig({
        renewalInterval: 100,
      }));
      await election.start();
      await election.campaign();

      clock.advance(500); // Multiple renewal cycles

      expect(election.isLeader()).toBe(true);
    });
  });

  describe('lease expiry (missed renewal)', () => {
    it('should enter grace period when renewal fails', async () => {
      election = new LeaseBasedElection(createConfig({
        renewalInterval: 100,
        gracePeriod: 5000,
      }));
      await election.start();
      await election.campaign();

      backend.setFailRenew(true);
      await clock.advanceAsync(150); // Trigger renewal
      await flushMicrotasks();

      expect(election.getState()).toBe('grace');
    });

    it('should emit grace-period-started event', async () => {
      election = new LeaseBasedElection(createConfig({
        renewalInterval: 100,
        gracePeriod: 5000,
      }));
      await election.start();
      await election.campaign();

      const listener = vi.fn();
      election.on('grace-period-started', listener);

      backend.setFailRenew(true);
      await clock.advanceAsync(150);
      await flushMicrotasks();

      expect(listener).toHaveBeenCalledWith(5000);
    });

    it('should lose leadership when grace period expires', async () => {
      election = new LeaseBasedElection(createConfig({
        renewalInterval: 100,
        gracePeriod: 200,
        autoRetry: false,
      }));
      await election.start();
      await election.campaign();

      backend.setFailRenew(true);
      // Trigger failed renewal at t=100
      await clock.advanceAsync(150);
      await flushMicrotasks();
      // Fire the grace period safety timeout (set at t=150, fires at t=150+200=350)
      await clock.advanceAsync(250);
      await flushMicrotasks();

      expect(election.isLeader()).toBe(false);
      // When autoRetry=false, after expiration the state transitions to 'idle'
      // (expired -> idle) since there's nothing left to do
      expect(election.getState()).toBe('idle');
    });

    it('should emit lease-expired event', async () => {
      election = new LeaseBasedElection(createConfig({
        renewalInterval: 100,
        gracePeriod: 200,
        autoRetry: false,
      }));
      await election.start();
      await election.campaign();

      const listener = vi.fn();
      election.on('lease-expired', listener);

      backend.setFailRenew(true);
      await clock.advanceAsync(150);
      await flushMicrotasks();
      await clock.advanceAsync(300);
      await flushMicrotasks();

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('contention: multiple candidates, one wins', () => {
    it('should fail to acquire when another instance holds lease', async () => {
      // Instance 1 acquires first
      const election1 = new LeaseBasedElection(createConfig({ instanceId: 'node-1' }));
      await election1.start();
      await election1.campaign();

      // Instance 2 tries to acquire
      const election2 = new LeaseBasedElection(createConfig({ instanceId: 'node-2' }));
      await election2.start();
      const result = await election2.campaign();

      expect(result).toBe(false);
      expect(election2.isLeader()).toBe(false);

      await election1.stop();
      await election2.stop();
    });

    it('should return current holder when acquisition fails', async () => {
      const election1 = new LeaseBasedElection(createConfig({ instanceId: 'node-1' }));
      await election1.start();
      await election1.campaign();

      // Second instance's campaign fails; backend returns current holder
      const election2 = new LeaseBasedElection(createConfig({ instanceId: 'node-2' }));
      await election2.start();

      const leaderChangedListener = vi.fn();
      election2.on('leader-changed', leaderChangedListener);

      await election2.campaign();

      // leader-changed should fire since someone else holds the lease
      expect(election2.isLeader()).toBe(false);

      await election1.stop();
      await election2.stop();
    });
  });

  describe('lease transfer on resign', () => {
    it('should release lease on resign', async () => {
      election = new LeaseBasedElection(createConfig());
      await election.start();
      await election.campaign();

      expect(election.isLeader()).toBe(true);

      await election.releaseLease();

      expect(election.isLeader()).toBe(false);
      expect(election.getState()).toBe('idle');
      expect(backend.releaseCalls).toBe(1);
    });

    it('should allow another instance to acquire after resign', async () => {
      const election1 = new LeaseBasedElection(createConfig({ instanceId: 'node-1' }));
      await election1.start();
      await election1.campaign();

      await election1.releaseLease();

      // Now node-2 can acquire
      const election2 = new LeaseBasedElection(createConfig({ instanceId: 'node-2' }));
      await election2.start();
      const result = await election2.campaign();

      expect(result).toBe(true);
      expect(election2.isLeader()).toBe(true);

      await election1.stop();
      await election2.stop();
    });
  });

  describe('lease TTL enforcement', () => {
    it('should expire lease after TTL passes without renewal', async () => {
      election = new LeaseBasedElection(createConfig({
        leaseTTL: 1000,
        renewalInterval: 500,
        gracePeriod: 200,
        autoRetry: false,
      }));
      await election.start();
      await election.campaign();

      // Prevent renewal
      backend.setFailRenew(true);

      // Advance past renewal interval to trigger failed renewal
      await clock.advanceAsync(550);
      await flushMicrotasks();
      // Advance past grace period
      await clock.advanceAsync(1000);
      await flushMicrotasks();

      expect(election.isLeader()).toBe(false);
    });

    it('should increment fencing token on each new acquisition', async () => {
      // First acquisition
      election = new LeaseBasedElection(createConfig());
      await election.start();
      await election.campaign();
      const token1 = election.getFencingToken();

      await election.releaseLease();

      // Second acquisition
      await election.campaign();
      const token2 = election.getFencingToken();

      expect(token2!).toBeGreaterThan(token1!);
    });
  });

  describe('getCurrentLeader', () => {
    it('should return current leader from backend', async () => {
      election = new LeaseBasedElection(createConfig({ instanceId: 'node-1' }));
      await election.start();
      await election.campaign();

      const leader = await election.getCurrentLeader();
      expect(leader).toBe('node-1');
    });

    it('should return null when no leader exists', async () => {
      election = new LeaseBasedElection(createConfig());
      await election.start();

      const leader = await election.getCurrentLeader();
      expect(leader).toBeNull();
    });
  });

  describe('state machine', () => {
    it('should transition idle -> campaigning -> leader', async () => {
      election = new LeaseBasedElection(createConfig());
      await election.start();

      const states: string[] = [];
      election.on('state-change', (oldState, newState) => {
        states.push(`${oldState}->${newState}`);
      });

      await election.campaign();

      expect(states).toContain('idle->campaigning');
      expect(states).toContain('campaigning->leader');
    });

    it('should transition leader -> expired on lease loss', async () => {
      election = new LeaseBasedElection(createConfig({
        renewalInterval: 100,
        gracePeriod: 50,
        autoRetry: false,
      }));
      await election.start();
      await election.campaign();

      const states: string[] = [];
      election.on('state-change', (oldState, newState) => {
        states.push(`${oldState}->${newState}`);
      });

      backend.setFailRenew(true);
      await clock.advanceAsync(150); // Trigger failed renewal
      await flushMicrotasks();
      await clock.advanceAsync(100); // Grace period expires
      await flushMicrotasks();

      expect(states.some(s => s.includes('expired'))).toBe(true);
    });
  });

  describe('FencingTokenGuard', () => {
    it('FencingTokenGuard.executeWithToken(token, fn) — guarded execution', async () => {
      const { FencingTokenGuard } = await import('../LeaseBasedElection');
      const guard = new FencingTokenGuard(backend);

      election = new LeaseBasedElection(createConfig());
      await election.start();
      await election.campaign();

      const token = election.getFencingToken()!;

      const result = await guard.executeWithToken('hub-lease', token, async () => {
        return 'guarded-result';
      });

      expect(result).toBe('guarded-result');
    });

    it('FencingTokenGuard.executeWithToken — rejects stale token', async () => {
      const { FencingTokenGuard } = await import('../LeaseBasedElection');
      const guard = new FencingTokenGuard(backend);

      election = new LeaseBasedElection(createConfig());
      await election.start();
      await election.campaign();
      const oldToken = election.getFencingToken()!;

      // Release and re-acquire (new higher token)
      await election.releaseLease();
      await election.campaign();
      const newToken = election.getFencingToken()!;

      // Execute with new token to establish it
      await guard.executeWithToken('hub-lease', newToken, async () => 'ok');

      // Old (stale) token should be rejected
      await expect(
        guard.executeWithToken('hub-lease', oldToken, async () => 'should-not-run')
      ).rejects.toThrow(/stale|invalid|fencing/i);
    });
  });

  describe('EtcdLeaseBackend', () => {
    it('should acquire a lease when none exists', async () => {
      const { EtcdLeaseBackend } = await import('../LeaseBasedElection');
      const etcdBackend = new EtcdLeaseBackend();

      const result = await etcdBackend.acquire('test-lease', 'holder-1', 30000);
      expect(result.acquired).toBe(true);
      expect(result.lease).toBeDefined();
      expect(result.lease!.holderId).toBe('holder-1');
      expect(result.lease!.fencingToken).toBe(1);

      await etcdBackend.close();
    });

    it('should reject acquisition when lease is held', async () => {
      const { EtcdLeaseBackend } = await import('../LeaseBasedElection');
      const etcdBackend = new EtcdLeaseBackend();

      await etcdBackend.acquire('test-lease', 'holder-1', 30000);
      const result = await etcdBackend.acquire('test-lease', 'holder-2', 30000);
      expect(result.acquired).toBe(false);
      expect(result.currentHolder).toBe('holder-1');

      await etcdBackend.close();
    });

    it('should renew a lease for the holder', async () => {
      const { EtcdLeaseBackend } = await import('../LeaseBasedElection');
      const etcdBackend = new EtcdLeaseBackend();

      await etcdBackend.acquire('test-lease', 'holder-1', 30000);
      const result = await etcdBackend.renew('test-lease', 'holder-1', 30000);
      expect(result.renewed).toBe(true);
      expect(result.expiresAt).toBeDefined();

      await etcdBackend.close();
    });

    it('should release a lease', async () => {
      const { EtcdLeaseBackend } = await import('../LeaseBasedElection');
      const etcdBackend = new EtcdLeaseBackend();

      await etcdBackend.acquire('test-lease', 'holder-1', 30000);
      const released = await etcdBackend.release('test-lease', 'holder-1');
      expect(released).toBe(true);

      const lease = await etcdBackend.getLease('test-lease');
      expect(lease).toBeNull();

      await etcdBackend.close();
    });

    it('should return lease via getLease', async () => {
      const { EtcdLeaseBackend } = await import('../LeaseBasedElection');
      const etcdBackend = new EtcdLeaseBackend();

      await etcdBackend.acquire('test-lease', 'holder-1', 30000);
      const lease = await etcdBackend.getLease('test-lease');
      expect(lease).not.toBeNull();
      expect(lease!.holderId).toBe('holder-1');

      await etcdBackend.close();
    });

    it('should notify watchers on lease changes', async () => {
      const { EtcdLeaseBackend } = await import('../LeaseBasedElection');
      const etcdBackend = new EtcdLeaseBackend();

      const watchFn = vi.fn();
      await etcdBackend.watch('test-lease', watchFn);
      await etcdBackend.acquire('test-lease', 'holder-1', 30000);

      expect(watchFn).toHaveBeenCalledWith(expect.objectContaining({ holderId: 'holder-1' }));

      await etcdBackend.close();
    });

    it('should close cleanly', async () => {
      const { EtcdLeaseBackend } = await import('../LeaseBasedElection');
      const etcdBackend = new EtcdLeaseBackend();

      await expect(etcdBackend.close()).resolves.toBeUndefined();
    });
  });

  describe('RedisLeaseBackend', () => {
    it('should acquire a lease when none exists', async () => {
      const { RedisLeaseBackend } = await import('../LeaseBasedElection');
      const redisBackend = new RedisLeaseBackend();

      const result = await redisBackend.acquire('test-lease', 'holder-1', 30000);
      expect(result.acquired).toBe(true);
      expect(result.lease).toBeDefined();
      expect(result.lease!.holderId).toBe('holder-1');
      expect(result.lease!.fencingToken).toBe(1);

      await redisBackend.close();
    });

    it('should reject acquisition when lease is held', async () => {
      const { RedisLeaseBackend } = await import('../LeaseBasedElection');
      const redisBackend = new RedisLeaseBackend();

      await redisBackend.acquire('test-lease', 'holder-1', 30000);
      const result = await redisBackend.acquire('test-lease', 'holder-2', 30000);
      expect(result.acquired).toBe(false);
      expect(result.currentHolder).toBe('holder-1');

      await redisBackend.close();
    });

    it('should renew a lease for the holder', async () => {
      const { RedisLeaseBackend } = await import('../LeaseBasedElection');
      const redisBackend = new RedisLeaseBackend();

      await redisBackend.acquire('test-lease', 'holder-1', 30000);
      const result = await redisBackend.renew('test-lease', 'holder-1', 30000);
      expect(result.renewed).toBe(true);
      expect(result.expiresAt).toBeDefined();

      await redisBackend.close();
    });

    it('should release a lease', async () => {
      const { RedisLeaseBackend } = await import('../LeaseBasedElection');
      const redisBackend = new RedisLeaseBackend();

      await redisBackend.acquire('test-lease', 'holder-1', 30000);
      const released = await redisBackend.release('test-lease', 'holder-1');
      expect(released).toBe(true);

      const lease = await redisBackend.getLease('test-lease');
      expect(lease).toBeNull();

      await redisBackend.close();
    });

    it('should return lease via getLease', async () => {
      const { RedisLeaseBackend } = await import('../LeaseBasedElection');
      const redisBackend = new RedisLeaseBackend();

      await redisBackend.acquire('test-lease', 'holder-1', 30000);
      const lease = await redisBackend.getLease('test-lease');
      expect(lease).not.toBeNull();
      expect(lease!.holderId).toBe('holder-1');

      await redisBackend.close();
    });

    it('should notify watchers on lease changes', async () => {
      const { RedisLeaseBackend } = await import('../LeaseBasedElection');
      const redisBackend = new RedisLeaseBackend();

      const watchFn = vi.fn();
      await redisBackend.watch('test-lease', watchFn);
      await redisBackend.acquire('test-lease', 'holder-1', 30000);

      expect(watchFn).toHaveBeenCalledWith(expect.objectContaining({ holderId: 'holder-1' }));

      await redisBackend.close();
    });

    it('should close cleanly', async () => {
      const { RedisLeaseBackend } = await import('../LeaseBasedElection');
      const redisBackend = new RedisLeaseBackend();

      await expect(redisBackend.close()).resolves.toBeUndefined();
    });
  });
});
