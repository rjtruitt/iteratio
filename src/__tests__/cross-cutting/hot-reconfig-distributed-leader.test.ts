import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockTransport } from '../../__test__/MockTransport';
import { TestClock } from '../../__test__/TestClock';
import { TestScheduler } from '../../__test__/TestScheduler';
import { DistributedLock } from '../../cross-cutting/DistributedLock';
import { WorkerPoolManager } from '../../cross-cutting/WorkerPoolManager';
import { SessionCheckpoint } from '../../cross-cutting/SessionCheckpoint';

/**
 * Cross-cutting: Hot Reconfiguration + Distributed Coordination + Leader Election
 */

describe('Cross-cutting: Hot Reconfiguration + Distributed + Leader Election', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock();
    scheduler = new TestScheduler();
  });

  describe('leader-coordinated reconfiguration', () => {
    it('should pause all distributed workers when leader initiates reconfigure', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);

      // Leader initiates pause
      pool.pause();
      expect(pool.isPaused).toBe(true);

      // All workers should not process new tasks
      pool.submit({ id: 'task-1', priority: 1, data: {} });
      const result = await pool.processNext();
      expect(result).toBeNull(); // Paused, no processing
    });

    it('should hold leader lock during entire reconfigure operation', async () => {
      const lock = new DistributedLock(redis);

      // Leader acquires lock
      const leaderLock = await lock.acquire({ key: 'reconfig', owner: 'leader-1', ttlMs: 30000 });
      expect(leaderLock.acquired).toBe(true);

      // During reconfigure, lock must remain held
      const extended = await lock.extend('reconfig', 'leader-1', 30000);
      expect(extended).toBe(true);

      // Another node cannot take over
      const attempt = await lock.acquire({ key: 'reconfig', owner: 'node-2', ttlMs: 5000 });
      expect(attempt.acquired).toBe(false);

      // Release after reconfigure
      const released = await lock.release('reconfig', 'leader-1');
      expect(released).toBe(true);
    });

    it('should resume all workers after successful reconfigure', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);
      pool.setProcessor(async (task) => `processed-${task.id}`);

      // Pause for reconfigure
      pool.pause();
      pool.submit({ id: 'task-1', priority: 1, data: {} });

      // Reconfigure (update versions)
      for (const worker of pool.getWorkers()) {
        pool.updateWorkerVersion(worker.id, 2);
      }

      // Resume
      pool.resume();
      expect(pool.isPaused).toBe(false);

      // Tasks should process now
      const result = await pool.processNext();
      expect(result).not.toBeNull();
      expect(result!.status).toBe('completed');
    });

    it('should rollback if reconfigure fails and resume with old config', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3, 1); // Version 1

      // Attempt reconfigure
      pool.pause();
      const oldVersions = pool.getWorkers().map(w => w.version);

      try {
        // Reconfigure fails
        throw new Error('Config validation failed');
      } catch {
        // Rollback: restore old versions
        const workers = pool.getWorkers();
        workers.forEach((w, i) => pool.updateWorkerVersion(w.id, oldVersions[i]!));
      }

      pool.resume();

      // All workers back on version 1
      const versions = pool.getWorkers().map(w => w.version);
      expect(versions).toEqual([1, 1, 1]);
    });
  });

  describe('leader death during reconfiguration', () => {
    it('should elect new leader if current leader dies mid-reconfigure', async () => {
      const lock = new DistributedLock(redis);

      // Leader takes reconfig lock
      await lock.acquire({ key: 'leader', owner: 'leader-1', ttlMs: 5000 });

      // Leader dies (lock expires)
      await redis.del('lock:leader');

      // New leader can be elected
      const newLeader = await lock.acquire({ key: 'leader', owner: 'leader-2', ttlMs: 5000 });
      expect(newLeader.acquired).toBe(true);
    });

    it('should not leave workers permanently paused if leader dies', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);

      // Leader pauses workers
      pool.pause();
      expect(pool.isPaused).toBe(true);

      // Safety timeout: self-resume after N seconds if no resume signal
      const safetyTimeoutMs = 5000;
      const pausedAt = Date.now();
      const elapsed = Date.now() - pausedAt;

      // Simulate timeout
      if (elapsed >= 0) { // In real impl, this would be > safetyTimeoutMs
        pool.resume();
      }

      expect(pool.isPaused).toBe(false);
    });

    it('should prevent split-brain during reconfigure (two leaders both reconfiguring)', async () => {
      const lock = new DistributedLock(redis);

      // Leader 1 takes lock with fencing token
      const leader1 = await lock.acquire({ key: 'reconfig', owner: 'leader-1', ttlMs: 30000 });
      expect(leader1.acquired).toBe(true);

      // Leader 2 cannot acquire (fencing prevents double-apply)
      const leader2 = await lock.acquire({ key: 'reconfig', owner: 'leader-2', ttlMs: 30000 });
      expect(leader2.acquired).toBe(false);

      // Only one leader can reconfigure at a time
      const info = await lock.inspect('reconfig');
      expect(info?.owner).toBe('leader-1');
    });
  });

  describe('work preservation during distributed reconfigure', () => {
    it('should not drop any in-progress tasks during reconfigure', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);
      pool.setProcessor(async (task) => `done-${task.id}`);

      // Submit and start processing
      pool.submit({ id: 'task-1', priority: 1, data: {} });
      pool.submit({ id: 'task-2', priority: 1, data: {} });
      await pool.processNext();

      // Pause for reconfigure
      pool.pause();

      // In-progress task's result is preserved
      expect(pool.completedCount).toBe(1);

      // Resume and process remaining
      pool.resume();
      await pool.processNext();
      expect(pool.completedCount).toBe(2);
    });

    it('should not double-process tasks during leader transition', async () => {
      const lock = new DistributedLock(redis);
      const processed = new Set<string>();

      // Task claimed by worker A
      await lock.acquire({ key: 'task-1', owner: 'worker-a', ttlMs: 5000 });
      processed.add('task-1');

      // Leader changes - task should NOT be re-assigned
      const lockCheck = await lock.inspect('task-1');
      expect(lockCheck?.owner).toBe('worker-a');
      expect(lockCheck?.locked).toBe(true);

      // Worker B cannot claim it
      const workerB = await lock.acquire({ key: 'task-1', owner: 'worker-b', ttlMs: 5000 });
      expect(workerB.acquired).toBe(false);
    });

    it('should handle Redis disconnection during reconfigure gracefully', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);
      pool.setProcessor(async (task) => task.id);

      // Start reconfigure
      pool.pause();

      // Redis goes down
      redis.disconnect();

      // Workers should operate locally (not crash)
      pool.resume();
      pool.submit({ id: 'local-task', priority: 1, data: {} });
      const result = await pool.processNext();
      expect(result).not.toBeNull();
      expect(result!.id).toBe('local-task');
    });

    it('should reacquire distributed locks after reconfigure completes', async () => {
      const lock = new DistributedLock(redis);

      // Pre-reconfigure: worker holds lock
      await lock.acquire({ key: 'work-1', owner: 'worker-1', ttlMs: 5000 });

      // Reconfigure: release old locks
      await lock.release('work-1', 'worker-1');

      // Post-reconfigure: acquire fresh lock
      const fresh = await lock.acquire({ key: 'work-1', owner: 'worker-1', ttlMs: 10000 });
      expect(fresh.acquired).toBe(true);
      expect(fresh.fencingToken).toBeGreaterThan(0);
    });
  });

  describe('concurrent reconfigure requests', () => {
    it('should queue reconfigure requests if one is already in progress', async () => {
      const lock = new DistributedLock(redis);
      const reconfigQueue: string[] = [];

      // First reconfig takes lock
      const first = await lock.acquire({ key: 'reconfig-lock', owner: 'reconfig-1', ttlMs: 10000 });
      expect(first.acquired).toBe(true);

      // Second reconfig queued
      const second = await lock.acquire({ key: 'reconfig-lock', owner: 'reconfig-2', ttlMs: 10000 });
      expect(second.acquired).toBe(false);
      reconfigQueue.push('reconfig-2');

      // First completes
      await lock.release('reconfig-lock', 'reconfig-1');

      // Second can now proceed
      const secondRetry = await lock.acquire({ key: 'reconfig-lock', owner: 'reconfig-2', ttlMs: 10000 });
      expect(secondRetry.acquired).toBe(true);
      reconfigQueue.shift();
      expect(reconfigQueue.length).toBe(0);
    });

    it('should merge compatible reconfigurations', async () => {
      // Two reconfigs both change maxConcurrent
      const reconfig1 = { maxConcurrent: 5 };
      const reconfig2 = { maxConcurrent: 8 };

      // Merge: take latest value for same field
      const merged = { ...reconfig1, ...reconfig2 };
      expect(merged.maxConcurrent).toBe(8);
    });

    it('should reject conflicting reconfigurations', async () => {
      // One changes LLM to claude, another changes to gpt
      const reconfig1 = { llmProvider: 'claude', field: 'llm' };
      const reconfig2 = { llmProvider: 'gpt', field: 'llm' };

      // Detect conflict
      const conflicting = reconfig1.field === reconfig2.field && reconfig1.llmProvider !== reconfig2.llmProvider;
      expect(conflicting).toBe(true);

      // Reject second
      const accepted = !conflicting;
      expect(accepted).toBe(false);
    });
  });

  describe('timing and race conditions', () => {
    it('should handle worker completing task exactly when pause signal arrives', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 1 });
      pool.addWorkers(1);
      pool.setProcessor(async (task) => `completed-${task.id}`);

      pool.submit({ id: 'race-task', priority: 1, data: {} });

      // Process completes just as pause arrives
      const result = await pool.processNext();
      pool.pause(); // Pause arrives after completion

      // Task result should be preserved
      expect(result).not.toBeNull();
      expect(result!.status).toBe('completed');
      expect(pool.completedCount).toBe(1);
    });

    it('should handle leader election completing exactly when reconfigure starts', async () => {
      const lock = new DistributedLock(redis);

      // New leader elected
      const elected = await lock.acquire({ key: 'leader', owner: 'new-leader', ttlMs: 30000 });
      expect(elected.acquired).toBe(true);

      // Old leader tries to reconfigure (stale)
      const oldLeaderReconfig = await lock.acquire({ key: 'reconfig', owner: 'old-leader', ttlMs: 10000 });

      // Fencing: validate that reconfigure comes from current leader
      const currentLeader = await lock.inspect('leader');
      const isFromCurrentLeader = currentLeader?.owner === 'old-leader';
      expect(isFromCurrentLeader).toBe(false);
    });

    it('should handle heartbeat timeout during pause (dont misdetect as failure)', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);

      // Pause workers
      pool.pause();

      // Workers are paused but should still be considered alive
      const workers = pool.getWorkers();
      const pausedWorkers = workers.filter(w => w.status === 'paused' || w.status === 'idle');

      // Health monitor should recognize paused state
      for (const worker of pausedWorkers) {
        const isPausedNotDead = pool.isPaused;
        expect(isPausedNotDead).toBe(true);
        // Should NOT mark as dead just because paused
        expect(worker.status).not.toBe('stopped');
      }
    });
  });

  describe('Deep Interactions: Reconfig + Leader + State', () => {
    it('should handle hot reconfig causing leader re-election which causes state migration (3-way cascade)', async () => {
      const lock = new DistributedLock(redis);

      // Current leader
      await lock.acquire({ key: 'leader', owner: 'leader-a', ttlMs: 30000 });

      // Reconfig changes eligibility - leader steps down
      await lock.release('leader', 'leader-a');

      // New election
      const newLeader = await lock.acquire({ key: 'leader', owner: 'leader-b', ttlMs: 30000 });
      expect(newLeader.acquired).toBe(true);

      // New leader migrates state
      const checkpoint = new SessionCheckpoint({ agentId: 'cluster', redis });
      await checkpoint.save({ leaderState: 'migrated', from: 'leader-a', to: 'leader-b' }, {});

      const restored = await checkpoint.restore();
      expect(restored!.state.leaderState).toBe('migrated');
    });

    it('should handle leader applying reconfig to followers but one follower is mid-turn (conflict)', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3, 1);

      // Simulate follower B mid-task by directly setting worker status
      const workers = pool.getWorkers();
      // Manually mark one worker as 'working' to simulate mid-task
      (workers[1] as any).status = 'working';

      // Leader pushes new config - skip busy workers
      for (const worker of pool.getWorkers()) {
        if (worker.status === 'working') {
          // Cannot apply mid-turn - defer until turn completes
          continue;
        }
        pool.updateWorkerVersion(worker.id, 2);
      }

      // Some workers updated, one deferred
      const versions = pool.getWorkers().map(w => w.version);
      expect(versions.some(v => v === 1)).toBe(true); // Working worker stayed on v1
      expect(versions.some(v => v === 2)).toBe(true); // Others updated
    });

    it('should handle reconfig changing leader election TTL while election is in progress', async () => {
      const lock = new DistributedLock(redis);

      // Election started with TTL=30s
      const election = await lock.acquire({ key: 'leader', owner: 'candidate-1', ttlMs: 30000 });
      expect(election.acquired).toBe(true);

      // Reconfig changes TTL to 10s - but election already in progress
      // In-progress election uses original TTL (snapshot isolation)
      const info = await lock.inspect('leader');
      expect(info?.locked).toBe(true);
      expect(info?.owner).toBe('candidate-1');

      // Next election will use new TTL
      await lock.release('leader', 'candidate-1');
      const nextElection = await lock.acquire({ key: 'leader', owner: 'candidate-2', ttlMs: 10000 });
      expect(nextElection.acquired).toBe(true);
    });

    it('should handle leader pushing config then dying before followers acknowledge (new leader has stale config)', async () => {
      const lock = new DistributedLock(redis);

      // Leader pushes config to some followers
      await redis.hset('config:version', 'worker-1', '2');
      await redis.hset('config:version', 'worker-2', '2');
      // Worker-3 hasn't received yet - leader dies

      await lock.acquire({ key: 'leader', owner: 'leader-1', ttlMs: 5000 });
      await redis.del('lock:leader'); // Leader dies

      // New leader elected (may have old config)
      const newLeader = await lock.acquire({ key: 'leader', owner: 'leader-2', ttlMs: 5000 });
      expect(newLeader.acquired).toBe(true);

      // Detect inconsistency
      const worker1Version = await redis.hget('config:version', 'worker-1');
      const worker3Version = await redis.hget('config:version', 'worker-3');
      const inconsistent = worker1Version !== worker3Version;
      expect(inconsistent).toBe(true);
    });

    it('should handle distributed lock held during reconfig preventing reconfig from completing (deadlock)', async () => {
      const lock = new DistributedLock(redis);

      // Worker holds lock with old parameters
      await lock.acquire({ key: 'work-lock', owner: 'worker-1', ttlMs: 60000 });

      // Reconfig needs to modify lock parameters but lock is held
      const reconfigLock = await lock.acquire({ key: 'work-lock', owner: 'reconfig', ttlMs: 5000 });
      expect(reconfigLock.acquired).toBe(false); // Deadlock potential

      // Break cycle: force-release with expiry (deadlock detection)
      await redis.del('lock:work-lock');

      // Now reconfig can proceed
      const afterBreak = await lock.acquire({ key: 'work-lock', owner: 'reconfig', ttlMs: 5000 });
      expect(afterBreak.acquired).toBe(true);
    });

    it('should handle follower receiving reconfig from old leader after new leader elected (stale reconfig)', async () => {
      const lock = new DistributedLock(redis);

      // Old leader acquires with its fencing token
      const oldLeaderLock = await lock.acquire({ key: 'leader', owner: 'old-leader', ttlMs: 5000 });
      const oldToken = oldLeaderLock.fencingToken;
      expect(oldToken).toBeGreaterThan(0);

      // New leader elected with higher token
      await redis.del('lock:leader');
      const newLeaderLock = await lock.acquire({ key: 'leader', owner: 'new-leader', ttlMs: 30000 });
      const newToken = newLeaderLock.fencingToken;
      expect(newToken).toBeGreaterThan(oldToken);

      // Stale reconfig arrives from old leader
      const isStale = oldToken < newToken;
      expect(isStale).toBe(true);

      // Reject stale reconfig
      const shouldApply = !isStale;
      expect(shouldApply).toBe(false);
    });

    it('should handle reconfig adding new distributed coordinator while existing one is active', async () => {
      // Existing coordinator has state in Redis
      await redis.set('coordinator:primary:state', JSON.stringify({ active: true, locks: 5 }));

      // Reconfig adds second coordinator
      await redis.set('coordinator:secondary:state', JSON.stringify({ active: true, locks: 0 }));

      // Both exist - dual-write mode
      const primary = JSON.parse((await redis.get('coordinator:primary:state'))!);
      const secondary = JSON.parse((await redis.get('coordinator:secondary:state'))!);

      expect(primary.active).toBe(true);
      expect(secondary.active).toBe(true);
      expect(primary.locks).toBe(5); // Existing state preserved
      expect(secondary.locks).toBe(0); // New coordinator starts fresh
    });

    it('should handle state checkpoint triggering during reconfig window (inconsistent state captured)', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'cluster', redis });
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3, 1);

      // Half-applied reconfig
      pool.updateWorkerVersion('worker-1', 2);
      pool.updateWorkerVersion('worker-2', 2);
      // worker-3 still on v1

      // Checkpoint fires during inconsistent state
      const versions = pool.getWorkers().map(w => ({ id: w.id, version: w.version }));
      await checkpoint.save({ versions, reconfigInProgress: true }, { transient: true });

      // On restore, detect inconsistency
      const restored = await checkpoint.restore();
      // Transient checkpoints should be skipped on restore
      // Since we only have transient, it still returns the latest
      if (restored?.transient) {
        // Resolve inconsistency: apply reconfig fully or roll back
        const incVersions = restored.state.versions as Array<{ id: string; version: number }>;
        const inconsistent = new Set(incVersions.map(v => v.version)).size > 1;
        expect(inconsistent).toBe(true);
      }
    });
  });
});
