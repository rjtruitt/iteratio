import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockTransport,
  MockEventBus,
  MockRedis,
  MockStateManager,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 23: Leader Election in Distributed System ---
// Tests leader election, failover, split-brain resolution, rapid failover,
// multi-role elections, responsibility transfer, and health checks.

describe('E2E Scenario 23: Leader Election', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let redis: MockRedis;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    redis = new MockRedis();
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
    redis.reset();
  });

  describe('Initial Election', () => {
    it('should elect exactly one leader from 3 nodes', async () => {
      const nodes = Array.from({ length: 3 }, (_, i) => ({
        id: `node-${i}`,
        elector: stateManager.get<any>('leaderElector'),
      }));

      // Run election
      for (const node of nodes) {
        await node.elector.participate(node.id, redis);
      }

      const leaders = nodes.filter(n => n.elector.isLeader());
      const followers = nodes.filter(n => !n.elector.isLeader());

      expect(leaders.length).toBe(1);
      expect(followers.length).toBe(2);
    });

    it('should assign leader role to the first node to acquire lock', async () => {
      const elector = stateManager.get<any>('leaderElector');

      await elector.participate('node-0', redis);

      // First node should be leader (acquired Redis lock first)
      expect(elector.isLeader()).toBe(true);
      expect(elector.getLeaderId()).toBe('node-0');
    });

    it('should emit leader:elected event with leader details', async () => {
      const elector = stateManager.get<any>('leaderElector');
      await elector.participate('node-0', redis);

      expect(eventBus.emitted('leader:elected')).toBe(true);
      const data = eventBus.lastEmitted<any>('leader:elected');
      expect(data.nodeId).toBe('node-0');
    });
  });

  describe('Leader Failover', () => {
    it('should detect leader death and trigger new election', async () => {
      const elector = stateManager.get<any>('leaderElector');
      elector.setHeartbeatInterval(1000);
      elector.setLeaderTimeout(3000);

      // node-0 becomes leader
      await elector.participate('node-0', redis);
      expect(elector.getLeaderId()).toBe('node-0');

      // Simulate leader death (stop heartbeats)
      elector.simulateNodeDeath('node-0');

      // Advance past timeout
      clock.advance(3500);

      // Follower node-1 should detect and start election
      await elector.participate('node-1', redis);
      expect(elector.getLeaderId()).toBe('node-1');
    });

    it('should elect new leader within 2 heartbeat periods (rapid failover)', async () => {
      const elector = stateManager.get<any>('leaderElector');
      elector.setHeartbeatInterval(1000);
      elector.setLeaderTimeout(2000); // 2 heartbeats

      await elector.participate('node-0', redis);
      elector.simulateNodeDeath('node-0');

      clock.advance(2100);
      await elector.participate('node-1', redis);

      expect(elector.getLeaderId()).toBe('node-1');
      // Total time should be within 2 heartbeat periods
      expect(clock.now).toBeLessThanOrEqual(2200);
    });

    it('should emit leader:lost and leader:elected events during failover', async () => {
      const elector = stateManager.get<any>('leaderElector');
      elector.setHeartbeatInterval(1000);
      elector.setLeaderTimeout(2000);

      await elector.participate('node-0', redis);
      elector.simulateNodeDeath('node-0');
      clock.advance(2100);
      await elector.participate('node-1', redis);

      expect(eventBus.emitted('leader:lost')).toBe(true);
      expect(eventBus.emittedCount('leader:elected')).toBe(2);
    });
  });

  describe('Split Brain Resolution', () => {
    it('should resolve conflicting leaders when partition heals', async () => {
      const elector = stateManager.get<any>('leaderElector');

      // Simulate network partition: both sides elect a leader
      await elector.simulatePartition(['node-0', 'node-1'], ['node-2', 'node-3']);

      // Both partitions elect leaders
      elector.setLeader('node-0', 'partition-a');
      elector.setLeader('node-2', 'partition-b');

      // Heal partition
      await elector.healPartition();

      // Should resolve to single leader
      const leaders = elector.getAllLeaders();
      expect(leaders.length).toBe(1);
    });

    it('should use fencing token to resolve split brain', async () => {
      const elector = stateManager.get<any>('leaderElector');

      // node-0 has fencing token 5
      elector.setLeaderWithToken('node-0', 5);
      // node-2 has fencing token 7 (higher = more recent)
      elector.setLeaderWithToken('node-2', 7);

      await elector.healPartition();

      // Higher fencing token wins
      expect(elector.getLeaderId()).toBe('node-2');
    });

    it('should emit split-brain:resolved event', async () => {
      const elector = stateManager.get<any>('leaderElector');

      await elector.simulatePartition(['node-0'], ['node-1']);
      elector.setLeader('node-0', 'a');
      elector.setLeader('node-1', 'b');
      await elector.healPartition();

      expect(eventBus.emitted('split-brain:resolved')).toBe(true);
    });
  });

  describe('Multi-Role Election', () => {
    it('should elect different leaders for different roles', async () => {
      const elector = stateManager.get<any>('leaderElector');

      await elector.participate('node-0', redis, { role: 'task-coordinator' });
      await elector.participate('node-1', redis, { role: 'model-router' });

      const taskLeader = elector.getLeaderForRole('task-coordinator');
      const modelLeader = elector.getLeaderForRole('model-router');

      expect(taskLeader).toBe('node-0');
      expect(modelLeader).toBe('node-1');
    });

    it('should allow same node to be leader for multiple roles', async () => {
      const elector = stateManager.get<any>('leaderElector');

      await elector.participate('node-0', redis, { role: 'coordinator' });
      await elector.participate('node-0', redis, { role: 'router' });

      expect(elector.getLeaderForRole('coordinator')).toBe('node-0');
      expect(elector.getLeaderForRole('router')).toBe('node-0');
    });

    it('should handle role-specific failover independently', async () => {
      const elector = stateManager.get<any>('leaderElector');
      elector.setHeartbeatInterval(1000);
      elector.setLeaderTimeout(2000);

      await elector.participate('node-0', redis, { role: 'coordinator' });
      await elector.participate('node-1', redis, { role: 'router' });

      // Only coordinator leader dies
      elector.simulateNodeDeath('node-0');
      clock.advance(2100);
      await elector.participate('node-2', redis, { role: 'coordinator' });

      // Router leader unchanged
      expect(elector.getLeaderForRole('coordinator')).toBe('node-2');
      expect(elector.getLeaderForRole('router')).toBe('node-1');
    });
  });

  describe('Responsibility Transfer', () => {
    it('should transfer leader responsibilities cleanly to new leader', async () => {
      const elector = stateManager.get<any>('leaderElector');

      await elector.participate('node-0', redis);

      // Leader has responsibilities (e.g., task assignment state)
      elector.setLeaderState({ assignedTasks: ['t1', 't2', 't3'] });

      // Graceful stepdown
      await elector.stepDown('node-0');
      await elector.participate('node-1', redis);

      // New leader should receive transferred state
      const newLeaderState = elector.getLeaderState();
      expect(newLeaderState.assignedTasks).toEqual(['t1', 't2', 't3']);
    });

    it('should not lose pending work during leader transfer', async () => {
      const elector = stateManager.get<any>('leaderElector');

      await elector.participate('node-0', redis);
      elector.setLeaderState({ pendingQueue: ['task-a', 'task-b'] });

      // Ungraceful failure (no stepDown)
      elector.simulateNodeDeath('node-0');
      clock.advance(3000);
      await elector.participate('node-1', redis);

      // New leader should recover pending work from Redis
      const state = elector.getLeaderState();
      expect(state.pendingQueue).toContain('task-a');
      expect(state.pendingQueue).toContain('task-b');
    });
  });

  describe('Non-Leader Behavior', () => {
    it('should reject coordination requests if not leader', async () => {
      const elector = stateManager.get<any>('leaderElector');

      // node-0 is leader
      await elector.participate('node-0', redis);

      // node-1 is follower
      const followerElector = stateManager.get<any>('leaderElector');
      followerElector.setRole('follower', 'node-1');

      // Follower should reject coordination request
      const result = followerElector.handleCoordinationRequest({ type: 'assign-task' });
      expect(result.rejected).toBe(true);
      expect(result.redirectTo).toBe('node-0');
    });

    it('should route requests to current leader', async () => {
      const elector = stateManager.get<any>('leaderElector');
      await elector.participate('node-0', redis);

      const followerElector = stateManager.get<any>('leaderElector');
      followerElector.setRole('follower', 'node-1');

      const routing = followerElector.routeToLeader({ type: 'task-assignment' });
      expect(routing.targetNode).toBe('node-0');
    });
  });

  describe('Leader Health Check', () => {
    it('should confirm leader liveness via heartbeat', async () => {
      const elector = stateManager.get<any>('leaderElector');
      elector.setHeartbeatInterval(1000);

      await elector.participate('node-0', redis);

      // Advance time but leader is alive (sends heartbeats)
      clock.advance(5000);

      expect(elector.isLeaderAlive()).toBe(true);
    });

    it('should detect stale leader (missed heartbeats)', async () => {
      const elector = stateManager.get<any>('leaderElector');
      elector.setHeartbeatInterval(1000);
      elector.setLeaderTimeout(3000);

      await elector.participate('node-0', redis);
      elector.pauseHeartbeats('node-0');

      clock.advance(3500);

      expect(elector.isLeaderAlive()).toBe(false);
    });

    it('should expose leader health metrics', async () => {
      const elector = stateManager.get<any>('leaderElector');
      await elector.participate('node-0', redis);

      clock.advance(5000);
      const metrics = elector.getHealthMetrics();

      expect(metrics.lastHeartbeat).toBeDefined();
      expect(metrics.uptime).toBeGreaterThan(0);
      expect(metrics.electionCount).toBeGreaterThanOrEqual(1);
    });
  });
});
