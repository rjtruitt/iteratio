import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { AgentRegistry, AgentIdentity, resetSharedBackends } from '../AgentRegistry';

describe('AgentRegistry', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let registry: AgentRegistry;

  const makeAgent = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({
    id: overrides.id ?? 'worker_abc123@machine1.local',
    role: overrides.role ?? 'worker',
    children: overrides.children ?? [],
    machineId: overrides.machineId ?? 'machine1',
    hostname: overrides.hostname ?? 'machine1.local',
    pid: overrides.pid ?? 1234,
    llmProvider: overrides.llmProvider ?? 'anthropic',
    llmModel: overrides.llmModel ?? 'claude-4',
    capabilities: overrides.capabilities ?? ['code', 'analysis'],
    status: overrides.status ?? 'idle',
    lastHeartbeat: overrides.lastHeartbeat ?? Date.now(),
    createdAt: overrides.createdAt ?? Date.now(),
    endpoints: overrides.endpoints ?? {},
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
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('register', () => {
    it('should store agent identity in backend', async () => {
      const agent = makeAgent();
      await registry.register(agent);

      const retrieved = await registry.get(agent.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(agent.id);
    });

    it('should store all metadata fields', async () => {
      const agent = makeAgent({
        capabilities: ['code', 'analysis', 'research'],
        llmProvider: 'openai',
        llmModel: 'gpt-4',
        metadata: { region: 'us-east-1' },
      });

      await registry.register(agent);

      const retrieved = await registry.get(agent.id);
      expect(retrieved!.capabilities).toEqual(['code', 'analysis', 'research']);
      expect(retrieved!.llmProvider).toBe('openai');
      expect(retrieved!.llmModel).toBe('gpt-4');
      expect(retrieved!.metadata).toEqual({ region: 'us-east-1' });
    });

    it('should reject duplicate agent ID', async () => {
      const agent = makeAgent({ id: 'worker_dup@machine1' });
      await registry.register(agent);

      await expect(
        registry.register(makeAgent({ id: 'worker_dup@machine1' }))
      ).rejects.toThrow();
    });

    it('should store with TTL so entry auto-expires', async () => {
      const agent = makeAgent();
      await registry.register(agent);

      // Advance past TTL (default 30000ms + grace)
      clock.advance(65000);

      const retrieved = await registry.get(agent.id);
      expect(retrieved).toBeNull();
    });

    it('should emit agent:registered event', async () => {
      const events: any[] = [];
      registry.on('agent:registered', (data) => events.push(data));

      const agent = makeAgent();
      await registry.register(agent);

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(agent.id);
    });

    it('should start heartbeat mechanism after registration', async () => {
      const agent = makeAgent();
      await registry.register(agent);

      // Advance time but less than TTL — heartbeat should keep alive
      clock.advance(25000);
      // Let async heartbeat callback complete
      for (let i = 0; i < 10; i++) await Promise.resolve();

      const retrieved = await registry.get(agent.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.lastHeartbeat).toBeGreaterThan(agent.lastHeartbeat);
    });
  });

  describe('unregister / deregister', () => {
    it('should remove agent from backend', async () => {
      const agent = makeAgent();
      await registry.register(agent);
      await registry.unregister(agent.id);

      const retrieved = await registry.get(agent.id);
      expect(retrieved).toBeNull();
    });

    it('should stop heartbeat on unregister', async () => {
      const agent = makeAgent();
      await registry.register(agent);
      await registry.unregister(agent.id);

      // Heartbeat should have stopped, so re-register should work
      const newAgent = makeAgent({ id: agent.id });
      await registry.register(newAgent);

      const retrieved = await registry.get(agent.id);
      expect(retrieved).not.toBeNull();
    });

    it('should emit agent:unregistered event', async () => {
      const events: string[] = [];
      registry.on('agent:unregistered', (id) => events.push(id));

      const agent = makeAgent();
      await registry.register(agent);
      await registry.unregister(agent.id);

      expect(events).toContain(agent.id);
    });

    it('should handle unregister of non-existent agent gracefully', async () => {
      await expect(
        registry.unregister('nonexistent_agent@nowhere')
      ).resolves.not.toThrow();
    });
  });

  describe('discover', () => {
    it('should return all registered agents with empty query', async () => {
      const a1 = makeAgent({ id: 'worker_1@m1' });
      const a2 = makeAgent({ id: 'worker_2@m2' });
      const a3 = makeAgent({ id: 'orchestrator_1@m1', role: 'orchestrator' });

      await registry.register(a1);
      await registry.register(a2);
      await registry.register(a3);

      const agents = await registry.discover();
      expect(agents).toHaveLength(3);
    });

    it('should filter by role', async () => {
      await registry.register(makeAgent({ id: 'w1@m1', role: 'worker' }));
      await registry.register(makeAgent({ id: 'o1@m1', role: 'orchestrator' }));
      await registry.register(makeAgent({ id: 'w2@m2', role: 'worker' }));

      const workers = await registry.discover({ role: 'worker' });
      expect(workers).toHaveLength(2);
      expect(workers.every(a => a.role === 'worker')).toBe(true);
    });

    it('should filter by capability', async () => {
      await registry.register(makeAgent({
        id: 'a1@m1',
        capabilities: ['code', 'analysis'],
      }));
      await registry.register(makeAgent({
        id: 'a2@m1',
        capabilities: ['research', 'writing'],
      }));
      await registry.register(makeAgent({
        id: 'a3@m2',
        capabilities: ['code', 'writing'],
      }));

      const codeCapable = await registry.discover({ capability: 'code' });
      expect(codeCapable).toHaveLength(2);
      expect(codeCapable.map(a => a.id).sort()).toEqual(['a1@m1', 'a3@m2']);
    });

    it('should filter by LLM provider', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', llmProvider: 'anthropic' }));
      await registry.register(makeAgent({ id: 'a2@m1', llmProvider: 'openai' }));

      const anthropicAgents = await registry.discover({ llmProvider: 'anthropic' });
      expect(anthropicAgents).toHaveLength(1);
      expect(anthropicAgents[0].id).toBe('a1@m1');
    });

    it('should filter by machine ID', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', machineId: 'machine1' }));
      await registry.register(makeAgent({ id: 'a2@m2', machineId: 'machine2' }));

      const m1Agents = await registry.discover({ machineId: 'machine1' });
      expect(m1Agents).toHaveLength(1);
      expect(m1Agents[0].id).toBe('a1@m1');
    });

    it('should filter by status', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', status: 'idle' }));
      await registry.register(makeAgent({ id: 'a2@m1', status: 'running' }));

      const idleAgents = await registry.discover({ status: 'idle' });
      expect(idleAgents).toHaveLength(1);
      expect(idleAgents[0].id).toBe('a1@m1');
    });

    it('should return empty array when no agents match', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', role: 'worker' }));

      const result = await registry.discover({ role: 'overseer' });
      expect(result).toEqual([]);
    });
  });

  describe('heartbeat', () => {
    it('should update lastHeartbeat timestamp', async () => {
      const agent = makeAgent({ lastHeartbeat: 1000000 });
      await registry.register(agent);

      clock.advance(15100);
      // Let async heartbeat callback complete
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // Heartbeat should have fired (interval = ttl/2 = 15000)
      const retrieved = await registry.get(agent.id);
      expect(retrieved!.lastHeartbeat).toBeGreaterThan(1000000);
    });

    it('should refresh TTL on each heartbeat', async () => {
      const agent = makeAgent();
      await registry.register(agent);

      // Advance past original TTL but heartbeat should have refreshed
      clock.advance(25000);
      const still = await registry.get(agent.id);
      expect(still).not.toBeNull();

      clock.advance(25000);
      const stillAlive = await registry.get(agent.id);
      expect(stillAlive).not.toBeNull();
    });
  });

  describe('stale agent detection', () => {
    it('should detect agent as stale after missed heartbeats', async () => {
      const agent = makeAgent({ lastHeartbeat: clock.now });
      await registry.register(agent);

      // Simulate the agent's heartbeat stopping (agent crashed).
      // We unregister then re-register WITHOUT heartbeat to simulate an
      // entry that still exists but has a stale lastHeartbeat.
      await registry.unregister(agent.id);
      // Manually insert a stale entry (old lastHeartbeat, no active heartbeat)
      const staleAgent = { ...agent, lastHeartbeat: clock.now };
      // @ts-ignore - access private backend for test setup
      await (registry as any).backend.set(
        `agents/${agent.id}`,
        JSON.stringify(staleAgent),
        { ttl: 120000 } // long TTL so it doesn't auto-expire from store
      );

      // Advance past the death threshold (TTL * 2 = 60000)
      clock.advance(65000);

      const callback = vi.fn();
      await registry.watchHealth(callback);

      // Force a health check cycle (healthCheckInterval = TTL = 30000)
      clock.advance(30100);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ id: agent.id })
      );
    });

    it('should auto-cleanup stale agents', async () => {
      const agent = makeAgent({ lastHeartbeat: clock.now });
      await registry.register(agent);

      // Simulate death by advancing past TTL without heartbeat
      clock.advance(65000);

      await registry.watchHealth(vi.fn());
      clock.advance(30000);

      // Agent should be removed
      const retrieved = await registry.get(agent.id);
      expect(retrieved).toBeNull();
    });

    it('should not flag healthy agents as stale', async () => {
      const agent = makeAgent({ lastHeartbeat: clock.now });
      await registry.register(agent);

      const callback = vi.fn();
      await registry.watchHealth(callback);

      // Advance less than timeout — heartbeat keeps it alive
      clock.advance(20000);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('multiple agents', () => {
    it('should register multiple agents from different machines', async () => {
      const agents = [
        makeAgent({ id: 'w1@m1', machineId: 'machine1' }),
        makeAgent({ id: 'w2@m2', machineId: 'machine2' }),
        makeAgent({ id: 'w3@m3', machineId: 'machine3' }),
      ];

      for (const agent of agents) {
        await registry.register(agent);
      }

      const all = await registry.discover();
      expect(all).toHaveLength(3);
    });

    it('should handle agents with different roles on same machine', async () => {
      await registry.register(makeAgent({ id: 'overseer_1@m1', role: 'overseer', machineId: 'machine1' }));
      await registry.register(makeAgent({ id: 'worker_1@m1', role: 'worker', machineId: 'machine1' }));
      await registry.register(makeAgent({ id: 'worker_2@m1', role: 'worker', machineId: 'machine1' }));

      const m1Agents = await registry.discover({ machineId: 'machine1' });
      expect(m1Agents).toHaveLength(3);
    });
  });

  describe('Edge Cases', () => {
    it('should reject register agent with empty id', async () => {
      const agent = makeAgent({ id: '' });
      await expect(registry.register(agent)).rejects.toThrow();
    });

    it('should handle register agent with null capabilities', async () => {
      const agent = makeAgent({ id: 'null-caps@m1', capabilities: null as any });
      await registry.register(agent);

      const retrieved = await registry.get('null-caps@m1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.capabilities).toBeNull();
    });

    it('should handle register agent with empty capabilities array', async () => {
      const agent = makeAgent({ id: 'empty-caps@m1', capabilities: [] });
      await registry.register(agent);

      const retrieved = await registry.get('empty-caps@m1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.capabilities).toEqual([]);
    });

    it('should handle deregister agent that does not exist', async () => {
      // Should not throw but should be a no-op
      await expect(
        registry.unregister('totally-nonexistent@nowhere')
      ).resolves.not.toThrow();

      // Verify no side-effects
      const all = await registry.discover();
      expect(all).toHaveLength(0);
    });

    it('should handle discover with filter matching no agents', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', role: 'worker' }));
      await registry.register(makeAgent({ id: 'a2@m2', role: 'worker' }));

      const result = await registry.discover({ role: 'nonexistent-role' });
      expect(result).toEqual([]);
    });

    it('should handle discover with filter matching all agents', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', role: 'worker', status: 'idle' }));
      await registry.register(makeAgent({ id: 'a2@m2', role: 'worker', status: 'idle' }));
      await registry.register(makeAgent({ id: 'a3@m3', role: 'worker', status: 'idle' }));

      const result = await registry.discover({ role: 'worker' });
      expect(result).toHaveLength(3);
    });

    it('should handle register 1000 agents simultaneously', async () => {
      const agents = Array.from({ length: 1000 }, (_, i) =>
        makeAgent({ id: `agent-${i}@m${i % 10}`, machineId: `machine${i % 10}` })
      );

      await Promise.all(agents.map(a => registry.register(a)));

      const all = await registry.discover();
      expect(all).toHaveLength(1000);
    });

    it('should handle heartbeat for agent that was deregistered', async () => {
      const agent = makeAgent({ id: 'doomed@m1' });
      await registry.register(agent);
      await registry.unregister('doomed@m1');

      // Heartbeat for a deregistered agent should not resurrect it
      clock.advance(15000);

      const retrieved = await registry.get('doomed@m1');
      expect(retrieved).toBeNull();
    });

    it('should handle agent metadata with very large payload (1MB)', async () => {
      const largeMetadata = { data: 'x'.repeat(1024 * 1024) }; // 1MB string
      const agent = makeAgent({ id: 'large-meta@m1', metadata: largeMetadata } as any);
      await registry.register(agent);

      const retrieved = await registry.get('large-meta@m1');
      expect(retrieved).not.toBeNull();
      expect((retrieved as any).metadata.data.length).toBe(1024 * 1024);
    });

    it('should handle re-register an agent after deregistration (same id)', async () => {
      const agent = makeAgent({ id: 'comeback@m1', capabilities: ['code'] });
      await registry.register(agent);
      await registry.unregister('comeback@m1');

      // Re-register with updated capabilities
      const updatedAgent = makeAgent({ id: 'comeback@m1', capabilities: ['code', 'research'] });
      await registry.register(updatedAgent);

      const retrieved = await registry.get('comeback@m1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.capabilities).toEqual(['code', 'research']);
    });
  });

  describe('Untested Methods', () => {
    it('get(agentId) — returns single agent info', async () => {
      const agent = makeAgent({ id: 'getter@m1', role: 'worker' });
      await registry.register(agent);

      const result = await registry.get('getter@m1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('getter@m1');
      expect(result!.role).toBe('worker');
    });

    it('exists(agentId) — returns boolean', async () => {
      const agent = makeAgent({ id: 'exists-check@m1' });
      await registry.register(agent);

      const exists = await registry.exists('exists-check@m1');
      const notExists = await registry.exists('nonexistent@nowhere');

      expect(exists).toBe(true);
      expect(notExists).toBe(false);
    });

    it('updateStatus(agentId, status) — changes agent status', async () => {
      const agent = makeAgent({ id: 'status-update@m1', status: 'idle' });
      await registry.register(agent);

      await registry.updateStatus('status-update@m1', 'running');

      const retrieved = await registry.get('status-update@m1');
      expect(retrieved!.status).toBe('running');
    });

    it('updateMetadata(agentId, metadata) — updates agent metadata', async () => {
      const agent = makeAgent({ id: 'meta-update@m1' });
      await registry.register(agent);

      await registry.updateMetadata('meta-update@m1', { region: 'us-west-2', version: '2.0' });

      const retrieved = await registry.get('meta-update@m1');
      expect((retrieved as any).metadata).toEqual({ region: 'us-west-2', version: '2.0' });
    });

    it('watchHealth(callback) — subscribes to health changes', async () => {
      const callback = vi.fn();
      const agent = makeAgent({ id: 'health-watch@m1', lastHeartbeat: clock.now });
      await registry.register(agent);

      // Simulate dead agent: stop heartbeat and insert stale entry
      await registry.unregister(agent.id);
      const staleAgent = { ...agent, lastHeartbeat: clock.now };
      // @ts-ignore
      await (registry as any).backend.set(
        `agents/${agent.id}`,
        JSON.stringify(staleAgent),
        { ttl: 120000 }
      );

      await registry.watchHealth(callback);

      // Advance past death threshold (TTL*2 = 60000)
      clock.advance(65000);
      // Health check fires at healthCheckInterval (30000ms)
      clock.advance(30100);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(callback).toHaveBeenCalled();
    });

    it('stopHealthWatch() — unsubscribes from health', async () => {
      const callback = vi.fn();
      const agent = makeAgent({ id: 'stop-watch@m1', lastHeartbeat: clock.now });
      await registry.register(agent);

      await registry.watchHealth(callback);
      await registry.stopHealthWatch();

      clock.advance(65000);

      expect(callback).not.toHaveBeenCalled();
    });

    it('getStats() — returns registry statistics', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', role: 'worker' }));
      await registry.register(makeAgent({ id: 'a2@m1', role: 'orchestrator' }));
      await registry.register(makeAgent({ id: 'a3@m2', role: 'worker' }));

      const stats = await registry.getStats();

      expect(stats).toBeDefined();
      expect(stats.totalAgents).toBe(3);
      expect(stats.byRole.worker).toBe(2);
      expect(stats.byRole.orchestrator).toBe(1);
    });

    it('initialize() — sets up storage', async () => {
      const freshRegistry = new AgentRegistry({
        backend: 'redis',
        backendUrl: 'redis://localhost:6379',
        ttl: 30000,
      });

      await freshRegistry.initialize();

      const agent = makeAgent({ id: 'post-init@m1' });
      await freshRegistry.register(agent);
      const retrieved = await freshRegistry.get('post-init@m1');
      expect(retrieved).not.toBeNull();
    });

    it('shutdown() — cleanup', async () => {
      const agent = makeAgent({ id: 'pre-shutdown@m1' });
      await registry.register(agent);

      await registry.shutdown();

      // After shutdown, operations should fail
      await expect(
        registry.register(makeAgent({ id: 'post-shutdown@m1' }))
      ).rejects.toThrow();
    });

    it('setMessageBus(bus) — injects message bus dependency', async () => {
      const mockBus = { publish: vi.fn(), subscribe: vi.fn() };

      registry.setMessageBus(mockBus as any);

      // Register an agent — should trigger a message on the bus
      const agent = makeAgent({ id: 'bus-test@m1' });
      await registry.register(agent);

      expect(mockBus.publish).toHaveBeenCalled();
    });
  });
});
