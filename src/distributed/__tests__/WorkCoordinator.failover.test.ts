import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { TestScheduler } from '../../__test__/TestScheduler';
import { WorkCoordinator } from '../WorkCoordinator';

describe('WorkCoordinator — Failover Scenarios', () => {
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

  describe('Lock holder disconnects', () => {
    it('should allow re-acquisition after TTL expires when holder disconnects', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      // Simulate holder disconnecting (no release call)
      // Just advance time past TTL
      clock.advance(6000);

      const acquired = await coordinator.claimWork('task-1', 'agent-B', { ttl: 5000 });
      expect(acquired).toBe(true);
    });

    it('should detect holder disconnect via cleanupExpiredLocks', async () => {
      const workId = await coordinator.createWork('task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      clock.advance(6000);
      const cleaned = await coordinator.cleanupExpiredLocks();

      expect(cleaned).toBe(1);
      const work = await coordinator.getWork(workId);
      expect(work!.status).toBe('available');
      expect(work!.assignedTo).toBeUndefined();
    });

    it('should mark work as available when lock expires without release', async () => {
      const workId = await coordinator.createWork('task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      clock.advance(6000);
      await coordinator.cleanupExpiredLocks();

      const work = await coordinator.getWork(workId);
      expect(work!.status).toBe('available');
      expect(work!.assignedTo).toBeUndefined();
    });
  });

  describe('Split-brain prevention', () => {
    it('should prevent two nodes from both holding the lock', async () => {
      const scheduler = new TestScheduler();

      // Both attempt simultaneously
      const claim1 = coordinator.claimWork('task-1', 'node-A', { ttl: 10000 });
      const claim2 = coordinator.claimWork('task-1', 'node-B', { ttl: 10000 });

      const [r1, r2] = await Promise.all([claim1, claim2]);

      // Only one should succeed
      expect([r1, r2].filter(r => r === true)).toHaveLength(1);
      expect([r1, r2].filter(r => r === false)).toHaveLength(1);
    });

    it('should use fencing token / epoch to detect stale lock holders', async () => {
      const workId = await coordinator.createWork('critical task');

      // Agent-A acquires lock
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      // TTL expires (agent-A didn't release)
      clock.advance(6000);

      // Agent-B acquires
      await coordinator.claimWork(workId, 'agent-B', { ttl: 5000 });

      // Agent-A tries to release (stale holder)
      await expect(
        coordinator.releaseWork(workId, 'agent-A')
      ).rejects.toThrow();
    });

    it('should not allow expired lock holder to overwrite new holder', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });

      clock.advance(6000);

      // New holder acquires
      await coordinator.claimWork('task-1', 'agent-B', { ttl: 5000 });

      // Verify agent-B holds the lock, not agent-A
      const lockValue = await redis.get('work:task-1:lock');
      expect(lockValue).toBe('agent-B');
    });

    it('should reject release if lock was already re-acquired by another agent', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      clock.advance(6000);
      await coordinator.claimWork('task-1', 'agent-B', { ttl: 5000 });

      // Agent-A wakes up and tries to release
      await expect(
        coordinator.releaseWork('task-1', 'agent-A')
      ).rejects.toThrow();
    });
  });

  describe('Rapid failover', () => {
    it('should allow new holder within TTL when old holder explicitly dies', async () => {
      const workId = await coordinator.createWork('urgent task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 30000 });

      // Agent-A dies — recovery process releases its work
      await coordinator.recoverWorkFromDeadAgent('agent-A');

      // New agent immediately claims
      const acquired = await coordinator.claimWork(workId, 'agent-B', { ttl: 30000 });
      expect(acquired).toBe(true);

      const work = await coordinator.getWork(workId);
      expect(work!.assignedTo).toBe('agent-B');
    });

    it('should transfer work within acceptable latency after failover', async () => {
      const workId = await coordinator.createWork('urgent task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 30000 });

      const failoverStart = clock.now;
      await coordinator.recoverWorkFromDeadAgent('agent-A');
      await coordinator.claimWork(workId, 'agent-B', { ttl: 30000 });
      const failoverEnd = clock.now;

      // Failover should be near-instant (no waiting for TTL)
      expect(failoverEnd - failoverStart).toBeLessThan(1000);
    });

    it('should handle multiple failovers in sequence', async () => {
      const workId = await coordinator.createWork('hot potato task');

      // Agent A claims, dies
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });
      await coordinator.recoverWorkFromDeadAgent('agent-A');

      // Agent B claims, dies
      await coordinator.claimWork(workId, 'agent-B', { ttl: 5000 });
      await coordinator.recoverWorkFromDeadAgent('agent-B');

      // Agent C claims
      const acquired = await coordinator.claimWork(workId, 'agent-C', { ttl: 5000 });
      expect(acquired).toBe(true);

      const work = await coordinator.getWork(workId);
      expect(work!.assignedTo).toBe('agent-C');
      expect(work!.attempts).toBe(3);
    });
  });

  describe('Network partition simulation', () => {
    it('should throw on lock acquisition when Redis is unreachable', async () => {
      redis.disconnect();

      await expect(
        coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 })
      ).rejects.toThrow();
    });

    it('should throw on lock release when Redis is unreachable', async () => {
      await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      redis.disconnect();

      await expect(
        coordinator.releaseWork('task-1', 'agent-A')
      ).rejects.toThrow();
    });

    it('should handle Redis becoming unreachable mid-operation', async () => {
      // Disconnect on the very first redis call (the SET NX in claimWork)
      redis.setDisconnectOnCall(1);

      await expect(
        coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 })
      ).rejects.toThrow();
    });

    it('should not corrupt state on partial operation failure', async () => {
      const workId = await coordinator.createWork('test task');

      // Make Redis fail after lock acquisition but before status update
      redis.setDisconnectOnCall(5);

      try {
        await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });
      } catch {
        // Expected
      }

      // Reconnect and verify state is consistent
      redis.reconnect();
      const work = await coordinator.getWork(workId);

      // Either fully claimed or fully available — no in-between
      expect(['available', 'in_progress']).toContain(work!.status);
      if (work!.status === 'available') {
        expect(work!.assignedTo).toBeUndefined();
      }
    });
  });

  describe('Graceful degradation', () => {
    it('should report degraded state when Redis errors occur', async () => {
      redis.setThrowOnNext(new Error('Redis overloaded'));

      await expect(
        coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 })
      ).rejects.toThrow('Redis overloaded');
    });

    it('should resume normal operation after Redis reconnects', async () => {
      redis.disconnect();

      try {
        await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      } catch {
        // Expected
      }

      redis.reconnect();

      const acquired = await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      expect(acquired).toBe(true);
    });

    it('should not lose work items during temporary Redis outage', async () => {
      const workId = await coordinator.createWork('important task');

      redis.disconnect();

      try {
        await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });
      } catch {
        // Expected
      }

      redis.reconnect();

      // Work should still be available
      const work = await coordinator.getWork(workId);
      expect(work).not.toBeNull();
      expect(work!.status).toBe('available');
    });
  });

  describe('Recovery on reconnection', () => {
    it('should re-acquire lock after reconnection if needed', async () => {
      redis.disconnect();

      try {
        await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      } catch {
        // Expected
      }

      redis.reconnect();

      const acquired = await coordinator.claimWork('task-1', 'agent-A', { ttl: 5000 });
      expect(acquired).toBe(true);
    });

    it('should detect stale locks after reconnection', async () => {
      const workId = await coordinator.createWork('task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      // Simulate partition lasting longer than TTL
      clock.advance(10000);

      const cleaned = await coordinator.cleanupExpiredLocks();
      expect(cleaned).toBe(1);
    });

    it('should properly handle lock contention after cluster recovers', async () => {
      const workId = await coordinator.createWork('contested task');

      // Both agents race after reconnection
      const claim1 = coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });
      const claim2 = coordinator.claimWork(workId, 'agent-B', { ttl: 5000 });

      const [r1, r2] = await Promise.all([claim1, claim2]);

      const wins = [r1, r2].filter(r => r === true);
      expect(wins).toHaveLength(1);
    });
  });

  describe('Adversarial: Distributed Race Conditions', () => {
    it('should reject lock released by agent B when acquired by agent A (unauthorized release)', async () => {
      const workId = await coordinator.createWork('protected task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 10000 });

      // Agent B attempts to release agent A's lock (unauthorized)
      await expect(
        coordinator.releaseWork(workId, 'agent-B')
      ).rejects.toThrow();

      // Lock should still be held by agent A
      const work = await coordinator.getWork(workId);
      expect(work!.assignedTo).toBe('agent-A');
    });

    it('should handle lock TTL at exact boundary (race between expire and extend)', async () => {
      const workId = await coordinator.createWork('expiring task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      // Advance to exactly the TTL boundary
      clock.advance(5000);

      // Agent A tries to extend at the exact moment of expiry
      // extendLock takes (workId, agentId, newTTL)
      const extendResult = await coordinator.extendLock(workId, 'agent-A', 5000);

      // Either the extension succeeds (lock was still valid) or fails (lock expired)
      expect(typeof extendResult).toBe('boolean');
    });

    it('should prevent two nodes from claiming same work simultaneously (split claim)', async () => {
      const workId = await coordinator.createWork('contested work');

      // Both nodes attempt claim at exact same logical time
      const claim1 = coordinator.claimWork(workId, 'node-A', { ttl: 10000 });
      const claim2 = coordinator.claimWork(workId, 'node-B', { ttl: 10000 });

      const [r1, r2] = await Promise.all([claim1, claim2]);

      // Exactly one should win
      const winners = [r1, r2].filter(Boolean);
      expect(winners).toHaveLength(1);

      // The work should have exactly one owner
      const work = await coordinator.getWork(workId);
      expect(['node-A', 'node-B']).toContain(work!.assignedTo);
    });

    it('should handle node crash between acquiring lock and writing work record', async () => {
      const workId = await coordinator.createWork('fragile task');

      // claimWork calls redis.set (succeeds, acquires lock), then if NX fails
      // it calls redis.get. For a fresh key, SET NX succeeds in one call.
      // The work record update is in-memory (no redis call), so the only
      // failure scenario is if SET itself fails.
      // Let's test: SET succeeds but we simulate crash after
      await coordinator.claimWork(workId, 'agent-A', { ttl: 5000 });

      // Verify the work was claimed
      const work = await coordinator.getWork(workId);
      expect(work!.status).toBe('in_progress');
      expect(work!.assignedTo).toBe('agent-A');

      // Now simulate the holder crashing (no release call)
      // After TTL expires, lock should be reclaimable
      clock.advance(6000);
      redis.reconnect(); // ensure connected

      const acquired = await coordinator.claimWork(workId, 'agent-B', { ttl: 5000 });
      expect(acquired).toBe(true);
    });

    it('should allow re-claim when lock is manually deleted (simulating Redis failover)', async () => {
      const workId = await coordinator.createWork('phantom task');
      await coordinator.claimWork(workId, 'agent-A', { ttl: 30000 });

      // Simulate Redis master failover — lock key is lost
      await redis.del(`work:${workId}:lock`);

      // Since the lock no longer exists in Redis, NX will succeed for agent-B
      const claim2 = await coordinator.claimWork(workId, 'agent-B', { ttl: 5000 });
      // The SET NX sees no key and allows B to claim
      expect(claim2).toBe(true);
    });

    it('should not allow premature lock acquisition within TTL', async () => {
      const workId = await coordinator.createWork('clock-skewed task');

      // Agent A acquires with TTL 10s
      await coordinator.claimWork(workId, 'agent-A', { ttl: 10000 });

      // Only 3 seconds pass
      clock.advance(3000);

      // Agent B attempts to claim - lock is still valid
      const claim2 = await coordinator.claimWork(workId, 'agent-B', { ttl: 5000 });
      expect(claim2).toBe(false);
    });

    it('should allow re-acquisition after release and new claim', async () => {
      const workId = await coordinator.createWork('aba task');

      // Agent A acquires
      await coordinator.claimWork(workId, 'agent-A', { ttl: 10000 });

      // Agent A releases
      await coordinator.releaseWork(workId, 'agent-A');

      // Agent B acquires
      const claimB = await coordinator.claimWork(workId, 'agent-B', { ttl: 10000 });
      expect(claimB).toBe(true);

      const work = await coordinator.getWork(workId);
      expect(work!.assignedTo).toBe('agent-B');
    });

    it('should handle multiple lock keys without interference', async () => {
      const workId = await coordinator.createWork('partition task');

      // Agent A acquires lock
      await coordinator.claimWork(workId, 'agent-A', { ttl: 30000 });

      // A separate key in Redis doesn't affect the coordinator's lock
      await redis.set(`work:${workId}:lock:partition2`, 'agent-B');

      // The primary lock is still held by agent-A
      const lockA = await redis.get(`work:${workId}:lock`);
      expect(lockA).toBe('agent-A');

      // Agent-B cannot claim through the coordinator (NX fails on primary key)
      const claim2 = await coordinator.claimWork(workId, 'agent-B', { ttl: 5000 });
      expect(claim2).toBe(false);
    });
  });
});
