/**
 * Scenario Family 2: Distributed Coordination
 * Tests multi-machine coordination using Redis-based locks, task queues,
 * heartbeats, leader election, split-brain handling, and graceful degradation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockRedis,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockLLMProvider,
  TestAgentFactory,
  TestClock,
  TestScheduler,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { WorkCoordinator } from '../../distributed/WorkCoordinator';
import { AgentRegistry } from '../../distributed/AgentRegistry';
import { AgentMessageBus } from '../../distributed/AgentMessageBus';
import { HealthMonitor } from '../../distributed/HealthMonitor';
import { LeaderElection } from '../../distributed/LeaderElection';
import { DistributedTaskQueue } from '../../distributed/DistributedTaskQueue';

describe('Distributed Coordination - E2E', () => {
  let redis1: MockRedis;
  let redis2: MockRedis;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    // Two separate Redis instances simulating separate machines
    // sharing the same backend (in production they connect to the same Redis)
    redis1 = new MockRedis();
    redis2 = new MockRedis();
    clock = new TestClock();
    clock.install();
    scheduler = new TestScheduler();
  });

  afterEach(() => {
    clock.uninstall();
    redis1.reset();
    redis2.reset();
    scheduler.reset();
  });

  describe('Redis-based locking', () => {
    it('should acquire a distributed lock for a task', async () => {
      const coordinator = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });

      const lock = await coordinator.acquireLock('task-123');
      expect(lock.acquired).toBe(true);
      expect(lock.lockId).toBeDefined();
    });

    it('should prevent a second worker from acquiring the same lock', async () => {
      const coord1 = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'worker-2' });

      await coord1.acquireLock('task-123');
      const lock2 = await coord2.acquireLock('task-123');

      expect(lock2.acquired).toBe(false);
    });

    it('should release lock when work is complete', async () => {
      const coord1 = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'worker-2' });

      const lock = await coord1.acquireLock('task-123');
      await coord1.releaseLock(lock.lockId!);

      const lock2 = await coord2.acquireLock('task-123');
      expect(lock2.acquired).toBe(true);
    });

    it('should expire lock after TTL if worker dies without releasing', async () => {
      const coord1 = new WorkCoordinator({ redis: redis1, namespace: 'worker-1', lockTTL: 5000 });
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'worker-2' });

      await coord1.acquireLock('task-123');
      // Worker 1 "dies" - lock TTL expires
      clock.advance(6000);

      const lock2 = await coord2.acquireLock('task-123');
      expect(lock2.acquired).toBe(true);
    });

    it('should renew lock TTL for long-running tasks', async () => {
      const coord1 = new WorkCoordinator({ redis: redis1, namespace: 'worker-1', lockTTL: 5000 });

      const lock = await coord1.acquireLock('task-123');
      clock.advance(3000);
      await coord1.renewLock(lock.lockId!);
      clock.advance(3000);

      // Lock should still be valid (renewed at 3s, TTL is 5s from renewal)
      const isHeld = await coord1.isLockHeld(lock.lockId!);
      expect(isHeld).toBe(true);
    });
  });

  describe('worker failover', () => {
    it('should detect worker failure via heartbeat timeout', async () => {
      const monitor = new HealthMonitor({ redis: redis1, heartbeatInterval: 1000, timeout: 3000 });

      monitor.registerWorker('worker-1');
      monitor.registerWorker('worker-2');

      // Worker 1 sends heartbeats, worker 2 does not
      monitor.heartbeat('worker-1');
      clock.advance(4000);

      const failed = await monitor.getFailedWorkers();
      expect(failed).toContain('worker-2');
      expect(failed).not.toContain('worker-1');
    });

    it('should reassign failed worker tasks to healthy workers', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });
      const monitor = new HealthMonitor({ redis: redis1, heartbeatInterval: 1000, timeout: 3000 });

      // Worker 1 claims a task then fails
      await queue.enqueue({ id: 'task-1', type: 'analysis' });
      await queue.claim('worker-1', 'task-1');

      // Worker 1 fails
      clock.advance(4000);
      await monitor.processFailures();

      // Task should be back in queue
      const available = await queue.getAvailable();
      expect(available.map(t => t.id)).toContain('task-1');
    });

    it('should not reassign tasks from workers that are still alive', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });
      const monitor = new HealthMonitor({ redis: redis1, heartbeatInterval: 1000, timeout: 3000 });

      await queue.enqueue({ id: 'task-1', type: 'analysis' });
      await queue.claim('worker-1', 'task-1');

      // Worker 1 continues heartbeating
      monitor.heartbeat('worker-1');
      clock.advance(2000);
      monitor.heartbeat('worker-1');

      await monitor.processFailures();
      const available = await queue.getAvailable();
      expect(available.map(t => t.id)).not.toContain('task-1');
    });
  });

  describe('split-brain scenarios', () => {
    it('should detect split-brain when two workers claim the same task', async () => {
      const coord1 = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'worker-2' });

      // Simulate race condition: both try to claim simultaneously
      // One uses a stale Redis connection
      const [result1, result2] = await Promise.all([
        coord1.acquireLock('task-123'),
        coord2.acquireLock('task-123'),
      ]);

      // Exactly one should succeed
      const acquiredCount = [result1.acquired, result2.acquired].filter(Boolean).length;
      expect(acquiredCount).toBe(1);
    });

    it('should resolve split-brain with fencing tokens', async () => {
      const coord1 = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'worker-2' });

      // Worker 1 gets lock with fencing token 1
      const lock1 = await coord1.acquireLock('task-123');
      // Network partition - worker 1 appears dead
      clock.advance(6000);

      // Worker 2 gets lock with fencing token 2 (higher)
      const lock2 = await coord2.acquireLock('task-123');

      // Worker 1 comes back and tries to write (stale token)
      const canWrite = await coord1.validateFencingToken('task-123', lock1.fencingToken!);
      expect(canWrite).toBe(false);

      // Worker 2's token should still be valid
      const canWrite2 = await coord2.validateFencingToken('task-123', lock2.fencingToken!);
      expect(canWrite2).toBe(true);
    });

    it('should emit conflict event when split-brain is detected', async () => {
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });
      const events: string[] = [];
      coord.on('conflict', (data: any) => events.push(data.taskId));

      await coord.acquireLock('task-123');
      // Simulate another worker somehow having the same lock
      await redis1.set('lock:task-123:owner', 'worker-2');

      await coord.verifyLockOwnership('task-123');
      expect(events).toContain('task-123');
    });
  });

  describe('Redis disconnection and reconnection', () => {
    it('should switch to local-only mode when Redis disconnects', async () => {
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });

      redis1.disconnect();

      const mode = coord.getOperatingMode();
      expect(mode).toBe('local-only');
    });

    it('should continue processing work in local-only mode', async () => {
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });
      const queue = new DistributedTaskQueue({ redis: redis1, localFallback: true });

      await queue.enqueue({ id: 'task-1', type: 'analysis' });
      redis1.disconnect();

      // Should still be able to process locally queued work
      const task = await queue.dequeueLocal();
      expect(task).toBeDefined();
      expect(task!.id).toBe('task-1');
    });

    it('should re-sync state when Redis reconnects', async () => {
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });

      // Work while connected
      await coord.acquireLock('task-1');

      // Disconnect, do local work
      redis1.disconnect();
      coord.trackLocalCompletion('task-1');

      // Reconnect - should sync local completions back
      redis1.reconnect();
      await coord.syncAfterReconnect();

      const status = await coord.getTaskStatus('task-1');
      expect(status).toBe('completed');
    });

    it('should queue lock requests during disconnection and replay on reconnect', async () => {
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });

      redis1.disconnect();

      // These should be queued, not thrown
      const pendingLock = coord.acquireLock('task-2');
      redis1.reconnect();
      await coord.processQueuedRequests();

      const result = await pendingLock;
      expect(result.acquired).toBe(true);
    });
  });

  describe('shared task queue', () => {
    it('should distribute tasks across multiple workers fairly', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });

      // Enqueue 10 tasks
      for (let i = 0; i < 10; i++) {
        await queue.enqueue({ id: `task-${i}`, type: 'analysis' });
      }

      // Two workers claim tasks
      const worker1Tasks: string[] = [];
      const worker2Tasks: string[] = [];

      for (let i = 0; i < 10; i++) {
        const task = await queue.dequeue(i % 2 === 0 ? 'worker-1' : 'worker-2');
        if (task) {
          (i % 2 === 0 ? worker1Tasks : worker2Tasks).push(task.id);
        }
      }

      // Both workers should have gotten tasks (no starvation)
      expect(worker1Tasks.length).toBeGreaterThan(0);
      expect(worker2Tasks.length).toBeGreaterThan(0);
      expect(worker1Tasks.length + worker2Tasks.length).toBe(10);
    });

    it('should support task priorities', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });

      await queue.enqueue({ id: 'low', type: 'analysis', priority: 1 });
      await queue.enqueue({ id: 'high', type: 'analysis', priority: 10 });
      await queue.enqueue({ id: 'medium', type: 'analysis', priority: 5 });

      const first = await queue.dequeue('worker-1');
      const second = await queue.dequeue('worker-1');
      const third = await queue.dequeue('worker-1');

      expect(first!.id).toBe('high');
      expect(second!.id).toBe('medium');
      expect(third!.id).toBe('low');
    });

    it('should support task types for routing to specialized workers', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });

      await queue.enqueue({ id: 'code-1', type: 'coding' });
      await queue.enqueue({ id: 'write-1', type: 'writing' });
      await queue.enqueue({ id: 'code-2', type: 'coding' });

      const codingTasks = await queue.dequeueByType('worker-coder', 'coding');
      expect(codingTasks!.type).toBe('coding');
    });

    it('should handle empty queue gracefully', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });

      const task = await queue.dequeue('worker-1');
      expect(task).toBeNull();
    });
  });

  describe('heartbeat and health monitoring', () => {
    it('should broadcast heartbeats at configured interval', async () => {
      const monitor = new HealthMonitor({
        redis: redis1,
        heartbeatInterval: 1000,
        timeout: 3000,
      });

      monitor.start('worker-1');

      clock.advance(3500);
      const heartbeats = monitor.getHeartbeatCount('worker-1');
      expect(heartbeats).toBeGreaterThanOrEqual(3);
    });

    it('should track worker metadata in heartbeats', async () => {
      const monitor = new HealthMonitor({ redis: redis1, heartbeatInterval: 1000, timeout: 3000 });

      monitor.start('worker-1', {
        activeTasks: 3,
        cpuUsage: 0.45,
        memoryMB: 512,
      });

      clock.advance(1500);
      const info = await monitor.getWorkerInfo('worker-1');
      expect(info.activeTasks).toBe(3);
      expect(info.cpuUsage).toBe(0.45);
    });

    it('should emit event when worker health degrades', async () => {
      const monitor = new HealthMonitor({ redis: redis1, heartbeatInterval: 1000, timeout: 3000 });

      const events: any[] = [];
      monitor.on('worker:unhealthy', (data: any) => events.push(data));

      monitor.start('worker-1');
      // Worker stops heartbeating
      clock.advance(4000);

      await monitor.checkHealth();
      expect(events.length).toBe(1);
      expect(events[0].workerId).toBe('worker-1');
    });

    it('should distinguish between slow and dead workers', async () => {
      const monitor = new HealthMonitor({
        redis: redis1,
        heartbeatInterval: 1000,
        timeout: 3000,
        slowThreshold: 2000,
      });

      monitor.start('worker-1');
      monitor.start('worker-2');

      // Worker 1 is slow (heartbeat delayed but still alive)
      clock.advance(2500);
      monitor.heartbeat('worker-1'); // Late but present

      // Worker 2 is dead (no heartbeat at all beyond timeout)
      clock.advance(1000);

      const status = await monitor.getWorkerStatuses();
      expect(status['worker-1']).toBe('slow');
      expect(status['worker-2']).toBe('dead');
    });
  });

  describe('graceful degradation', () => {
    it('should work without coordination when Redis is unavailable from start', async () => {
      redis1.disconnect();

      const coord = new WorkCoordinator({ redis: redis1, namespace: 'solo', gracefulDegradation: true });
      const mode = coord.getOperatingMode();

      expect(mode).toBe('standalone');
      // Should still be able to process work locally
      const result = await coord.processTask({ id: 'task-1', type: 'analysis' });
      expect(result.success).toBe(true);
    });

    it('should log warning when operating without coordination', async () => {
      redis1.disconnect();

      const warnings: string[] = [];
      const coord = new WorkCoordinator({
        redis: redis1,
        namespace: 'solo',
        gracefulDegradation: true,
        logger: { warn: (msg: string) => warnings.push(msg) },
      });

      await coord.processTask({ id: 'task-1', type: 'analysis' });
      expect(warnings.some(w => w.includes('coordination'))).toBe(true);
    });

    it('should attempt periodic reconnection in degraded mode', async () => {
      redis1.disconnect();

      const coord = new WorkCoordinator({
        redis: redis1,
        namespace: 'worker-1',
        gracefulDegradation: true,
        reconnectInterval: 5000,
      });

      clock.advance(5500);
      expect(coord.reconnectAttempts).toBeGreaterThanOrEqual(1);
    });
  });

  describe('leader election', () => {
    it('should elect a single leader among multiple workers', async () => {
      const election1 = new LeaderElection({ redis: redis1, workerId: 'worker-1' });
      const election2 = new LeaderElection({ redis: redis1, workerId: 'worker-2' });
      const election3 = new LeaderElection({ redis: redis1, workerId: 'worker-3' });

      await Promise.all([
        election1.campaign(),
        election2.campaign(),
        election3.campaign(),
      ]);

      const leaders = [
        election1.isLeader(),
        election2.isLeader(),
        election3.isLeader(),
      ].filter(Boolean);

      expect(leaders.length).toBe(1);
    });

    it('should elect new leader when current leader fails', async () => {
      const election1 = new LeaderElection({ redis: redis1, workerId: 'worker-1', leaseTTL: 5000 });
      const election2 = new LeaderElection({ redis: redis1, workerId: 'worker-2', leaseTTL: 5000 });

      await election1.campaign();
      await election2.campaign();

      expect(election1.isLeader()).toBe(true);

      // Leader dies (lease expires)
      clock.advance(6000);
      await election2.campaign();

      expect(election2.isLeader()).toBe(true);
    });

    it('should notify followers when leader changes', async () => {
      const election1 = new LeaderElection({ redis: redis1, workerId: 'worker-1', leaseTTL: 5000 });
      const election2 = new LeaderElection({ redis: redis1, workerId: 'worker-2', leaseTTL: 5000 });

      const events: string[] = [];
      election2.on('leader:changed', (data: any) => events.push(data.newLeader));

      await election1.campaign();
      await election2.campaign();

      // Leader 1 dies
      clock.advance(6000);
      await election2.campaign();

      expect(events).toContain('worker-2');
    });

    it('should leader coordinate task assignment', async () => {
      const election = new LeaderElection({ redis: redis1, workerId: 'worker-1' });
      const queue = new DistributedTaskQueue({ redis: redis1 });

      await election.campaign();
      expect(election.isLeader()).toBe(true);

      // Only the leader should perform assignment
      await queue.enqueue({ id: 'task-1', type: 'analysis' });
      const assignment = await election.assignAsLeader('task-1', 'worker-2');

      expect(assignment.success).toBe(true);
      expect(assignment.assignedTo).toBe('worker-2');
    });
  });

  describe('Edge Cases', () => {
    it('should handle all workers failing simultaneously', async () => {
      const monitor = new HealthMonitor({ redis: redis1, heartbeatInterval: 1000, timeout: 3000 });
      const queue = new DistributedTaskQueue({ redis: redis1 });

      // Register 5 workers, assign tasks to each
      for (let i = 0; i < 5; i++) {
        monitor.registerWorker(`worker-${i}`);
        await queue.enqueue({ id: `task-${i}`, type: 'analysis' });
        await queue.claim(`worker-${i}`, `task-${i}`);
      }

      // All workers die at the same time (no heartbeats)
      clock.advance(4000);
      await monitor.processFailures();

      // All tasks should be re-queued
      const available = await queue.getAvailable();
      expect(available.length).toBe(5);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle task queue draining to 0 then immediately receiving 1000 tasks', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });

      // Queue starts empty
      expect(await queue.getAvailable()).toHaveLength(0);

      // Burst of 1000 tasks arrives simultaneously
      const enqueuePromises = Array.from({ length: 1000 }, (_, i) =>
        queue.enqueue({ id: `burst-${i}`, type: 'analysis', priority: Math.random() * 10 })
      );
      await Promise.all(enqueuePromises);

      const available = await queue.getAvailable();
      expect(available.length).toBe(1000);
      // Should maintain priority ordering despite burst
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle Redis latency spike (responses take 5s instead of 5ms)', async () => {
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'worker-1', lockTTL: 5000 });

      // Simulate Redis latency spike
      redis1.setLatency(5000);

      const lockPromise = coord.acquireLock('task-slow');
      clock.advance(5500);

      // Should either succeed after delay or timeout gracefully (not crash)
      const result = await lockPromise;
      expect(result).toBeDefined();
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle worker joining cluster with stale version number', async () => {
      const registry = new AgentRegistry({ redis: redis1 });

      // Current cluster is at version 5
      await registry.setClusterVersion(5);

      // Worker joins with stale version 2
      const joinResult = await registry.registerWorker('stale-worker', { version: 2 });

      // Should reject or force-update the worker
      expect(joinResult.accepted).toBe(false);
      expect(joinResult.reason).toContain('version');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle split-brain resolving while tasks are in-flight', async () => {
      const coord1 = new WorkCoordinator({ redis: redis1, namespace: 'worker-1' });
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'worker-2' });

      // Both workers think they own the same task (split-brain)
      const lock1 = await coord1.acquireLock('task-conflict');
      clock.advance(6000); // Lock expires
      const lock2 = await coord2.acquireLock('task-conflict');

      // Worker 1 is still processing (doesn't know lock expired)
      // Split-brain resolves: worker 2 is canonical owner
      await coord1.verifyLockOwnership('task-conflict');

      // Worker 1 should abort its in-flight work
      expect(coord1.isLockHeld(lock1.lockId!)).resolves.toBe(false);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle heartbeat arriving exactly at timeout boundary', async () => {
      const monitor = new HealthMonitor({
        redis: redis1,
        heartbeatInterval: 1000,
        timeout: 3000,
      });

      monitor.registerWorker('edge-worker');
      monitor.start('edge-worker');

      // Heartbeat arrives at exactly 3000ms (the timeout boundary)
      clock.advance(3000);
      monitor.heartbeat('edge-worker');

      await monitor.checkHealth();
      const status = await monitor.getWorkerStatuses();

      // Should the worker be considered alive or dead at exactly the boundary?
      expect(status['edge-worker']).not.toBe('dead');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle lock holder dying during lock extension', async () => {
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'worker-1', lockTTL: 5000 });

      const lock = await coord.acquireLock('task-extend');

      // Worker starts renewing but crashes mid-renewal (network partition)
      redis1.simulatePartialWrite(); // Write starts but doesn't complete

      await expect(coord.renewLock(lock.lockId!)).rejects.toThrow();

      // Lock should eventually expire and become available
      clock.advance(6000);
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'worker-2' });
      const newLock = await coord2.acquireLock('task-extend');
      expect(newLock.acquired).toBe(true);
      expect(true).toBe(false); // RED: not implemented
    });
  });

  describe('Adversarial: Coordination Attacks', () => {
    it('should handle worker that claims task then never processes it (task hostage)', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });
      const monitor = new HealthMonitor({ redis: redis1, heartbeatInterval: 1000, timeout: 3000 });

      await queue.enqueue({ id: 'hostage-task', type: 'analysis', priority: 10 });
      await queue.claim('hostile-worker', 'hostage-task');

      // Worker keeps sending heartbeats (so it's not "dead") but never processes the task
      monitor.registerWorker('hostile-worker');
      for (let i = 0; i < 10; i++) {
        clock.advance(1000);
        monitor.heartbeat('hostile-worker');
      }

      // FAILS: task should be reclaimed after a processing timeout, not just heartbeat timeout
      const taskStatus = await queue.getTaskStatus?.('hostage-task');
      expect(taskStatus).toBe('available'); // Should be reclaimed
      expect(true).toBe(false); // RED: not implemented
    });

    it('should detect worker reporting fake progress to avoid timeout', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'liar-worker', lockTTL: 5000 });

      await queue.enqueue({ id: 'fake-progress-task', type: 'analysis' });
      await queue.claim('liar-worker', 'fake-progress-task');

      // Worker reports progress without actually advancing
      for (let i = 0; i < 20; i++) {
        clock.advance(4000);
        await coord.reportProgress?.('fake-progress-task', { percent: 50 }); // Always 50%
        await coord.renewLock?.((await coord.acquireLock('fake-progress-task')).lockId!);
      }

      // FAILS: should detect stalled progress and reclaim task
      const stalled = await coord.getStalledTasks?.();
      expect(stalled).toContain('fake-progress-task');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should prevent worker from stealing task from another workers claimed set', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });
      const coord1 = new WorkCoordinator({ redis: redis1, namespace: 'victim-worker' });
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'thief-worker' });

      await queue.enqueue({ id: 'stolen-task', type: 'analysis' });
      await queue.claim('victim-worker', 'stolen-task');

      // Thief attempts to claim an already-claimed task
      const stealResult = await queue.claim('thief-worker', 'stolen-task');

      // FAILS: claiming an already-claimed task should be rejected
      expect(stealResult).toBe(false);

      // Verify original owner still holds it
      const taskInfo = await queue.getTaskInfo?.('stolen-task');
      expect(taskInfo?.claimedBy).toBe('victim-worker');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle coordinated attack: multiple workers claim then drop (DDoS)', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });
      const monitor = new HealthMonitor({ redis: redis1, heartbeatInterval: 1000, timeout: 3000 });

      // Enqueue important tasks
      for (let i = 0; i < 10; i++) {
        await queue.enqueue({ id: `important-${i}`, type: 'critical', priority: 10 });
      }

      // Multiple malicious workers claim and immediately abandon
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 10; i++) {
          const workerId = `attacker-${round}-${i}`;
          await queue.claim(workerId, `important-${i}`);
          // Immediately "crash" without releasing
          clock.advance(4000);
        }
        await monitor.processFailures();
      }

      // FAILS: after repeated claim-and-drop, tasks should still be available
      // and system should rate-limit or blacklist abusive workers
      const available = await queue.getAvailable();
      expect(available.length).toBe(10);
      const blacklisted = await queue.getBlacklistedWorkers?.();
      expect(blacklisted?.length).toBeGreaterThan(0);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should reject worker sending completion for task it does not hold', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'legit-worker' });

      await queue.enqueue({ id: 'owned-task', type: 'analysis' });
      await queue.claim('legit-worker', 'owned-task');

      // Imposter tries to report completion for a task it doesn't own
      const imposterCoord = new WorkCoordinator({ redis: redis1, namespace: 'imposter-worker' });

      // FAILS: completion from non-owner should be rejected
      await expect(
        imposterCoord.completeWork?.('owned-task', { result: 'fake' })
      ).rejects.toThrow();

      // Task should still be in-progress with original owner
      const status = await queue.getTaskStatus?.('owned-task');
      expect(status).toBe('in_progress');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should prevent clock manipulation allowing worker to extend expired claim', async () => {
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'manipulator', lockTTL: 5000 });
      const queue = new DistributedTaskQueue({ redis: redis1 });

      await queue.enqueue({ id: 'manipulated-task', type: 'analysis' });
      const lock = await coord.acquireLock('manipulated-task');

      // Lock expires
      clock.advance(6000);

      // Another worker claims
      const coord2 = new WorkCoordinator({ redis: redis1, namespace: 'honest-worker' });
      await coord2.acquireLock('manipulated-task');

      // Original worker attempts to extend its expired lock (clock manipulation)
      const extendResult = await coord.renewLock?.(lock.lockId!);

      // FAILS: extending an expired/re-acquired lock should be rejected
      expect(extendResult).toBe(false);

      // Honest worker should still hold the lock
      const currentHolder = await redis1.get('lock:manipulated-task:owner');
      expect(currentHolder).toBe('honest-worker');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle worker death exactly at task completion boundary (result lost)', async () => {
      const queue = new DistributedTaskQueue({ redis: redis1 });
      const coord = new WorkCoordinator({ redis: redis1, namespace: 'dying-worker', lockTTL: 5000 });

      await queue.enqueue({ id: 'boundary-task', type: 'analysis' });
      await queue.claim('dying-worker', 'boundary-task');

      // Worker completes the task computation but crashes before writing result
      redis1.setDisconnectOnCall(redis1.commands.length + 1);

      try {
        await coord.completeWork?.('boundary-task', { result: 'computed but lost' });
      } catch {
        // Worker died before result persisted
      }

      redis1.reconnect();

      // FAILS: task whose result was lost should be re-queued, not marked as complete
      const status = await queue.getTaskStatus?.('boundary-task');
      expect(status).toBe('available'); // Re-queued for retry
      expect(true).toBe(false); // RED: not implemented
    });
  });
});
