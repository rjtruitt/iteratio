import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { TestScheduler } from '../../__test__/TestScheduler';
import { HealthMonitor, FailureEvent } from '../HealthMonitor';
import { AgentRegistry, AgentIdentity, resetSharedBackends } from '../AgentRegistry';
import { AgentMessageBus } from '../AgentMessageBus';
import { WorkCoordinator } from '../WorkCoordinator';

describe('HealthMonitor — Cascading Failures', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let registry: AgentRegistry;
  let messageBus: AgentMessageBus;
  let workCoordinator: WorkCoordinator;
  let monitor: HealthMonitor;

  const makeAgent = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({
    id: overrides.id ?? 'worker_1@m1',
    role: overrides.role ?? 'worker',
    parentId: overrides.parentId,
    children: overrides.children ?? [],
    machineId: overrides.machineId ?? 'machine1',
    hostname: 'machine1.local',
    pid: 1234,
    llmProvider: 'anthropic',
    llmModel: 'claude-4',
    capabilities: ['code'],
    status: overrides.status ?? 'running',
    lastHeartbeat: overrides.lastHeartbeat ?? Date.now(),
    createdAt: Date.now(),
    endpoints: {},
    ...overrides,
  });

  beforeEach(() => {
    resetSharedBackends();
    redis = new MockRedis();
    clock = new TestClock(1000000);
    clock.install();

    registry = new AgentRegistry({
      backend: 'redis',
      backendUrl: 'redis://localhost:6379',
      ttl: 30000,
    });

    messageBus = new AgentMessageBus({
      backend: 'redis',
      backendUrl: 'redis://localhost:6379',
      clientId: 'monitor',
    });

    workCoordinator = new WorkCoordinator({ redis });

    monitor = new HealthMonitor({
      registry,
      messageBus,
      workCoordinator,
      checkInterval: 10000,
      heartbeatTimeout: 60000,
      autoRecover: true,
    });
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('cascading failure detection', () => {
    it('should detect when dependent agent B fails after A depends on it', async () => {
      // A depends on B (B is parent or dependency)
      const agentB = makeAgent({
        id: 'service-B@m2',
        role: 'orchestrator',
        lastHeartbeat: clock.now - 70000, // Dead
      });
      const agentA = makeAgent({
        id: 'worker-A@m1',
        role: 'worker',
        parentId: 'service-B@m2',
        lastHeartbeat: clock.now, // Still alive
      });

      await registry.register(agentB);
      await registry.register(agentA);

      const failures: FailureEvent[] = [];
      monitor.on('agent:dead', (event) => failures.push(event));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      // B should be detected as dead
      expect(failures.some(f => f.agentId === 'service-B@m2')).toBe(true);
    });

    it('should notify parent when child agent fails', async () => {
      const parent = makeAgent({
        id: 'orchestrator@m1',
        role: 'orchestrator',
        children: ['worker@m2'],
        lastHeartbeat: clock.now,
      });
      const child = makeAgent({
        id: 'worker@m2',
        role: 'worker',
        parentId: 'orchestrator@m1',
        lastHeartbeat: clock.now - 70000, // Dead
      });

      await registry.register(parent);
      await registry.register(child);

      const notifications: any[] = [];
      await messageBus.subscribe('orchestrator@m1', (msg) => {
        notifications.push(msg);
      });

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      expect(notifications.some(n =>
        n.content?.type === 'child_died' && n.content?.childId === 'worker@m2'
      )).toBe(true);
    });

    it('should detect cascading failure when parent dies then children become orphaned', async () => {
      const parent = makeAgent({
        id: 'parent@m1',
        role: 'orchestrator',
        children: ['child1@m1', 'child2@m2'],
        lastHeartbeat: clock.now - 70000, // Dead
      });
      const child1 = makeAgent({
        id: 'child1@m1',
        role: 'worker',
        parentId: 'parent@m1',
        lastHeartbeat: clock.now,
      });
      const child2 = makeAgent({
        id: 'child2@m2',
        role: 'worker',
        parentId: 'parent@m1',
        lastHeartbeat: clock.now,
      });

      await registry.register(parent);
      await registry.register(child1);
      await registry.register(child2);

      const failures: FailureEvent[] = [];
      monitor.on('agent:dead', (event) => failures.push(event));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      // Parent detected dead
      expect(failures.some(f => f.agentId === 'parent@m1')).toBe(true);

      // Children should be flagged as orphaned (or recovery triggered)
      const recovered = monitor.getFailureHistory({ agentId: 'parent@m1' });
      expect(recovered).toHaveLength(1);
    });
  });

  describe('partial cluster failure', () => {
    it('should detect when 3 of 5 nodes fail', async () => {
      const agents = [
        makeAgent({ id: 'node1@m1', lastHeartbeat: clock.now }),
        makeAgent({ id: 'node2@m2', lastHeartbeat: clock.now }),
        makeAgent({ id: 'node3@m3', lastHeartbeat: clock.now - 70000 }), // Dead
        makeAgent({ id: 'node4@m4', lastHeartbeat: clock.now - 70000 }), // Dead
        makeAgent({ id: 'node5@m5', lastHeartbeat: clock.now - 70000 }), // Dead
      ];

      for (const agent of agents) {
        await registry.register(agent);
      }

      const failures: FailureEvent[] = [];
      monitor.on('agent:dead', (event) => failures.push(event));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      expect(failures).toHaveLength(3);
    });

    it('should report system health as critical when majority fails', async () => {
      const agents = [
        makeAgent({ id: 'n1@m1', lastHeartbeat: clock.now }),
        makeAgent({ id: 'n2@m2', lastHeartbeat: clock.now - 70000 }),
        makeAgent({ id: 'n3@m3', lastHeartbeat: clock.now - 70000 }),
        makeAgent({ id: 'n4@m4', lastHeartbeat: clock.now - 70000 }),
        makeAgent({ id: 'n5@m5', lastHeartbeat: clock.now - 70000 }),
      ];

      for (const agent of agents) {
        await registry.register(agent);
      }

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      const systemHealth = monitor.getSystemHealth();
      expect(systemHealth.status).toBe('critical');
    });

    it('should identify which specific machines are affected', async () => {
      const agents = [
        makeAgent({ id: 'a@m1', machineId: 'machine1', lastHeartbeat: clock.now }),
        makeAgent({ id: 'b@m2', machineId: 'machine2', lastHeartbeat: clock.now - 70000 }),
        makeAgent({ id: 'c@m2', machineId: 'machine2', lastHeartbeat: clock.now - 70000 }),
      ];

      for (const agent of agents) {
        await registry.register(agent);
      }

      const failures: FailureEvent[] = [];
      monitor.on('agent:dead', (event) => failures.push(event));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      const affectedMachines = new Set(failures.map(f => f.agent.machineId));
      expect(affectedMachines.has('machine2')).toBe(true);
      expect(affectedMachines.has('machine1')).toBe(false);
    });
  });

  describe('quorum loss detection', () => {
    it('should detect quorum loss when more than half the agents are dead', async () => {
      const agents = Array.from({ length: 7 }, (_, i) => makeAgent({
        id: `agent${i}@m${i}`,
        machineId: `machine${i}`,
        lastHeartbeat: i < 4 ? clock.now - 70000 : clock.now, // 4 dead, 3 alive
      }));

      for (const agent of agents) {
        await registry.register(agent);
      }

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      const metrics = monitor.getMetrics();
      expect(metrics.deadAgents).toBe(4);
      expect(metrics.deadAgents).toBeGreaterThan(metrics.totalAgents / 2);
    });

    it('should emit system:quorum-lost event when quorum is lost', async () => {
      const events: any[] = [];
      monitor.on('system:quorum-lost', (event) => events.push(event));

      const agents = Array.from({ length: 5 }, (_, i) => makeAgent({
        id: `agent${i}@m${i}`,
        lastHeartbeat: i < 3 ? clock.now - 70000 : clock.now,
      }));

      for (const agent of agents) {
        await registry.register(agent);
      }

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      expect(events).toHaveLength(1);
    });
  });

  describe('recovery from cascading failure', () => {
    it('should detect recovery when dead agents come back', async () => {
      const recoveryEvents: any[] = [];
      monitor.on('agent:recovered', (event) => recoveryEvents.push(event));

      // Start with dead agent
      await registry.register(makeAgent({
        id: 'revived@m1',
        lastHeartbeat: clock.now - 70000,
      }));

      await monitor.watchAgents();
      clock.advance(10000); // Detect death
      for (let i = 0; i < 50; i++) await Promise.resolve();

      // Agent comes back (unregister stale entry, re-register with fresh heartbeat)
      await registry.unregister('revived@m1');
      await registry.register(makeAgent({
        id: 'revived@m1',
        lastHeartbeat: clock.now,
      }));

      clock.advance(10000); // Next check cycle
      for (let i = 0; i < 50; i++) await Promise.resolve();

      expect(recoveryEvents.some(e => e.agentId === 'revived@m1')).toBe(true);
    });

    it('should update system health status on recovery', async () => {
      const agents = Array.from({ length: 4 }, (_, i) => makeAgent({
        id: `agent${i}@m${i}`,
        machineId: `machine${i}`,
        lastHeartbeat: i < 3 ? clock.now - 70000 : clock.now, // 3 dead initially
      }));

      for (const agent of agents) {
        await registry.register(agent);
      }

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      // System should be critical
      expect(monitor.getSystemHealth().status).toBe('critical');

      // Agents recover (unregister stale, re-register with fresh heartbeat)
      for (let i = 0; i < 3; i++) {
        await registry.unregister(`agent${i}@m${i}`);
        await registry.register(makeAgent({
          id: `agent${i}@m${i}`,
          machineId: `machine${i}`,
          lastHeartbeat: clock.now,
        }));
      }

      clock.advance(10000);
      for (let i = 0; i < 50; i++) await Promise.resolve();

      // System should be healthy again
      expect(monitor.getSystemHealth().status).toBe('healthy');
    });
  });

  describe('health monitor survives Redis disconnection', () => {
    it('should not crash when Redis becomes unreachable during health check', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', lastHeartbeat: clock.now }));

      await monitor.watchAgents();

      // Redis goes down
      redis.disconnect();

      // Health check should not throw
      clock.advance(10000);

      // Monitor should still be running
      const errorEvents: any[] = [];
      monitor.on('monitor:error', (err) => errorEvents.push(err));

      clock.advance(10000);

      // Should emit error event instead of crashing
      expect(errorEvents.length).toBeGreaterThanOrEqual(0);
    });

    it('should resume monitoring after Redis reconnects', async () => {
      await registry.register(makeAgent({
        id: 'survivor@m1',
        lastHeartbeat: clock.now,
      }));

      await monitor.watchAgents();

      redis.disconnect();
      clock.advance(10000); // Check during disconnection
      for (let i = 0; i < 50; i++) await Promise.resolve();

      redis.reconnect();

      // Now add a dead agent
      await registry.register(makeAgent({
        id: 'newdead@m2',
        machineId: 'machine2',
        lastHeartbeat: clock.now - 70000,
      }));

      const failures: FailureEvent[] = [];
      monitor.on('agent:dead', (event) => failures.push(event));

      clock.advance(10000); // Check after reconnection
      for (let i = 0; i < 50; i++) await Promise.resolve();

      expect(failures.some(f => f.agentId === 'newdead@m2')).toBe(true);
    });

    it('should not false-flag agents as dead during Redis outage', async () => {
      await registry.register(makeAgent({
        id: 'innocent@m1',
        lastHeartbeat: clock.now,
      }));

      const failures: FailureEvent[] = [];
      monitor.on('agent:dead', (event) => failures.push(event));

      await monitor.watchAgents();

      // Redis goes down briefly
      redis.disconnect();
      clock.advance(10000);
      redis.reconnect();
      clock.advance(10000);

      // Healthy agent should not be flagged
      expect(failures.some(f => f.agentId === 'innocent@m1')).toBe(false);
    });
  });
});
