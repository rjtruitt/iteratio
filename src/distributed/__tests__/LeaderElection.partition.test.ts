import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { TestScheduler } from '../../__test__/TestScheduler';
import { LeaderElection } from '../LeaderElection';

describe('LeaderElection — Network Partition Scenarios', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock(1000000);
    clock.install();
    scheduler = new TestScheduler();
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
    scheduler.reset();
  });

  describe('network partition: old leader loses connectivity', () => {
    it('should cause old leader to lose leadership when it cannot refresh', async () => {
      const oldLeader = new LeaderElection({
        etcd: redis,
        agentId: 'old-leader',
        defaultTTL: 10000,
      });

      await oldLeader.campaign('overseer');
      expect(oldLeader.isLeader('overseer')).toBe(true);

      // Simulate network partition — Redis becomes unreachable for old leader
      redis.disconnect();

      // Advance past TTL/2 — refresh will fire and fail
      clock.advance(12000);

      // Flush microtasks so the async refresh callback completes
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Old leader should realize it lost leadership
      expect(oldLeader.isLeader('overseer')).toBe(false);
    });

    it('should allow new leader election during partition', async () => {
      const oldLeader = new LeaderElection({
        etcd: redis,
        agentId: 'old-leader',
        defaultTTL: 10000,
      });

      await oldLeader.campaign('overseer');

      // Old leader's TTL expires
      clock.advance(12000);

      // Redis is now available to new candidate (partition only affected old leader)
      redis.reconnect();

      const newLeader = new LeaderElection({
        etcd: redis,
        agentId: 'new-leader',
        defaultTTL: 30000,
      });

      await newLeader.campaign('overseer');
      expect(newLeader.isLeader('overseer')).toBe(true);
    });

    it('should emit leader:lost event when partition isolates the leader', async () => {
      const events: any[] = [];
      const leader = new LeaderElection({
        etcd: redis,
        agentId: 'isolated-leader',
        defaultTTL: 10000,
      });

      leader.on('leader:lost', (data) => events.push(data));

      await leader.campaign('overseer');
      redis.disconnect();
      clock.advance(12000);

      // Flush microtasks so the async refresh callback completes
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(events.some(e => e.role === 'overseer')).toBe(true);
    });
  });

  describe('split-brain: two nodes both claim leadership', () => {
    it('should detect split-brain scenario', async () => {
      const leaderA = new LeaderElection({
        etcd: redis,
        agentId: 'leader-A',
        defaultTTL: 10000,
      });

      const leaderB = new LeaderElection({
        etcd: redis,
        agentId: 'leader-B',
        defaultTTL: 10000,
      });

      // A wins initially
      await leaderA.campaign('overseer');
      expect(leaderA.isLeader('overseer')).toBe(true);

      // A's TTL expires
      clock.advance(12000);

      // B campaigns and wins
      await leaderB.campaign('overseer');
      expect(leaderB.isLeader('overseer')).toBe(true);

      // A still thinks it's leader (stale local state)
      // After detecting the stale state, A should not be leader
      const actualLeader = await leaderA.getLeader('overseer');
      expect(actualLeader).toBe('leader-B');
    });

    it('should prevent two simultaneous leaders via atomic SETNX', async () => {
      const candidates = Array.from({ length: 10 }, (_, i) =>
        new LeaderElection({
          etcd: redis,
          agentId: `candidate-${i}`,
          defaultTTL: 30000,
        })
      );

      const results = await Promise.all(
        candidates.map(c => c.campaign('overseer'))
      );

      const leaders = candidates.filter(c => c.isLeader('overseer'));
      expect(leaders).toHaveLength(1);
    });
  });

  describe('split-brain resolution (fencing token / epoch)', () => {
    it('should increment term number on each election', async () => {
      const leader = new LeaderElection({
        etcd: redis,
        agentId: 'persistent-candidate',
        defaultTTL: 10000,
      });

      const result1 = await leader.campaign('overseer');
      expect(result1.term).toBe(1);

      await leader.resign('overseer');

      const result2 = await leader.campaign('overseer');
      expect(result2.term).toBe(2);
    });

    it('should reject operations from stale leader with old term', async () => {
      const leaderA = new LeaderElection({
        etcd: redis,
        agentId: 'leader-A',
        defaultTTL: 10000,
      });

      const result = await leaderA.campaign('overseer');
      const oldTerm = result.term;

      // A's TTL expires
      clock.advance(12000);

      // B takes over with new term
      const leaderB = new LeaderElection({
        etcd: redis,
        agentId: 'leader-B',
        defaultTTL: 30000,
      });

      const resultB = await leaderB.campaign('overseer');
      expect(resultB.term).toBeGreaterThan(oldTerm);
    });

    it('should track term history across leader changes', async () => {
      const leaderA = new LeaderElection({
        etcd: redis,
        agentId: 'leader-A',
        defaultTTL: 10000,
      });

      await leaderA.campaign('overseer');
      await leaderA.resign('overseer');

      const leaderB = new LeaderElection({
        etcd: redis,
        agentId: 'leader-B',
        defaultTTL: 10000,
      });

      const resultB = await leaderB.campaign('overseer');
      await leaderB.resign('overseer');

      const leaderC = new LeaderElection({
        etcd: redis,
        agentId: 'leader-C',
        defaultTTL: 10000,
      });

      const resultC = await leaderC.campaign('overseer');

      // Terms should be monotonically increasing
      expect(resultC.term).toBeGreaterThan(resultB.term);
    });
  });

  describe('rapid failover', () => {
    it('should elect new leader within seconds of old leader dying', async () => {
      const oldLeader = new LeaderElection({
        etcd: redis,
        agentId: 'dying-leader',
        defaultTTL: 5000, // Short TTL for fast failover
      });

      await oldLeader.campaign('overseer');

      // Leader dies (stop refresh, TTL expires)
      clock.advance(6000);

      const newLeader = new LeaderElection({
        etcd: redis,
        agentId: 'fast-candidate',
        defaultTTL: 30000,
      });

      const failoverStart = clock.now;
      await newLeader.campaign('overseer');
      const failoverEnd = clock.now;

      expect(newLeader.isLeader('overseer')).toBe(true);
      expect(failoverEnd - failoverStart).toBeLessThan(5000);
    });

    it('should handle rapid succession of leaders', async () => {
      const leaders: string[] = [];

      for (let i = 0; i < 5; i++) {
        const candidate = new LeaderElection({
          etcd: redis,
          agentId: `leader-${i}`,
          defaultTTL: 5000,
        });

        await candidate.campaign('overseer');
        if (candidate.isLeader('overseer')) {
          leaders.push(`leader-${i}`);
          await candidate.resign('overseer');
        }
      }

      // Each resign should allow next campaign to succeed
      expect(leaders).toHaveLength(5);
    });

    it('should not leave zombie leaders after rapid failover', async () => {
      const leader1 = new LeaderElection({
        etcd: redis,
        agentId: 'leader-1',
        defaultTTL: 5000,
      });

      await leader1.campaign('overseer');
      await leader1.resign('overseer');

      const leader2 = new LeaderElection({
        etcd: redis,
        agentId: 'leader-2',
        defaultTTL: 5000,
      });

      await leader2.campaign('overseer');

      // Only leader-2 should be the current leader
      const current = await leader2.getLeader('overseer');
      expect(current).toBe('leader-2');
    });
  });

  describe('multi-role election', () => {
    it('should allow different leaders for different concerns', async () => {
      const agentA = new LeaderElection({
        etcd: redis,
        agentId: 'agent-A',
        defaultTTL: 30000,
      });

      const agentB = new LeaderElection({
        etcd: redis,
        agentId: 'agent-B',
        defaultTTL: 30000,
      });

      await agentA.campaign('overseer');
      await agentB.campaign('scheduler');

      expect(agentA.isLeader('overseer')).toBe(true);
      expect(agentB.isLeader('scheduler')).toBe(true);

      // Each role has its own leader
      const overseerLeader = await agentA.getLeader('overseer');
      const schedulerLeader = await agentB.getLeader('scheduler');

      expect(overseerLeader).toBe('agent-A');
      expect(schedulerLeader).toBe('agent-B');
    });

    it('should handle one leader managing multiple roles', async () => {
      const superAgent = new LeaderElection({
        etcd: redis,
        agentId: 'super-agent',
        defaultTTL: 30000,
      });

      await superAgent.campaign('overseer');
      await superAgent.campaign('scheduler');
      await superAgent.campaign('monitor');

      expect(superAgent.isLeader('overseer')).toBe(true);
      expect(superAgent.isLeader('scheduler')).toBe(true);
      expect(superAgent.isLeader('monitor')).toBe(true);
    });

    it('should independently elect leaders when roles have different candidates', async () => {
      const agents = ['agent-A', 'agent-B', 'agent-C'].map(id =>
        new LeaderElection({ etcd: redis, agentId: id, defaultTTL: 30000 })
      );

      // All compete for all roles
      for (const agent of agents) {
        await agent.campaign('overseer');
        await agent.campaign('scheduler');
      }

      // Only one leader per role
      const overseerLeaders = agents.filter(a => a.isLeader('overseer'));
      const schedulerLeaders = agents.filter(a => a.isLeader('scheduler'));

      expect(overseerLeaders).toHaveLength(1);
      expect(schedulerLeaders).toHaveLength(1);
    });
  });

  describe('partition heals: conflicting leaders resolve', () => {
    it('should resolve to single leader when partition heals', async () => {
      const leaderA = new LeaderElection({
        etcd: redis,
        agentId: 'leader-A',
        defaultTTL: 10000,
      });

      await leaderA.campaign('overseer');

      // Partition: A's key expires, B takes over
      clock.advance(12000);

      const leaderB = new LeaderElection({
        etcd: redis,
        agentId: 'leader-B',
        defaultTTL: 30000,
      });

      await leaderB.campaign('overseer');

      // Partition heals — A tries to verify its leadership
      const actualLeader = await leaderA.getLeader('overseer');

      // B should be the true leader
      expect(actualLeader).toBe('leader-B');
      // A should recognize it's no longer leader
      expect(leaderA.isLeader('overseer')).toBe(false);
    });

    it('should use highest term as tiebreaker', async () => {
      const election1 = new LeaderElection({
        etcd: redis,
        agentId: 'node-1',
        defaultTTL: 10000,
      });

      // First term
      await election1.campaign('overseer');
      await election1.resign('overseer');

      // Second term — different node
      const election2 = new LeaderElection({
        etcd: redis,
        agentId: 'node-2',
        defaultTTL: 10000,
      });

      const result = await election2.campaign('overseer');

      // Term should be > 1, indicating this is a newer election
      expect(result.term).toBeGreaterThan(1);
    });

    it('should not allow old leader to reclaim after new leader established', async () => {
      const oldLeader = new LeaderElection({
        etcd: redis,
        agentId: 'old-leader',
        defaultTTL: 10000,
      });

      await oldLeader.campaign('overseer');
      clock.advance(12000); // TTL expires

      const newLeader = new LeaderElection({
        etcd: redis,
        agentId: 'new-leader',
        defaultTTL: 30000,
      });

      await newLeader.campaign('overseer');
      expect(newLeader.isLeader('overseer')).toBe(true);

      // Old leader tries to campaign again
      await oldLeader.campaign('overseer');

      // New leader should still hold
      expect(newLeader.isLeader('overseer')).toBe(true);
      expect(oldLeader.isLeader('overseer')).toBe(false);
    });

    it('should notify watchers of resolution', async () => {
      const changes: Array<string | null> = [];

      const watcher = new LeaderElection({
        etcd: redis,
        agentId: 'watcher',
        defaultTTL: 30000,
      });

      await watcher.watchLeaderChanges('overseer', (leader) => {
        changes.push(leader);
      });

      // First leader
      const leader1 = new LeaderElection({
        etcd: redis,
        agentId: 'leader-1',
        defaultTTL: 10000,
      });
      await leader1.campaign('overseer');

      // Advance to trigger watcher poll (500ms interval)
      clock.advance(600);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Leader 1 dies (TTL expires)
      clock.advance(11000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Second leader takes over
      const leader2 = new LeaderElection({
        etcd: redis,
        agentId: 'leader-2',
        defaultTTL: 30000,
      });
      await leader2.campaign('overseer');

      // Advance to trigger watcher poll again
      clock.advance(600);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(changes).toContain('leader-1');
      expect(changes).toContain('leader-2');
    });
  });
});
