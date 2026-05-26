import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { TestScheduler } from '../../__test__/TestScheduler';
import { WorkCoordinator } from '../WorkCoordinator';

describe('WorkCoordinator', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let coordinator: WorkCoordinator;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock(1000000);
    clock.install();
    coordinator = new WorkCoordinator({ redis });
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('acquireLock / claimWork', () => {
    it('should acquire lock via SETNX when key does not exist', async () => {
      const acquired = await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      expect(acquired).toBe(true);
      // Verify SET NX was used
      const setCmd = redis.commands.find(
        c => c.cmd === 'set' && c.args[0] === 'work:task-1:lock'
      );
      expect(setCmd).toBeDefined();
      expect(setCmd!.args).toContain('NX');
    });

    it('should fail to acquire lock when already held by another agent', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      const acquired = await coordinator.claimWork('task-1', 'agent-B', { ttl: 5000 });
      expect(acquired).toBe(false);
    });

    it('should store the lock holder identity as the value', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      const lockValue = await redis.get('work:task-1:lock');
      expect(lockValue).toBe('agent-A');
    });

    it('should set TTL on the lock key', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 10000 });

      const ttl = await redis.ttl('work:task-1:lock');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
    });

    it('should use default TTL when none provided', async () => {
      // Default TTL is 300000ms = 5 minutes
      await coordinator.claimWork('task-1', 'agent-A');

      const ttl = await redis.ttl('work:task-1:lock');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('should allow same agent to re-acquire its own lock (idempotent)', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      // Same agent re-claiming should succeed (idempotent)
      const acquired = await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      expect(acquired).toBe(true);
    });

    it('should update work item status to in_progress when claimed', async () => {
      // First create the work
      const workId = await coordinator.createWork('test task', { type: 'task' });
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      const work = await coordinator.getWork(workId);
      expect(work).not.toBeNull();
      expect(work!.status).toBe('in_progress');
      expect(work!.assignedTo).toBe('agent-A');
    });

    it('should increment attempts counter on each claim', async () => {
      const workId = await coordinator.createWork('test task', { type: 'task' });

      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });
      let work = await coordinator.getWork(workId);
      expect(work!.attempts).toBe(1);

      // Release and re-claim
      await coordinator.releaseWork(workId, 'agent-A', { status: 'available' });
      await coordinator.claimWork(workId, 'agent-B', { ttl: 5000 });
      work = await coordinator.getWork(workId);
      expect(work!.attempts).toBe(2);
    });

    it('should remove claimed work from available index', async () => {
      const workId = await coordinator.createWork('test task', { type: 'task' });

      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      const available = await coordinator.getWorkByStatus('available');
      const ids = available.map(w => w.id);
      expect(ids).not.toContain(workId);
    });

    it('should use Lua script for atomic SET NX EX operation', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      // Verify atomic operation - either eval for Lua or set with NX EX
      const setCmd = redis.commands.find(c => c.cmd === 'set' || c.cmd === 'eval');
      expect(setCmd).toBeDefined();
    });

    it('should handle concurrent acquireLock - only one wins', async () => {
      const scheduler = new TestScheduler();

      // Simulate two agents racing to claim same work
      const claim1 = coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      const claim2 = coordinator.claimWork('task-1', 'agent-B', { ttl: 5000 });

      const [result1, result2] = await Promise.all([claim1, claim2]);

      // Exactly one should succeed
      const successes = [result1, result2].filter(r => r === true);
      expect(successes).toHaveLength(1);
    });
  });

  describe('releaseLock / releaseWork', () => {
    it('should release lock for the holder', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      await coordinator.releaseWork('task-1', 'agent-A');

      const lockValue = await redis.get('work:task-1:lock');
      expect(lockValue).toBeNull();
    });

    it('should reject release from non-holder', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      await expect(
        coordinator.releaseWork('task-1', 'agent-B')
      ).rejects.toThrow();
    });

    it('should update work status to completed on successful release', async () => {
      const workId = await coordinator.createWork('test task', { type: 'task' });
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      await coordinator.releaseWork(workId, 'agent-A', { result: { done: true } });

      const work = await coordinator.getWork(workId);
      expect(work!.status).toBe('completed');
      expect(work!.completedBy).toBe('agent-A');
    });

    it('should update work status to failed when released with error', async () => {
      const workId = await coordinator.createWork('test task', { type: 'task' });
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      await coordinator.releaseWork(workId, 'agent-A', { error: 'something broke' });

      const work = await coordinator.getWork(workId);
      expect(work!.status).toBe('failed');
      expect(work!.error).toBe('something broke');
    });

    it('should allow re-claim after release', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      await coordinator.releaseWork('task-1', 'agent-A');

      const acquired = await coordinator.claimWork('task-1', 'agent-B', { ttl: 5000 });
      expect(acquired).toBe(true);
    });
  });

  describe('Lock TTL expiry', () => {
    it('should automatically release lock after TTL expires', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      // Advance past TTL
      clock.advance(6000);

      // Lock should be expired
      const lockValue = await redis.get('work:task-1:lock');
      expect(lockValue).toBeNull();
    });

    it('should allow re-acquisition after TTL expiry', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      clock.advance(6000);

      const acquired = await coordinator.claimWork('task-1', 'agent-B', { ttl: 5000 });
      expect(acquired).toBe(true);
    });

    it('should set claimedUntil timestamp on work item', async () => {
      const workId = await coordinator.createWork('test task', { type: 'task' });
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      const work = await coordinator.getWork(workId);
      expect(work!.claimedUntil).toBeDefined();
      expect(work!.claimedUntil).toBe(clock.now + 5000);
    });
  });

  describe('extendLock', () => {
    it('should extend TTL for lock holder', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      const extended = await coordinator.extendLock('task-1', 'agent-A', 10000);
      expect(extended).toBe(true);

      // Should still be locked after original TTL
      clock.advance(6000);
      const lockValue = await redis.get('work:task-1:lock');
      expect(lockValue).toBe('agent-A');
    });

    it('should reject extend from non-holder', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      const extended = await coordinator.extendLock('task-1', 'agent-B', 10000);
      expect(extended).toBe(false);
    });
  });

  describe('createWork', () => {
    it('should create work with generated ID', async () => {
      const workId = await coordinator.createWork('build feature X');
      expect(workId).toBeDefined();
      expect(typeof workId).toBe('string');
      expect(workId.length).toBeGreaterThan(0);
    });

    it('should create work with status available', async () => {
      const workId = await coordinator.createWork('build feature X');
      const work = await coordinator.getWork(workId);

      expect(work).not.toBeNull();
      expect(work!.status).toBe('available');
    });

    it('should store work metadata', async () => {
      const workId = await coordinator.createWork('build feature X', {
        type: 'feature',
        priority: 10,
        tags: ['frontend', 'urgent'],
      });

      const work = await coordinator.getWork(workId);
      expect(work!.type).toBe('feature');
      expect(work!.priority).toBe(10);
      expect(work!.tags).toEqual(['frontend', 'urgent']);
    });
  });

  describe('claimNextWork', () => {
    it('should claim highest priority available work', async () => {
      await coordinator.createWork('low priority', { priority: 1 });
      const highId = await coordinator.createWork('high priority', { priority: 100 });

      const work = await coordinator.claimNextWork('agent-A');
      expect(work).not.toBeNull();
      expect(work!.id).toBe(highId);
    });

    it('should return null when no work available', async () => {
      const work = await coordinator.claimNextWork('agent-A');
      expect(work).toBeNull();
    });
  });

  describe('Redis disconnection', () => {
    it('should handle Redis disconnection gracefully during lock acquisition', async () => {
      redis.disconnect();

      await expect(
        coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 })
      ).rejects.toThrow();
    });

    it('should handle Redis error during lock release', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      redis.setThrowOnNext(new Error('Connection lost'));

      await expect(
        coordinator.releaseWork('task-1', 'agent-A')
      ).rejects.toThrow('Connection lost');
    });

    it('should handle disconnection mid-operation', async () => {
      // Claim work first (this calls redis.set - increments callCount to 1)
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      // Now set disconnect on the very next redis call
      redis.setDisconnectOnCall(redis.commands.length + 1);

      // releaseWork calls redis.get first, which will trigger disconnect
      await expect(
        coordinator.releaseWork('task-1', 'agent-A')
      ).rejects.toThrow();
    });
  });

  describe('cleanupExpiredLocks', () => {
    it('should cleanup expired locks and mark work as available', async () => {
      const workId = await coordinator.createWork('test task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      // Advance past TTL
      clock.advance(6000);

      const cleaned = await coordinator.cleanupExpiredLocks();
      expect(cleaned).toBe(1);

      const work = await coordinator.getWork(workId);
      expect(work!.status).toBe('available');
    });

    it('should not cleanup non-expired locks', async () => {
      const workId = await coordinator.createWork('test task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 10000 });

      clock.advance(3000);

      const cleaned = await coordinator.cleanupExpiredLocks();
      expect(cleaned).toBe(0);
    });
  });

  describe('recoverWorkFromDeadAgent', () => {
    it('should release all work held by dead agent', async () => {
      const w1 = await coordinator.createWork('task 1');
      const w2 = await coordinator.createWork('task 2');

      await coordinator.claimWork(w1, 'dead-agent', { ttl: 60000 });
      await coordinator.claimWork(w2, 'dead-agent', { ttl: 60000 });

      const recovered = await coordinator.recoverWorkFromDeadAgent('dead-agent');
      expect(recovered).toBe(2);

      const work1 = await coordinator.getWork(w1);
      const work2 = await coordinator.getWork(w2);
      expect(work1!.status).toBe('available');
      expect(work2!.status).toBe('available');
    });
  });

  describe('Edge Cases', () => {
    it('should handle acquire lock with empty string key', async () => {
      const acquired = await coordinator.claimWork('', 'agent-A', { ttl: 5000 });
      // Empty key should be rejected
      expect(acquired).toBe(false);
    });

    it('should handle acquire lock with TTL = 0', async () => {
      // TTL of 0 is invalid and should throw
      await expect(
        coordinator.claimWork('task-zero-ttl', 'agent-A', { ttl: 0 })
      ).rejects.toThrow('TTL must be positive');
    });

    it('should handle acquire lock with TTL = -1', async () => {
      // Negative TTL is invalid and should throw
      await expect(
        coordinator.claimWork('task-neg-ttl', 'agent-A', { ttl: -1 })
      ).rejects.toThrow('TTL must be positive');
    });

    it('should handle release lock that was never acquired', async () => {
      // Releasing a lock that never existed should throw
      await expect(
        coordinator.releaseWork('never-acquired-task', 'agent-A')
      ).rejects.toThrow();
    });

    it('should handle release lock that already expired', async () => {
      await coordinator.claimWork('expiring-task', 'agent-A', { ttl: 1000 });
      clock.advance(2000); // Lock expired

      // Releasing an already-expired lock should throw
      await expect(
        coordinator.releaseWork('expiring-task', 'agent-A')
      ).rejects.toThrow();
    });

    it('should handle acquire same lock twice from same holder (idempotent or error)', async () => {
      const workId = await coordinator.createWork('idempotent test', { type: 'task' });
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });
      const secondAcquire = await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      // Should be idempotent (true)
      expect(secondAcquire).toBe(true);
    });

    it('should handle lock key with special characters (slashes, dots, colons)', async () => {
      const specialKeys = ['task/sub/path', 'task.with.dots', 'task:with:colons', 'task//double//slash'];
      for (const key of specialKeys) {
        const acquired = await coordinator.claimWork(key, 'agent-A', { ttl: 5000 });
        expect(acquired).toBe(true);
        await coordinator.releaseWork(key, 'agent-A');
      }
    });

    it('should handle concurrent lock acquisition (two acquires at same millisecond)', async () => {
      // Both happen at the exact same timestamp
      const results = await Promise.all([
        coordinator.claimWork('race-task', 'agent-A', { ttl: 5000 }),
        coordinator.claimWork('race-task', 'agent-B', { ttl: 5000 }),
      ]);

      const winners = results.filter(r => r === true);
      const losers = results.filter(r => r === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
    });

    it('should handle lock with TTL = 1ms (immediately expires)', async () => {
      const acquired = await coordinator.claimWork('instant-expire', 'agent-A', { ttl: 1 });
      expect(acquired).toBe(true);

      clock.advance(2);

      // Should be expired now, another agent should be able to claim
      const acquired2 = await coordinator.claimWork('instant-expire', 'agent-B', { ttl: 5000 });
      expect(acquired2).toBe(true);
    });

    it('should handle extend lock that does not exist', async () => {
      const extended = await coordinator.extendLock('nonexistent-task', 'agent-A', 10000);
      // Extending a non-existent lock should fail
      expect(extended).toBe(false);
    });

    it('should handle 1000 concurrent lock attempts on same key', async () => {
      const promises = Array.from({ length: 1000 }, (_, i) =>
        coordinator.claimWork('hot-task', `agent-${i}`, { ttl: 5000 })
      );

      const results = await Promise.all(promises);
      const winners = results.filter(r => r === true);

      // Exactly one agent should win the lock
      expect(winners).toHaveLength(1);
    });
  });

  describe('Untested Methods', () => {
    it('abandonWork(workId) — marks work as abandoned', async () => {
      const workId = await coordinator.createWork('abandon test', { type: 'task' });
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      await coordinator.abandonWork(workId);

      const work = await coordinator.getWork(workId);
      expect(work!.status).toBe('abandoned');
      expect(work!.assignedTo).toBeUndefined();
    });

    it('getWorkAssignments() — returns all current assignments', async () => {
      const w1 = await coordinator.createWork('task 1');
      const w2 = await coordinator.createWork('task 2');
      await coordinator.claimWork(w1, 'agent-A', { ttl: 5000 });
      await coordinator.claimWork(w2, 'agent-B', { ttl: 5000 });

      const assignments = await coordinator.getWorkAssignments();

      expect(assignments).toHaveLength(2);
      expect(assignments.map((a: any) => a.agentId).sort()).toEqual(['agent-A', 'agent-B']);
    });

    it('getWorkByAgent(agentId) — returns work for specific agent', async () => {
      const w1 = await coordinator.createWork('task for A');
      const w2 = await coordinator.createWork('task for B');
      await coordinator.claimWork(w1, 'agent-A', { ttl: 5000 });
      await coordinator.claimWork(w2, 'agent-B', { ttl: 5000 });

      const agentWork = await coordinator.getWorkByAgent('agent-A');

      expect(agentWork).toHaveLength(1);
      expect(agentWork[0].id).toBe(w1);
    });

    it('findSimilarWork(criteria) — finds matching work items', async () => {
      await coordinator.createWork('build frontend', { type: 'feature', tags: ['frontend'] });
      await coordinator.createWork('build backend', { type: 'feature', tags: ['backend'] });
      await coordinator.createWork('fix bug', { type: 'bugfix', tags: ['frontend'] });

      const similar = await coordinator.findSimilarWork({ tags: ['frontend'] });

      expect(similar).toHaveLength(2);
    });

    it('startCleanup() — begins periodic cleanup timer', async () => {
      await coordinator.startCleanup();

      const w = await coordinator.createWork('stale task');
      await coordinator.claimWork(w, 'dead-agent', { ttl: 1000 });

      // Advance past TTL so lock expires
      clock.advance(2000);

      // Advance past cleanup interval (default 60000ms) to trigger cleanup
      clock.advance(60000);
      // Flush microtasks for the async cleanup callback
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const work = await coordinator.getWork(w);
      expect(work!.status).toBe('available');

      await coordinator.stopCleanup();
    });

    it('stopCleanup() — stops cleanup timer', async () => {
      await coordinator.startCleanup();
      await coordinator.stopCleanup();

      const w = await coordinator.createWork('stale task');
      await coordinator.claimWork(w, 'dead-agent', { ttl: 1000 });
      clock.advance(60000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Cleanup stopped, so expired work should NOT be auto-cleaned
      const work = await coordinator.getWork(w);
      expect(work!.status).toBe('in_progress');
    });

    it('getStats() — returns coordinator statistics', async () => {
      await coordinator.createWork('task 1');
      await coordinator.createWork('task 2');
      const w3 = await coordinator.createWork('task 3');
      await coordinator.claimWork(w3, 'agent-A', { ttl: 5000 });

      const stats = await coordinator.getStats();

      expect(stats).toBeDefined();
      expect(stats.totalWork).toBe(3);
      expect(stats.inProgress).toBe(1);
      expect(stats.available).toBe(2);
    });

    it('initialize() — sets up Redis connections', async () => {
      const freshCoordinator = new WorkCoordinator({ redis });
      await freshCoordinator.initialize();

      // Should be able to create work after initialization
      const workId = await freshCoordinator.createWork('post-init task');
      expect(workId).toBeDefined();
      expect(typeof workId).toBe('string');
    });

    it('shutdown() — graceful teardown', async () => {
      const w = await coordinator.createWork('pre-shutdown task');
      await coordinator.claimWork(w, 'agent-A', { ttl: 5000 });

      await coordinator.shutdown();

      // After shutdown, operations should fail or be rejected
      await expect(
        coordinator.createWork('post-shutdown task')
      ).rejects.toThrow('WorkCoordinator is shut down');
    });
  });
});
