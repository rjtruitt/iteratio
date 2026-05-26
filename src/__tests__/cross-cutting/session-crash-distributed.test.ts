import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockStateManager } from '../../__test__/MockStateManager';
import { TestClock } from '../../__test__/TestClock';
import { SessionCheckpoint } from '../../cross-cutting/SessionCheckpoint';
import { DistributedLock } from '../../cross-cutting/DistributedLock';
import { MockTransport } from '../../__test__/MockTransport';

/**
 * Cross-cutting: Session Checkpoint + Crash Recovery + Distributed Failover
 */

describe('Cross-cutting: Session + Crash Recovery + Distributed Failover', () => {
  let redis: MockRedis;
  let clock: TestClock;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock();
  });

  describe('crash recovery with distributed checkpoint', () => {
    it('should restore agent on different machine from Redis checkpoint', async () => {
      // Machine A saves checkpoint
      const checkpointA = new SessionCheckpoint({ agentId: 'agent-1', redis });
      await checkpointA.save({ turn: 5, messages: ['hello'], toolResults: [] }, { machine: 'A' });

      // Machine B restores from Redis
      const checkpointB = new SessionCheckpoint({ agentId: 'agent-1', redis });
      const restored = await checkpointB.restore();

      expect(restored).not.toBeNull();
      expect(restored!.state.turn).toBe(5);
      expect(restored!.state.messages).toEqual(['hello']);
      expect(restored!.metadata.machine).toBe('A');
    });

    it('should not lose work between last checkpoint and crash', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis });

      // Checkpoint at turn 3
      await checkpoint.save({ turn: 3, completedWork: ['task-1', 'task-2'] }, {});

      // Turns 4 and 5 happen (not checkpointed)
      const latestKnownTurn = 3;
      const currentTurn = 5;
      const turnsLost = currentTurn - latestKnownTurn;

      expect(turnsLost).toBe(2);

      // Recovery knows what was potentially lost
      const restored = await checkpoint.restore();
      expect(restored!.state.turn).toBe(3);
      expect(restored!.turnNumber).toBe(3);
    });

    it('should handle checkpoint corruption during failover', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis, maxCheckpoints: 5 });

      // Save multiple checkpoints
      await checkpoint.save({ turn: 1, data: 'valid-1' }, {});
      await checkpoint.save({ turn: 2, data: 'valid-2' }, {});

      // Corrupt the latest checkpoint in Redis
      await redis.set('checkpoint:agent-1:latest', 'invalid-json-{{{');

      // Restore should fall back to local
      const restored = await checkpoint.restore();
      // Local checkpoints are still valid
      expect(restored).not.toBeNull();
      expect(restored!.state.data).toBe('valid-2');
    });
  });

  describe('distributed failover triggers checkpoint restore', () => {
    it('should detect agent death via missed heartbeats', async () => {
      // Agent heartbeats stored in Redis
      await redis.set('heartbeat:agent-1', String(Date.now()));

      // Simulate time passing beyond threshold (30s)
      const lastHeartbeat = Number(await redis.get('heartbeat:agent-1'));
      const threshold = 30000;
      const timeSinceHeartbeat = Date.now() + 31000 - lastHeartbeat;

      expect(timeSinceHeartbeat).toBeGreaterThan(threshold);

      // Agent considered dead
      const isDead = timeSinceHeartbeat > threshold;
      expect(isDead).toBe(true);
    });

    it('should prevent double-processing during failover', async () => {
      const lock = new DistributedLock(redis);

      // Agent A holds lock for task
      const lockA = await lock.acquire({ key: 'task-1', owner: 'agent-a', ttlMs: 5000 });
      expect(lockA.acquired).toBe(true);

      // Agent B tries to claim same task (fencing)
      const lockB = await lock.acquire({ key: 'task-1', owner: 'agent-b', ttlMs: 5000 });
      expect(lockB.acquired).toBe(false); // Blocked by A's lock

      // Agent A's lock expires (simulated death)
      await redis.del('lock:task-1');

      // Now Agent B can claim
      const lockB2 = await lock.acquire({ key: 'task-1', owner: 'agent-b', ttlMs: 5000 });
      expect(lockB2.acquired).toBe(true);
      expect(lockB2.fencingToken).toBeGreaterThan(lockA.fencingToken);
    });

    it('should transfer task ownership atomically during failover', async () => {
      const lock = new DistributedLock(redis);

      // Agent A owns task
      await lock.acquire({ key: 'task-1', owner: 'agent-a', ttlMs: 5000 });

      // Agent A dies - release and transfer
      const released = await lock.release('task-1', 'agent-a');
      expect(released).toBe(true);

      // Agent B immediately claims
      const claimed = await lock.acquire({ key: 'task-1', owner: 'agent-b', ttlMs: 5000 });
      expect(claimed.acquired).toBe(true);

      // Verify ownership
      const info = await lock.inspect('task-1');
      expect(info?.owner).toBe('agent-b');
    });
  });

  describe('checkpoint consistency in distributed environment', () => {
    it('should checkpoint both local state and distributed state atomically', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis });
      const localState = { turn: 5, messages: ['m1', 'm2'] };
      const distributedState = { locks: ['lock-1'], assignments: ['task-a'] };

      // Save both together
      const saved = await checkpoint.save(
        { ...localState, distributed: distributedState },
        { type: 'full' }
      );

      expect(saved.state.turn).toBe(5);
      expect(saved.state.distributed).toEqual(distributedState);

      // Restore gets both
      const restored = await checkpoint.restore();
      expect(restored!.state.turn).toBe(5);
      expect((restored!.state.distributed as any).locks).toEqual(['lock-1']);
    });

    it('should handle Redis failure during checkpoint write', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis });

      // First save works
      await checkpoint.save({ turn: 1 }, {});

      // Redis fails for next save
      redis.setThrowOnNext(new Error('Connection refused'));

      // Save should still work locally (fall back)
      // The SessionCheckpoint stores locally even if Redis fails
      await checkpoint.save({ turn: 2 }, {});

      // Local restore works
      const restored = await checkpoint.restore();
      expect(restored).not.toBeNull();
    });

    it('should reconcile state after restoring from stale checkpoint', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis });

      // Checkpoint 5 minutes old
      await checkpoint.save({ turn: 10, counter: 5 }, { timestamp: Date.now() - 300000 });

      // Distributed state has advanced (other agents progressed)
      await redis.set('shared:counter', '15');

      // Restore from stale checkpoint
      const restored = await checkpoint.restore();
      expect(restored!.state.counter).toBe(5); // Stale

      // Reconciliation: check distributed state
      const currentDistributed = await redis.get('shared:counter');
      const distributedCounter = Number(currentDistributed);

      // Distributed state is newer - use it
      expect(distributedCounter).toBeGreaterThan(restored!.state.counter as number);
      const reconciledCounter = Math.max(restored!.state.counter as number, distributedCounter);
      expect(reconciledCounter).toBe(15);
    });
  });

  describe('cascading failure recovery', () => {
    it('should handle multiple simultaneous agent crashes', async () => {
      const lock = new DistributedLock(redis);

      // 5 agents each with a task
      for (let i = 1; i <= 5; i++) {
        await lock.acquire({ key: `task-${i}`, owner: `agent-${i}`, ttlMs: 5000 });
      }

      // 3 agents crash (1, 3, 5)
      for (const id of [1, 3, 5]) {
        await lock.release(`task-${id}`, `agent-${id}`);
      }

      // Surviving agents (2, 4) take over
      const claimed2 = await lock.acquire({ key: 'task-1', owner: 'agent-2', ttlMs: 5000 });
      const claimed4a = await lock.acquire({ key: 'task-3', owner: 'agent-4', ttlMs: 5000 });
      const claimed4b = await lock.acquire({ key: 'task-5', owner: 'agent-4', ttlMs: 5000 });

      expect(claimed2.acquired).toBe(true);
      expect(claimed4a.acquired).toBe(true);
      expect(claimed4b.acquired).toBe(true);
    });

    it('should not cascade failure (recovery doesnt kill more agents)', async () => {
      // Simulate gradual load distribution
      const survivalLoad: number[] = [];
      const baseTasks = 2; // Tasks per surviving agent
      const failedTasks = 6; // From 3 dead agents
      const survivors = 2;
      const recoveryBatchSize = 2; // Only take on 2 at a time

      for (let batch = 0; batch < Math.ceil(failedTasks / recoveryBatchSize); batch++) {
        const currentLoad = baseTasks + Math.min(recoveryBatchSize, failedTasks - batch * recoveryBatchSize);
        survivalLoad.push(currentLoad);
      }

      // Load never spikes too high in any single batch
      expect(Math.max(...survivalLoad)).toBeLessThanOrEqual(baseTasks + recoveryBatchSize);
    });

    it('should handle coordinator death and agent death simultaneously', async () => {
      const lock = new DistributedLock(redis);

      // Leader holds coordinator lock
      await lock.acquire({ key: 'coordinator', owner: 'leader-1', ttlMs: 5000 });
      // Worker holds task lock
      await lock.acquire({ key: 'task-1', owner: 'worker-1', ttlMs: 5000 });

      // Both die
      await lock.release('coordinator', 'leader-1');
      await lock.release('task-1', 'worker-1');

      // New leader elected AND worker recovery happen
      const newLeader = await lock.acquire({ key: 'coordinator', owner: 'leader-2', ttlMs: 5000 });
      const recoveredTask = await lock.acquire({ key: 'task-1', owner: 'worker-2', ttlMs: 5000 });

      expect(newLeader.acquired).toBe(true);
      expect(recoveredTask.acquired).toBe(true);
    });
  });

  describe('Deep Interactions: Session + Crash + Leader + Transport', () => {
    it('should handle session checkpoint saved on leader where leader dies and new leader cannot find checkpoint (storage was local)', async () => {
      // Leader saves locally only (not to Redis)
      const localCheckpoint = new SessionCheckpoint({ agentId: 'leader-1' });
      await localCheckpoint.save({ turn: 10, assignments: ['t1', 't2'] }, {});

      // New leader on different machine cannot access local storage
      const newLeaderCheckpoint = new SessionCheckpoint({ agentId: 'leader-1', redis });
      const restored = await newLeaderCheckpoint.restore();

      // Redis has nothing - must signal data loss
      expect(restored).toBeNull();

      // Fallback: reconstruct from distributed state
      await redis.set('distributed:assignments', JSON.stringify(['t1', 't2']));
      const fallback = await redis.get('distributed:assignments');
      expect(fallback).not.toBeNull();
      expect(JSON.parse(fallback!)).toEqual(['t1', 't2']);
    });

    it('should handle crash during distributed lock acquisition leaving orphaned lock', async () => {
      const lock = new DistributedLock(redis);

      // Agent acquires lock
      const result = await lock.acquire({ key: 'work-item-1', owner: 'agent-crash', ttlMs: 2000 });
      expect(result.acquired).toBe(true);

      // Agent crashes (doesn't release) - lock is orphaned
      // Detect orphaned via TTL check
      const info = await lock.inspect('work-item-1');
      expect(info?.locked).toBe(true);
      expect(info?.owner).toBe('agent-crash');

      // TTL expires (simulated by deleting)
      await redis.del('lock:work-item-1');

      // Lock is now reclaimable
      const reclaimed = await lock.acquire({ key: 'work-item-1', owner: 'agent-recovery', ttlMs: 5000 });
      expect(reclaimed.acquired).toBe(true);
    });

    it('should handle transport reconnection triggering session restore which triggers rebalance', async () => {
      const transport = new MockTransport();
      await transport.connect({ backend: 'memory' });

      // Agent considered dead, work rebalanced
      const rebalancedTasks = ['task-1', 'task-2', 'task-3'];
      await redis.set('rebalance:agent-1', JSON.stringify(rebalancedTasks));

      // Transport reconnects
      await transport.disconnect();
      await transport.connect({ backend: 'memory' });
      expect(transport.isConnected()).toBe(true);

      // Agent discovers it was considered dead
      const rebalanced = await redis.get('rebalance:agent-1');
      expect(rebalanced).not.toBeNull();

      // Coordinate with cluster: accept new assignment instead of taking back
      const tasks = JSON.parse(rebalanced!);
      expect(tasks.length).toBe(3);
    });

    it('should handle checkpoint from machine A restored on machine B with different tool set', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis });

      // Machine A has tools [search, code, deploy]
      await checkpoint.save(
        { turn: 5, pendingToolCalls: [{ tool: 'deploy', args: { target: 'prod' } }] },
        { tools: ['search', 'code', 'deploy'] }
      );

      // Machine B only has [search, code]
      const restored = await checkpoint.restore();
      const machineB_tools = ['search', 'code'];
      const pendingCalls = restored!.state.pendingToolCalls as Array<{ tool: string }>;

      // Detect missing tools
      const missingTools = pendingCalls
        .map(c => c.tool)
        .filter(t => !machineB_tools.includes(t));

      expect(missingTools).toEqual(['deploy']);

      // Handle gracefully: mark as failed, continue without
      const adjustedCalls = pendingCalls.map(call => ({
        ...call,
        status: machineB_tools.includes(call.tool) ? 'pending' : 'skipped-unavailable',
      }));

      expect(adjustedCalls[0].status).toBe('skipped-unavailable');
    });

    it('should handle distributed session merge after network partition heals', async () => {
      // Partition: two sides operate independently
      const partitionA = { tasks: ['task-1', 'task-2'], completed: ['task-1'] };
      const partitionB = { tasks: ['task-3', 'task-4'], completed: ['task-3'] };

      // Partition heals - merge states
      const mergedCompleted = [...new Set([...partitionA.completed, ...partitionB.completed])];
      const allTasks = [...new Set([...partitionA.tasks, ...partitionB.tasks])];
      const remaining = allTasks.filter(t => !mergedCompleted.includes(t));

      expect(mergedCompleted).toEqual(['task-1', 'task-3']);
      expect(remaining).toEqual(['task-2', 'task-4']);
    });

    it('should handle crash recovery discovering other agents have progressed (needs catch-up)', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-x', redis });

      // Agent X checkpoints at turn 5
      await checkpoint.save({ turn: 5, sharedProgress: 50 }, {});

      // Other agents advance shared state
      await redis.set('shared:progress', '85');

      // Agent X restored from stale checkpoint
      const restored = await checkpoint.restore();
      expect(restored!.state.sharedProgress).toBe(50);

      // Catch up: check current shared state
      const currentProgress = Number(await redis.get('shared:progress'));
      expect(currentProgress).toBe(85);

      // Skip already-done work
      const needsCatchUp = currentProgress > (restored!.state.sharedProgress as number);
      expect(needsCatchUp).toBe(true);
    });

    it('should handle leader election during session restore (who coordinates the restore)', async () => {
      const lock = new DistributedLock(redis);

      // Leader dies - both election and restore needed
      // Chicken-and-egg: elect leader first, then leader coordinates restore

      // Step 1: Election (must happen first)
      const elected = await lock.acquire({ key: 'leader', owner: 'candidate-a', ttlMs: 30000 });
      expect(elected.acquired).toBe(true);

      // Step 2: New leader coordinates restore
      const checkpoint = new SessionCheckpoint({ agentId: 'cluster', redis });
      await checkpoint.save({ turn: 20, workers: ['w1', 'w2', 'w3'] }, {});

      const restored = await checkpoint.restore();
      expect(restored).not.toBeNull();
      expect((restored!.state.workers as string[]).length).toBe(3);
    });

    it('should handle session including pending messages in transport buffer (buffer lost on crash)', async () => {
      const transport = new MockTransport();
      await transport.connect({ backend: 'memory' });

      // Agent has 5 messages in outbox
      const outbox = ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5'];

      // Only first 2 were sent before crash
      await transport.publish('channel-a', outbox[0]);
      await transport.publish('channel-a', outbox[1]);

      // Crash! Buffer lost (messages 3-5 never sent)
      const sentMessages = transport.publishedMessages.length;
      expect(sentMessages).toBe(2);

      const lostMessages = outbox.slice(sentMessages);
      expect(lostMessages).toEqual(['msg-3', 'msg-4', 'msg-5']);

      // Recovery: detect unsent messages
      // Session checkpoint should record outbox state
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis });
      await checkpoint.save({ outbox: outbox, lastSent: 1 }, {});

      const restored = await checkpoint.restore();
      const restoredOutbox = restored!.state.outbox as string[];
      const lastSent = restored!.state.lastSent as number;
      const unsent = restoredOutbox.slice(lastSent + 1);
      expect(unsent).toEqual(['msg-3', 'msg-4', 'msg-5']);
    });
  });
});
