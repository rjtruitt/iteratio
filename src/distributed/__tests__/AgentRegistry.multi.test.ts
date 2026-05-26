import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { TestScheduler } from '../../__test__/TestScheduler';
import { AgentRegistry, AgentIdentity, resetSharedBackends } from '../AgentRegistry';

describe('AgentRegistry — Multi-Machine Scenarios', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let registryMachine1: AgentRegistry;
  let registryMachine2: AgentRegistry;

  const makeAgent = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({
    id: overrides.id ?? 'worker_abc@machine1.local',
    role: overrides.role ?? 'worker',
    children: overrides.children ?? [],
    machineId: overrides.machineId ?? 'machine1',
    hostname: overrides.hostname ?? 'machine1.local',
    pid: overrides.pid ?? 1234,
    llmProvider: overrides.llmProvider ?? 'anthropic',
    llmModel: overrides.llmModel ?? 'claude-4',
    capabilities: overrides.capabilities ?? ['code'],
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

    // Two registries share same Redis (simulating distributed access)
    registryMachine1 = new AgentRegistry({
      backend: 'redis',
      backendUrl: 'redis://localhost:6379',
      ttl: 30000,
    });
    registryMachine2 = new AgentRegistry({
      backend: 'redis',
      backendUrl: 'redis://localhost:6379',
      ttl: 30000,
    });
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('cross-machine visibility', () => {
    it('should make agent registered on machine A visible from machine B', async () => {
      const agentOnM1 = makeAgent({
        id: 'worker_1@machine1',
        machineId: 'machine1',
      });

      await registryMachine1.register(agentOnM1);

      // Query from machine 2's registry
      const found = await registryMachine2.get('worker_1@machine1');
      expect(found).not.toBeNull();
      expect(found!.machineId).toBe('machine1');
    });

    it('should discover agents from all machines with empty query', async () => {
      await registryMachine1.register(makeAgent({
        id: 'w1@m1',
        machineId: 'machine1',
      }));
      await registryMachine2.register(makeAgent({
        id: 'w2@m2',
        machineId: 'machine2',
      }));

      // Either registry should see both
      const fromM1 = await registryMachine1.discover();
      const fromM2 = await registryMachine2.discover();

      expect(fromM1).toHaveLength(2);
      expect(fromM2).toHaveLength(2);
    });

    it('should discover agents by capability across machines', async () => {
      await registryMachine1.register(makeAgent({
        id: 'coder@m1',
        machineId: 'machine1',
        capabilities: ['code', 'debug'],
      }));
      await registryMachine2.register(makeAgent({
        id: 'researcher@m2',
        machineId: 'machine2',
        capabilities: ['research', 'analysis'],
      }));

      const coders = await registryMachine2.discover({ capability: 'code' });
      expect(coders).toHaveLength(1);
      expect(coders[0].machineId).toBe('machine1');
    });

    it('should see agents disappear when unregistered from another machine', async () => {
      await registryMachine1.register(makeAgent({
        id: 'ephemeral@m1',
        machineId: 'machine1',
      }));

      // Visible from machine 2
      let found = await registryMachine2.get('ephemeral@m1');
      expect(found).not.toBeNull();

      // Unregister from machine 1
      await registryMachine1.unregister('ephemeral@m1');

      // No longer visible from machine 2
      found = await registryMachine2.get('ephemeral@m1');
      expect(found).toBeNull();
    });
  });

  describe('namespace isolation', () => {
    it('should isolate agents in different namespace/pool prefixes', async () => {
      // Different URLs create separate backends (simulating separate Redis instances)
      const poolA = new AgentRegistry({
        backend: 'redis',
        backendUrl: 'redis://pool-a:6379',
        ttl: 30000,
      });
      const poolB = new AgentRegistry({
        backend: 'redis',
        backendUrl: 'redis://pool-b:6379',
        ttl: 30000,
      });

      await poolA.register(makeAgent({ id: 'agent_in_A@m1' }));
      await poolB.register(makeAgent({ id: 'agent_in_B@m2' }));

      const fromA = await poolA.discover();
      const fromB = await poolB.discover();

      // Each pool should only see its own agents
      expect(fromA).toHaveLength(1);
      expect(fromA[0].id).toBe('agent_in_A@m1');
      expect(fromB).toHaveLength(1);
      expect(fromB[0].id).toBe('agent_in_B@m2');
    });

    it('should not allow cross-pool agent lookup', async () => {
      // Different URLs create separate backends
      const poolA = new AgentRegistry({
        backend: 'redis',
        backendUrl: 'redis://pool-a2:6379',
        ttl: 30000,
      });
      const poolB = new AgentRegistry({
        backend: 'redis',
        backendUrl: 'redis://pool-b2:6379',
        ttl: 30000,
      });

      await poolA.register(makeAgent({ id: 'private_agent@m1' }));

      const fromB = await poolB.get('private_agent@m1');
      expect(fromB).toBeNull();
    });
  });

  describe('cross-machine discovery', () => {
    it('should find agent on machine B when querying from machine A', async () => {
      await registryMachine2.register(makeAgent({
        id: 'specialist@m2',
        machineId: 'machine2',
        capabilities: ['gpu-compute'],
        llmProvider: 'local',
      }));

      const result = await registryMachine1.discover({
        capability: 'gpu-compute',
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('specialist@m2');
      expect(result[0].machineId).toBe('machine2');
    });

    it('should handle discovery when multiple machines have matching agents', async () => {
      await registryMachine1.register(makeAgent({
        id: 'w1@m1',
        machineId: 'machine1',
        role: 'worker',
      }));
      await registryMachine1.register(makeAgent({
        id: 'w2@m1',
        machineId: 'machine1',
        role: 'worker',
      }));
      await registryMachine2.register(makeAgent({
        id: 'w3@m2',
        machineId: 'machine2',
        role: 'worker',
      }));

      const workers = await registryMachine1.discover({ role: 'worker' });
      expect(workers).toHaveLength(3);

      const machines = new Set(workers.map(w => w.machineId));
      expect(machines.size).toBe(2);
    });

    it('should return agent endpoints for cross-machine communication', async () => {
      await registryMachine2.register(makeAgent({
        id: 'remote@m2',
        machineId: 'machine2',
        endpoints: {
          rpc: 'grpc://machine2:50051',
          ws: 'ws://machine2:8080',
          http: 'http://machine2:3000',
        },
      }));

      const found = await registryMachine1.get('remote@m2');
      expect(found!.endpoints.rpc).toBe('grpc://machine2:50051');
      expect(found!.endpoints.ws).toBe('ws://machine2:8080');
      expect(found!.endpoints.http).toBe('http://machine2:3000');
    });
  });

  describe('race conditions', () => {
    it('should handle two agents registering same ID simultaneously', async () => {
      const scheduler = new TestScheduler();

      const agent1 = makeAgent({ id: 'contested@m1', machineId: 'machine1' });
      const agent2 = makeAgent({ id: 'contested@m1', machineId: 'machine2' });

      // Both attempt registration concurrently
      const reg1 = registryMachine1.register(agent1);
      const reg2 = registryMachine2.register(agent2);

      const results = await Promise.allSettled([reg1, reg2]);

      // Exactly one should succeed, one should fail
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
    });

    it('should handle concurrent register and unregister of same agent', async () => {
      const agent = makeAgent({ id: 'flickering@m1' });
      await registryMachine1.register(agent);

      // Machine 1 unregisters while machine 2 tries to look it up
      const unreg = registryMachine1.unregister(agent.id);
      const lookup = registryMachine2.get(agent.id);

      await unreg;
      const result = await lookup;

      // Result should be either the agent or null — no crash
      expect(result === null || result.id === agent.id).toBe(true);
    });

    it('should handle concurrent discovery during registration churn', async () => {
      // Register several agents
      for (let i = 0; i < 5; i++) {
        await registryMachine1.register(makeAgent({
          id: `agent_${i}@m1`,
          machineId: 'machine1',
        }));
      }

      // Concurrent: unregister some + discover
      const unreg = registryMachine1.unregister('agent_2@m1');
      const discover = registryMachine2.discover();

      await unreg;
      const agents = await discover;

      // Should return between 4 and 5 agents (depending on timing)
      expect(agents.length).toBeGreaterThanOrEqual(4);
      expect(agents.length).toBeLessThanOrEqual(5);
    });

    it('should maintain consistency when heartbeat races with unregister', async () => {
      const agent = makeAgent({ id: 'dying@m1' });
      await registryMachine1.register(agent);

      // Advance time so heartbeat fires
      clock.advance(16000);

      // Unregister while heartbeat may be in flight
      await registryMachine1.unregister(agent.id);

      // Agent should be gone
      const found = await registryMachine2.get(agent.id);
      expect(found).toBeNull();
    });
  });

  describe('Scalability and Consistency', () => {
    it('should handle registering many agents without error', async () => {
      // Register 100 agents
      for (let i = 0; i < 100; i++) {
        await registryMachine1.register(makeAgent({
          id: `batch-agent-${i}@m1`,
          machineId: 'machine1',
        }));
      }

      const all = await registryMachine1.discover();
      expect(all).toHaveLength(100);
    });

    it('should handle agent with many capabilities', async () => {
      const capabilities = Array.from({ length: 50 }, (_, i) => `capability-${i}`);
      const agent = makeAgent({
        id: 'capable@m1',
        capabilities,
      });

      await registryMachine1.register(agent);

      const found = await registryMachine2.get('capable@m1');
      expect(found).not.toBeNull();
      expect(found!.capabilities).toHaveLength(50);
    });

    it('should handle rapid register/unregister cycles without corruption', async () => {
      // Agent registers and unregisters rapidly
      for (let i = 0; i < 50; i++) {
        const agent = makeAgent({
          id: 'churner@m1',
          machineId: 'machine1',
          lastHeartbeat: Date.now() + i,
        });
        await registryMachine1.register(agent);
        await registryMachine1.unregister('churner@m1');
      }

      // After all cycles, agent should not exist
      const found = await registryMachine2.get('churner@m1');
      expect(found).toBeNull();
    });

    it('should maintain correct count during concurrent operations', async () => {
      // Register agents on both machines
      const ops = [];
      for (let i = 0; i < 10; i++) {
        ops.push(registryMachine1.register(makeAgent({
          id: `m1-agent-${i}@m1`,
          machineId: 'machine1',
        })));
        ops.push(registryMachine2.register(makeAgent({
          id: `m2-agent-${i}@m2`,
          machineId: 'machine2',
        })));
      }
      await Promise.all(ops);

      const all = await registryMachine1.discover();
      expect(all).toHaveLength(20);
    });

    it('should handle discovery with large result set efficiently', async () => {
      // Register 200 agents with common capability
      for (let i = 0; i < 200; i++) {
        await registryMachine1.register(makeAgent({
          id: `scannable-${i}@m1`,
          machineId: 'machine1',
          capabilities: ['common-cap'],
        }));
      }

      const results = await registryMachine2.discover({ capability: 'common-cap' });
      expect(results).toHaveLength(200);
    });

    it('should correctly expire stale entries after TTL', async () => {
      // Register agents
      for (let i = 0; i < 5; i++) {
        await registryMachine1.register(makeAgent({
          id: `stale-${i}@m1`,
          machineId: 'machine1',
          lastHeartbeat: Date.now(),
        }));
      }

      // Shut down machine1's registry to stop heartbeats refreshing TTL
      await registryMachine1.shutdown();

      // Advance past TTL (30000ms)
      clock.advance(31000);

      // Register fresh agents from machine2
      for (let i = 0; i < 3; i++) {
        await registryMachine2.register(makeAgent({
          id: `fresh-${i}@m2`,
          machineId: 'machine2',
          lastHeartbeat: Date.now(),
        }));
      }

      // Stale entries should have expired from backend TTL
      const all = await registryMachine2.discover();
      // Only fresh agents should be discoverable
      expect(all).toHaveLength(3);
      expect(all.every(a => a.id.startsWith('fresh-'))).toBe(true);
    });

    it('should handle getStats across multiple machines', async () => {
      await registryMachine1.register(makeAgent({
        id: 'w1@m1', machineId: 'machine1', role: 'worker',
      }));
      await registryMachine2.register(makeAgent({
        id: 'w2@m2', machineId: 'machine2', role: 'worker',
      }));
      await registryMachine1.register(makeAgent({
        id: 'o1@m1', machineId: 'machine1', role: 'orchestrator',
      }));

      const stats = await registryMachine1.getStats();
      expect(stats.totalAgents).toBe(3);
      expect(stats.byRole['worker']).toBe(2);
      expect(stats.byRole['orchestrator']).toBe(1);
      expect(stats.byMachine['machine1']).toBe(2);
      expect(stats.byMachine['machine2']).toBe(1);
    });
  });
});
