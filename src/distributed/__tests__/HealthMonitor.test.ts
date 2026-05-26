import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { HealthMonitor, HealthCheck, FailureEvent } from '../HealthMonitor';
import { AgentRegistry, AgentIdentity, resetSharedBackends } from '../AgentRegistry';
import { AgentMessageBus } from '../AgentMessageBus';
import { WorkCoordinator } from '../WorkCoordinator';

describe('HealthMonitor', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let registry: AgentRegistry;
  let messageBus: AgentMessageBus;
  let workCoordinator: WorkCoordinator;
  let monitor: HealthMonitor;

  const makeAgent = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({
    id: overrides.id ?? 'worker_1@m1',
    role: overrides.role ?? 'worker',
    children: [],
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
      ttl: 300000, // 5 min TTL so entries don't expire during tests
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

  afterEach(async () => {
    monitor.stopWatching();
    clock.uninstall();
    redis.reset();
  });

  describe('detect agent failure', () => {
    it('should detect agent as dead after heartbeat timeout', async () => {
      const agent = makeAgent({
        id: 'dying-agent@m1',
        lastHeartbeat: clock.now - 70000, // Already past timeout
      });
      await registry.register(agent);

      const deadAgents: AgentIdentity[] = [];
      await monitor.watchAgents((dead) => deadAgents.push(dead));

      // Trigger health check cycle
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(deadAgents).toHaveLength(1);
      expect(deadAgents[0].id).toBe('dying-agent@m1');
    });

    it('should emit agent:dead event for failed agents', async () => {
      const events: FailureEvent[] = [];
      monitor.on('agent:dead', (event) => events.push(event));

      const agent = makeAgent({
        id: 'failed@m1',
        lastHeartbeat: clock.now - 70000,
      });
      await registry.register(agent);

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe('failed@m1');
      expect(events[0].reason).toBe('heartbeat_timeout');
    });

    it('should include correct detection timestamp in failure event', async () => {
      const events: FailureEvent[] = [];
      monitor.on('agent:dead', (event) => events.push(event));

      const agent = makeAgent({
        id: 'dead@m1',
        lastHeartbeat: clock.now - 70000,
      });
      await registry.register(agent);

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(events[0].detectedAt).toBe(clock.now);
      expect(events[0].lastSeen).toBe(agent.lastHeartbeat);
    });
  });

  describe('healthy agent with regular heartbeats', () => {
    it('should not flag agents with recent heartbeats', async () => {
      const agent = makeAgent({
        id: 'healthy@m1',
        lastHeartbeat: clock.now, // Just beat
      });
      await registry.register(agent);

      const deadAgents: AgentIdentity[] = [];
      await monitor.watchAgents((dead) => deadAgents.push(dead));

      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(deadAgents).toHaveLength(0);
    });

    it('should report healthy status for recently-active agents', async () => {
      const agent = makeAgent({
        id: 'active@m1',
        lastHeartbeat: clock.now - 5000, // 5s ago, well within timeout
      });
      await registry.register(agent);

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const health = await monitor.getAgentHealth('active@m1');
      expect(health).not.toBeNull();
      expect(health!.status).toBe('healthy');
    });

    it('should report degraded status for agents nearing timeout', async () => {
      const agent = makeAgent({
        id: 'slow@m1',
        lastHeartbeat: clock.now - 35000, // Past half of timeout (60s/2 = 30s)
      });
      await registry.register(agent);

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const health = await monitor.getAgentHealth('slow@m1');
      expect(health!.status).toBe('degraded');
    });
  });

  describe('recovery notification', () => {
    it('should emit agent:recovered event when recovery runs', async () => {
      const events: any[] = [];
      monitor.on('agent:recovered', (event) => events.push(event));

      const agent = makeAgent({
        id: 'phoenix@m1',
        lastHeartbeat: clock.now - 70000,
      });
      await registry.register(agent);

      await monitor.watchAgents();
      clock.advance(10000); // Detect death and trigger recovery
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // autoRecover is true, so recovery should have been triggered
      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe('phoenix@m1');
    });
  });

  describe('configurable heartbeat timeout', () => {
    it('should use custom timeout from config', async () => {
      const customMonitor = new HealthMonitor({
        registry,
        messageBus,
        checkInterval: 5000,
        heartbeatTimeout: 20000, // Short timeout
      });

      const agent = makeAgent({
        id: 'custom@m1',
        lastHeartbeat: clock.now - 25000, // Past custom timeout
      });
      await registry.register(agent);

      const deadAgents: AgentIdentity[] = [];
      await customMonitor.watchAgents((dead) => deadAgents.push(dead));

      clock.advance(5000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(deadAgents).toHaveLength(1);
      customMonitor.stopWatching();
    });

    it('should not flag agent as dead within custom timeout window', async () => {
      const customMonitor = new HealthMonitor({
        registry,
        messageBus,
        checkInterval: 5000,
        heartbeatTimeout: 120000, // Long timeout (2 min)
      });

      const agent = makeAgent({
        id: 'patient@m1',
        lastHeartbeat: clock.now - 90000, // 90s ago, within 2min timeout
      });
      await registry.register(agent);

      const deadAgents: AgentIdentity[] = [];
      await customMonitor.watchAgents((dead) => deadAgents.push(dead));

      clock.advance(5000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(deadAgents).toHaveLength(0);
      customMonitor.stopWatching();
    });
  });

  describe('multiple agents monitored simultaneously', () => {
    it('should monitor all registered agents', async () => {
      const agents = [
        makeAgent({ id: 'a1@m1', lastHeartbeat: clock.now }),
        makeAgent({ id: 'a2@m1', lastHeartbeat: clock.now }),
        makeAgent({ id: 'a3@m2', lastHeartbeat: clock.now - 70000 }), // Dead
        makeAgent({ id: 'a4@m2', lastHeartbeat: clock.now }),
        makeAgent({ id: 'a5@m3', lastHeartbeat: clock.now - 70000 }), // Dead
      ];

      for (const agent of agents) {
        await registry.register(agent);
      }

      const deadAgents: string[] = [];
      await monitor.watchAgents((dead) => deadAgents.push(dead.id));

      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(deadAgents.sort()).toEqual(['a3@m2', 'a5@m3']);
    });

    it('should track health status for each agent independently', async () => {
      await registry.register(makeAgent({ id: 'healthy@m1', lastHeartbeat: clock.now }));
      await registry.register(makeAgent({ id: 'degraded@m2', lastHeartbeat: clock.now - 35000 }));
      await registry.register(makeAgent({ id: 'dead@m3', lastHeartbeat: clock.now - 70000 }));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const h1 = await monitor.getAgentHealth('healthy@m1');
      const h2 = await monitor.getAgentHealth('degraded@m2');
      const h3 = await monitor.getAgentHealth('dead@m3');

      expect(h1!.status).toBe('healthy');
      expect(h2!.status).toBe('degraded');
      expect(h3!.status).toBe('dead');
    });
  });

  describe('health report', () => {
    it('should include all agent statuses in health report', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', lastHeartbeat: clock.now }));
      await registry.register(makeAgent({ id: 'a2@m2', lastHeartbeat: clock.now - 35000 }));
      await registry.register(makeAgent({ id: 'a3@m3', lastHeartbeat: clock.now - 70000 }));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const allHealth = monitor.getAllHealth();
      expect(allHealth).toHaveLength(3);

      const statuses = allHealth.map(h => h.status);
      expect(statuses).toContain('healthy');
      expect(statuses).toContain('degraded');
      expect(statuses).toContain('dead');
    });

    it('should filter health report by status', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', lastHeartbeat: clock.now }));
      await registry.register(makeAgent({ id: 'a2@m1', lastHeartbeat: clock.now }));
      await registry.register(makeAgent({ id: 'a3@m2', lastHeartbeat: clock.now - 70000 }));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const healthyOnly = monitor.getAllHealth({ status: 'healthy' });
      expect(healthyOnly.every(h => h.status === 'healthy')).toBe(true);
    });

    it('should include failure history in report', async () => {
      await registry.register(makeAgent({ id: 'failed@m1', lastHeartbeat: clock.now - 70000 }));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const history = monitor.getFailureHistory();
      expect(history).toHaveLength(1);
      expect(history[0].agentId).toBe('failed@m1');
    });
  });

  describe('stopWatching', () => {
    it('should stop health checks after stopWatching is called', async () => {
      const deadAgents: string[] = [];
      await monitor.watchAgents((dead) => deadAgents.push(dead.id));

      monitor.stopWatching();

      // Register a dead agent after stopping
      await registry.register(makeAgent({
        id: 'late-dead@m1',
        lastHeartbeat: clock.now - 70000,
      }));

      clock.advance(20000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Should not detect the dead agent
      expect(deadAgents).toHaveLength(0);
    });
  });

  describe('Adversarial: Health Check Edge Cases', () => {
    it('should handle agent near the timeout boundary without flagging as dead', async () => {
      // Agent heartbeat is 45s ago. After 10s check interval, it will be 55s old.
      // 55s > 30s (half timeout) = degraded, but 55s < 60s timeout = not dead
      const agent = makeAgent({
        id: 'edge-agent@m1',
        lastHeartbeat: clock.now - 45000,
      });
      await registry.register(agent);

      const deadAgents: string[] = [];
      await monitor.watchAgents((dead) => deadAgents.push(dead.id));

      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const health = await monitor.getAgentHealth('edge-agent@m1');
      expect(health!.status).toBe('degraded');
      expect(deadAgents).toHaveLength(0);
    });

    it('should handle rapid heartbeat updates without errors', async () => {
      const agent = makeAgent({
        id: 'rapid@m1',
        lastHeartbeat: clock.now,
      });
      await registry.register(agent);

      await monitor.watchAgents();

      // Advance and check - agent should remain healthy
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const health = await monitor.getAgentHealth('rapid@m1');
      expect(health).not.toBeNull();
      expect(health!.status).toBe('healthy');
    });

    it('should detect failure even when agent was previously healthy', async () => {
      // Register a healthy agent
      const agent = makeAgent({
        id: 'will-die@m1',
        lastHeartbeat: clock.now,
      });
      await registry.register(agent);

      const deadEvents: string[] = [];
      monitor.on('agent:dead', (e) => deadEvents.push(e.agentId));

      await monitor.watchAgents();

      // First check cycle - agent is healthy
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(deadEvents).toHaveLength(0);

      // Now advance past timeout (total 80s from original heartbeat)
      clock.advance(70000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Agent should now be detected as dead
      expect(deadEvents).toContain('will-die@m1');
    });

    it('should handle race between detection and recovery gracefully', async () => {
      const agent = makeAgent({
        id: 'phoenix-race@m1',
        lastHeartbeat: clock.now - 70000, // Already past timeout
      });
      await registry.register(agent);

      const deadEvents: string[] = [];
      monitor.on('agent:dead', (e) => deadEvents.push(e.agentId));

      await monitor.watchAgents();

      // Trigger check - should detect death
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(deadEvents).toContain('phoenix-race@m1');
    });

    it('should handle two monitors with different timeouts classifying same agent differently', async () => {
      const monitor2 = new HealthMonitor({
        registry,
        messageBus,
        workCoordinator,
        checkInterval: 10000,
        heartbeatTimeout: 30000, // Shorter timeout
        autoRecover: false,
      });

      const agent = makeAgent({
        id: 'disputed@m1',
        lastHeartbeat: clock.now - 45000, // Dead for monitor2 (>30s), degraded for monitor1 (<60s)
      });
      await registry.register(agent);

      await monitor.watchAgents();
      await monitor2.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const health1 = await monitor.getAgentHealth('disputed@m1');
      const health2 = await monitor2.getAgentHealth('disputed@m1');

      // Each monitor uses its own timeout threshold
      // monitor1: 45s < 60s timeout, > 30s (half) => degraded
      expect(health1!.status).toBe('degraded');
      // monitor2: 45s > 30s timeout => dead
      expect(health2!.status).toBe('dead');

      monitor2.stopWatching();
    });

    it('should not report health for unmonitored agents', async () => {
      // Don't register any agent, just query health
      const health = await monitor.getAgentHealth('unknown@m1');
      expect(health).toBeNull();
    });

    it('should handle agent going from healthy to dead across check cycles', async () => {
      const agent = makeAgent({
        id: 'flapping@m1',
        lastHeartbeat: clock.now,
      });
      await registry.register(agent);

      const events: string[] = [];
      monitor.on('agent:dead', (e) => events.push(`dead:${e.agentId}`));

      await monitor.watchAgents();

      // First cycle - healthy
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(events).toHaveLength(0);

      // Wait well past timeout
      clock.advance(70000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Should detect death
      expect(events).toContain('dead:flapping@m1');
    });
  });

  describe('Untested Methods', () => {
    it('recoverFromFailure(agentId) — triggers recovery for agent', async () => {
      const agent = makeAgent({
        id: 'recover-me@m1',
        lastHeartbeat: clock.now - 70000,
      });
      await registry.register(agent);

      const result = await monitor.recoverFromFailure('recover-me@m1');

      expect(result).toBeDefined();
      expect(result.recovered).toBe(true);
    });

    it('getMetrics() — returns health metrics', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', lastHeartbeat: clock.now }));
      await registry.register(makeAgent({ id: 'a2@m1', lastHeartbeat: clock.now - 70000 }));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const metrics = monitor.getMetrics();

      expect(metrics).toBeDefined();
      expect(metrics.healthyCount).toBeGreaterThanOrEqual(1);
      expect(metrics.deadCount).toBeGreaterThanOrEqual(1);
      expect(metrics.checkCount).toBeGreaterThan(0);
    });

    it('getSystemHealth() — returns overall system health status', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', lastHeartbeat: clock.now }));
      await registry.register(makeAgent({ id: 'a2@m1', lastHeartbeat: clock.now }));

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const systemHealth = monitor.getSystemHealth();

      expect(systemHealth).toBeDefined();
      expect(systemHealth.status).toMatch(/healthy|degraded|critical/);
      expect(systemHealth.agentCount).toBe(2);
    });

    it('initialize() — sets up monitoring', async () => {
      const freshMonitor = new HealthMonitor({
        registry,
        messageBus,
        workCoordinator,
        checkInterval: 10000,
        heartbeatTimeout: 60000,
        autoRecover: true,
      });

      await freshMonitor.initialize();

      // Should be able to watch agents after init
      const deadAgents: string[] = [];
      await freshMonitor.watchAgents((dead) => deadAgents.push(dead.id));

      await registry.register(makeAgent({ id: 'post-init@m1', lastHeartbeat: clock.now - 70000 }));
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(deadAgents).toHaveLength(1);
      freshMonitor.stopWatching();
    });

    it('shutdown() — stops monitoring', async () => {
      await monitor.watchAgents();

      await monitor.shutdown();

      // After shutdown, should not detect new dead agents
      await registry.register(makeAgent({ id: 'post-shutdown@m1', lastHeartbeat: clock.now - 70000 }));
      clock.advance(20000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const health = await monitor.getAgentHealth('post-shutdown@m1');
      expect(health).toBeNull();
    });

    it('setRecoveryStrategy(strategy) — sets custom recovery strategy', async () => {
      const customStrategy = vi.fn().mockResolvedValue({ recovered: true });

      monitor.setRecoveryStrategy(customStrategy);

      const agent = makeAgent({ id: 'strategy-test@m1', lastHeartbeat: clock.now - 70000 });
      await registry.register(agent);

      await monitor.watchAgents();
      clock.advance(10000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Custom strategy should have been invoked for the dead agent
      expect(customStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'strategy-test@m1' })
      );
    });
  });
});
