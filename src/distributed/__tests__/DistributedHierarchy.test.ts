import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { DistributedHierarchy } from '../DistributedHierarchy';
import { AgentRegistry, AgentIdentity, resetSharedBackends } from '../AgentRegistry';

describe('DistributedHierarchy', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let registry: AgentRegistry;
  let hierarchy: DistributedHierarchy;

  const makeAgent = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({
    id: overrides.id ?? 'agent_1@m1',
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
    lastHeartbeat: Date.now(),
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
      ttl: 300000,
    });

    hierarchy = new DistributedHierarchy({
      registry,
      stateStore: redis,
      messageBus: null,
    });
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('set parent-child relationship', () => {
    it('should establish parent-child relationship', async () => {
      const parent = makeAgent({ id: 'parent@m1', role: 'orchestrator', children: [] });
      await registry.register(parent);

      const result = await hierarchy.spawnChild('parent@m1', {
        role: 'worker',
        purpose: 'do work',
      });

      expect(result.childId).toBeDefined();
      expect(result.status).toMatch(/spawned|registered|ready/);
    });

    it('should store parentId on child agent', async () => {
      const parent = makeAgent({ id: 'parent@m1', role: 'orchestrator' });
      await registry.register(parent);

      const result = await hierarchy.spawnChild('parent@m1', {
        role: 'worker',
        purpose: 'compute',
      });

      const child = await registry.get(result.childId);
      expect(child).not.toBeNull();
      expect(child!.parentId).toBe('parent@m1');
    });

    it('should update parent children list when child is added', async () => {
      const parent = makeAgent({ id: 'parent@m1', role: 'orchestrator', children: [] });
      await registry.register(parent);

      const result = await hierarchy.spawnChild('parent@m1', {
        role: 'worker',
        purpose: 'work',
      });

      const updatedParent = await registry.get('parent@m1');
      expect(updatedParent!.children).toContain(result.childId);
    });
  });

  describe('getChildren', () => {
    it('should return all children of a parent', async () => {
      const parent = makeAgent({ id: 'parent@m1', role: 'orchestrator', children: ['c1@m1', 'c2@m2'] });
      const child1 = makeAgent({ id: 'c1@m1', parentId: 'parent@m1' });
      const child2 = makeAgent({ id: 'c2@m2', parentId: 'parent@m1', machineId: 'machine2' });

      await registry.register(parent);
      await registry.register(child1);
      await registry.register(child2);

      const children = await hierarchy.getChildren('parent@m1');
      expect(children).toHaveLength(2);
      expect(children.map(c => c.id).sort()).toEqual(['c1@m1', 'c2@m2']);
    });

    it('should return empty array when agent has no children', async () => {
      const leaf = makeAgent({ id: 'leaf@m1', children: [] });
      await registry.register(leaf);

      const children = await hierarchy.getChildren('leaf@m1');
      expect(children).toEqual([]);
    });

    it('should return children from multiple machines', async () => {
      const parent = makeAgent({ id: 'parent@m1', children: ['c1@m1', 'c2@m2', 'c3@m3'] });
      await registry.register(parent);
      await registry.register(makeAgent({ id: 'c1@m1', parentId: 'parent@m1', machineId: 'machine1' }));
      await registry.register(makeAgent({ id: 'c2@m2', parentId: 'parent@m1', machineId: 'machine2' }));
      await registry.register(makeAgent({ id: 'c3@m3', parentId: 'parent@m1', machineId: 'machine3' }));

      const children = await hierarchy.getChildren('parent@m1');
      const machines = new Set(children.map(c => c.machineId));
      expect(machines.size).toBe(3);
    });
  });

  describe('getParent', () => {
    it('should return parent of child', async () => {
      const parent = makeAgent({ id: 'parent@m1', role: 'orchestrator' });
      const child = makeAgent({ id: 'child@m2', parentId: 'parent@m1' });

      await registry.register(parent);
      await registry.register(child);

      const result = await hierarchy.getParent('child@m2');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('parent@m1');
    });

    it('should return null for root node (no parent)', async () => {
      const root = makeAgent({ id: 'root@m1', role: 'overseer' });
      await registry.register(root);

      const result = await hierarchy.getParent('root@m1');
      expect(result).toBeNull();
    });

    it('should return null for non-existent agent', async () => {
      const result = await hierarchy.getParent('nonexistent@m1');
      expect(result).toBeNull();
    });
  });

  describe('tree traversal (grandchildren)', () => {
    it('should build full hierarchy tree', async () => {
      // Root -> Orchestrator -> Workers
      await registry.register(makeAgent({ id: 'root@m1', role: 'overseer', children: ['orch@m1'] }));
      await registry.register(makeAgent({ id: 'orch@m1', role: 'orchestrator', parentId: 'root@m1', children: ['w1@m1', 'w2@m2'] }));
      await registry.register(makeAgent({ id: 'w1@m1', role: 'worker', parentId: 'orch@m1' }));
      await registry.register(makeAgent({ id: 'w2@m2', role: 'worker', parentId: 'orch@m1', machineId: 'machine2' }));

      const tree = await hierarchy.getTree('root@m1');

      expect(tree.agent.id).toBe('root@m1');
      expect(tree.depth).toBe(0);
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].agent.id).toBe('orch@m1');
      expect(tree.children[0].depth).toBe(1);
      expect(tree.children[0].children).toHaveLength(2);
    });

    it('should get all descendants', async () => {
      await registry.register(makeAgent({ id: 'root@m1', children: ['mid@m1'] }));
      await registry.register(makeAgent({ id: 'mid@m1', parentId: 'root@m1', children: ['leaf1@m2', 'leaf2@m2'] }));
      await registry.register(makeAgent({ id: 'leaf1@m2', parentId: 'mid@m1' }));
      await registry.register(makeAgent({ id: 'leaf2@m2', parentId: 'mid@m1' }));

      const descendants = await hierarchy.getDescendants('root@m1');
      expect(descendants).toHaveLength(3); // mid, leaf1, leaf2
      expect(descendants.map(d => d.id).sort()).toEqual(['leaf1@m2', 'leaf2@m2', 'mid@m1']);
    });

    it('should get path from root to leaf', async () => {
      await registry.register(makeAgent({ id: 'root@m1', children: ['mid@m1'] }));
      await registry.register(makeAgent({ id: 'mid@m1', parentId: 'root@m1', children: ['leaf@m2'] }));
      await registry.register(makeAgent({ id: 'leaf@m2', parentId: 'mid@m1' }));

      const path = await hierarchy.getPath('leaf@m2');
      expect(path.map(p => p.id)).toEqual(['root@m1', 'mid@m1', 'leaf@m2']);
    });
  });

  describe('orphan detection', () => {
    it('should detect orphans when parent is dead/missing', async () => {
      // Register children but parent is gone
      await registry.register(makeAgent({ id: 'orphan1@m1', parentId: 'dead-parent@m1' }));
      await registry.register(makeAgent({ id: 'orphan2@m2', parentId: 'dead-parent@m1' }));

      const orphans = await hierarchy.getChildren('dead-parent@m1');
      expect(orphans).toHaveLength(2);
    });

    it('should handle orphans via reassign strategy', async () => {
      const grandparent = makeAgent({ id: 'grandparent@m1', role: 'overseer', children: ['parent@m1'] });
      const parent = makeAgent({ id: 'parent@m1', role: 'orchestrator', parentId: 'grandparent@m1', children: ['orphan@m2'] });
      const child = makeAgent({ id: 'orphan@m2', role: 'worker', parentId: 'parent@m1' });

      await registry.register(grandparent);
      await registry.register(parent);
      await registry.register(child);

      // Handle orphans while parent still exists (has grandparent info)
      await hierarchy.handleOrphans('parent@m1', 'reassign');

      const updatedChild = await registry.get('orphan@m2');
      expect(updatedChild!.parentId).toBe('grandparent@m1');
    });
  });

  describe('re-parenting', () => {
    it('should move child to new parent via orphan reassignment', async () => {
      const oldParent = makeAgent({ id: 'old-parent@m1', parentId: 'grandparent@m1', children: ['child@m1'] });
      const grandparent = makeAgent({ id: 'grandparent@m1', children: ['old-parent@m1'] });
      const child = makeAgent({ id: 'child@m1', parentId: 'old-parent@m1' });

      await registry.register(grandparent);
      await registry.register(oldParent);
      await registry.register(child);

      // Re-parent via orphan handling
      await hierarchy.handleOrphans('old-parent@m1', 'reassign');

      const updatedChild = await registry.get('child@m1');
      // Child should have a new parent (grandparent)
      expect(updatedChild!.parentId).toBe('grandparent@m1');
    });
  });

  describe('root node', () => {
    it('should identify root as agent with no parent', async () => {
      await registry.register(makeAgent({ id: 'root@m1', role: 'overseer' }));
      await registry.register(makeAgent({ id: 'child@m1', parentId: 'root@m1' }));

      const parent = await hierarchy.getParent('root@m1');
      expect(parent).toBeNull();
    });

    it('should build tree correctly from root', async () => {
      await registry.register(makeAgent({ id: 'root@m1', children: ['a@m1'] }));
      await registry.register(makeAgent({ id: 'a@m1', parentId: 'root@m1' }));

      const tree = await hierarchy.getTree('root@m1');
      expect(tree.depth).toBe(0);
      expect(tree.agent.id).toBe('root@m1');
    });
  });

  describe('delete parent — children become orphans', () => {
    it('should leave children with stale parentId when parent is removed', async () => {
      await registry.register(makeAgent({ id: 'parent@m1', children: ['c1@m1', 'c2@m2'] }));
      await registry.register(makeAgent({ id: 'c1@m1', parentId: 'parent@m1' }));
      await registry.register(makeAgent({ id: 'c2@m2', parentId: 'parent@m1' }));

      await registry.unregister('parent@m1');

      const child1 = await registry.get('c1@m1');
      const child2 = await registry.get('c2@m2');

      // Children still reference dead parent
      expect(child1!.parentId).toBe('parent@m1');
      expect(child2!.parentId).toBe('parent@m1');

      // But parent doesn't exist
      const parent = await registry.get('parent@m1');
      expect(parent).toBeNull();
    });
  });

  describe('getSiblings', () => {
    it('should return other children of same parent', async () => {
      await registry.register(makeAgent({ id: 'parent@m1', children: ['a@m1', 'b@m1', 'c@m2'] }));
      await registry.register(makeAgent({ id: 'a@m1', parentId: 'parent@m1' }));
      await registry.register(makeAgent({ id: 'b@m1', parentId: 'parent@m1' }));
      await registry.register(makeAgent({ id: 'c@m2', parentId: 'parent@m1' }));

      const siblings = await hierarchy.getSiblings('a@m1');
      expect(siblings).toHaveLength(2);
      expect(siblings.map(s => s.id).sort()).toEqual(['b@m1', 'c@m2']);
    });

    it('should return empty array for only child', async () => {
      await registry.register(makeAgent({ id: 'parent@m1', children: ['only@m1'] }));
      await registry.register(makeAgent({ id: 'only@m1', parentId: 'parent@m1' }));

      const siblings = await hierarchy.getSiblings('only@m1');
      expect(siblings).toEqual([]);
    });
  });

  describe('Untested Methods', () => {
    it('spawnChildren(parentId, configs[]) — batch spawn', async () => {
      const parent = makeAgent({ id: 'batch-parent@m1', role: 'orchestrator', children: [] });
      await registry.register(parent);

      const configs: any[] = [
        { role: 'worker', purpose: 'task-1' },
        { role: 'worker', purpose: 'task-2' },
        { role: 'worker', purpose: 'task-3' },
      ];

      const results = await hierarchy.spawnChildren('batch-parent@m1', configs);

      expect(results).toHaveLength(3);
      for (const r of results) {
        expect((r as any).childId).toBeDefined();
        expect((r as any).status).toMatch(/spawned|registered|ready/);
      }
    });

    it('waitForRegistration(agentId, timeout) — finds already-registered agent', async () => {
      // Register agent first
      await registry.register(makeAgent({ id: 'already-here@m1' }));

      const registered = await hierarchy.waitForRegistration('already-here@m1', 5000);
      expect(registered).toBe(true);
    });

    it('selectMachine(criteria) — returns null when no machines cached', async () => {
      const selected = await hierarchy.selectMachine({});
      expect(selected).toBeNull();
    });

    it('getMachines() — returns empty when nothing cached', async () => {
      const machines = await hierarchy.getMachines();
      expect(machines).toHaveLength(0);
    });

    it('updateMachineInfo(machineId, info) — updates machine metadata', async () => {
      await hierarchy.updateMachineInfo('machine1', {
        cpuUsage: 0.45,
        memoryUsage: 0.60,
        agentCount: 3,
      });

      const machines = await hierarchy.getMachines();
      const m1 = machines.find((m: any) => m.machineId === 'machine1');
      expect(m1).toBeDefined();
      expect(m1!.cpuUsage).toBe(0.45);
    });

    it('startMachineUpdates() — begins periodic machine info updates', async () => {
      await registry.register(makeAgent({ id: 'a1@m1', machineId: 'machine1' }));

      await hierarchy.startMachineUpdates();

      // Initial update should have populated cache
      const machines = await hierarchy.getMachines();
      expect(machines.length).toBeGreaterThan(0);

      await hierarchy.stopMachineUpdates();
    });

    it('stopMachineUpdates() — stops updates', async () => {
      await hierarchy.startMachineUpdates();
      await hierarchy.stopMachineUpdates();

      // After stopping, no errors should occur
      clock.advance(60000);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // Just verify no crash
      expect(true).toBe(true);
    });

    it('initialize() — setup', async () => {
      const freshHierarchy = new DistributedHierarchy({
        registry,
        stateStore: redis,
        messageBus: null,
      });

      await freshHierarchy.initialize();

      // Should be operational after init
      const parent = makeAgent({ id: 'init-parent@m1', role: 'orchestrator', children: [] });
      await registry.register(parent);
      const result = await freshHierarchy.spawnChild('init-parent@m1', { role: 'worker', purpose: 'test' });
      expect(result.childId).toBeDefined();
    });

    it('shutdown() — teardown', async () => {
      await hierarchy.shutdown();

      // After shutdown, operations should fail
      await expect(
        hierarchy.spawnChild('parent@m1', { role: 'worker', purpose: 'test' })
      ).rejects.toThrow();
    });
  });
});
