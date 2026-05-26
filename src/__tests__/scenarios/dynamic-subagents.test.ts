/**
 * Scenario Family 13: Dynamic Agent Spawning
 * Tests on-demand specialist spawning, escalation, auto-termination,
 * resource limits, context inheritance, registry integration, and spawn depth limits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  MockToolExecutor,
  TestAgentFactory,
  TestClock,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { AgentSpawner } from '../../agents/AgentSpawner';
import { AgentRegistry } from '../../distributed/AgentRegistry';
import { DynamicAgentManager } from '../../agents/DynamicAgentManager';

describe('Dynamic Subagents - E2E', () => {
  let transport: MockTransport;
  let eventBus: MockEventBus;
  let clock: TestClock;

  beforeEach(() => {
    transport = new MockTransport();
    eventBus = new MockEventBus();
    clock = new TestClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('spawning specialists on demand', () => {
    it('should spawn a specialist agent when parent decides it needs help', async () => {
      const spawner = new AgentSpawner({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
      });

      const parent = new AgentLoop({
        id: 'parent',
        llm: new MockLLMProvider({
          defaultResponse: MockLLMProvider.simpleResponse(
            JSON.stringify({ action: 'spawn', role: 'data-analyst', task: 'Analyze CSV data' })
          ),
        }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus,
        spawner,
      });

      await parent.runTurn('I need to analyze this CSV data');

      expect(spawner.spawnedAgents).toHaveLength(1);
      expect(spawner.spawnedAgents[0].role).toBe('data-analyst');
    });

    it('should spawn agent with specific capabilities', async () => {
      const spawner = new AgentSpawner({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
      });

      const spawned = await spawner.spawn({
        role: 'python-expert',
        capabilities: ['python', 'data-science', 'pandas'],
        task: 'Process the dataset using pandas',
        parentId: 'main-agent',
      });

      expect(spawned.id).toBeDefined();
      expect(spawned.role).toBe('python-expert');
      expect(spawned.capabilities).toContain('pandas');
    });

    it('should return spawned agent result to parent', async () => {
      const spawnedLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('Analysis complete: 95% accuracy achieved'),
      });

      const spawner = new AgentSpawner({
        eventBus,
        transport,
        defaultLLM: spawnedLLM,
      });

      const spawned = await spawner.spawn({
        role: 'analyst',
        task: 'Run analysis',
        parentId: 'parent',
      });

      const result = await spawned.execute('Run the analysis');
      expect(result.output).toContain('95% accuracy');
    });
  });

  describe('specialist escalation', () => {
    it('should escalate when task is too complex for current agent', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
      });

      const baseAgent = await manager.createAgent({
        id: 'general',
        role: 'general-assistant',
        complexityThreshold: 5,
      });

      // Task with complexity > threshold triggers escalation
      const escalation = await baseAgent.evaluate({
        task: 'Implement a distributed consensus algorithm',
        estimatedComplexity: 9,
      });

      expect(escalation.shouldEscalate).toBe(true);
      expect(escalation.suggestedRole).toBe('distributed-systems-expert');
    });

    it('should spawn expert agent on escalation', async () => {
      const expertLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('Consensus algorithm implemented using Raft'),
      });

      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: expertLLM,
        escalationPolicy: 'auto-spawn',
      });

      const result = await manager.handleEscalation({
        from: 'general',
        reason: 'Task too complex',
        task: 'Implement Raft consensus',
        requiredCapabilities: ['distributed-systems', 'consensus-algorithms'],
      });

      expect(result.handledBy).toBeDefined();
      expect(result.output).toContain('Raft');
      expect(manager.activeAgents).toBeGreaterThan(1);
    });

    it('should chain escalations (base → intermediate → expert)', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        maxEscalationDepth: 3,
      });

      const escalations: string[] = [];
      manager.on('escalation', (data: any) => escalations.push(data.to));

      await manager.createAgent({ id: 'level-1', role: 'general', complexityThreshold: 3 });

      await manager.executeWithEscalation('level-1', {
        task: 'Prove Fermat\'s Last Theorem',
        estimatedComplexity: 10,
      });

      expect(escalations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('auto-termination of idle agents', () => {
    it('should terminate spawned agent after idle timeout', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        idleTimeout: 5000,
      });

      const spawned = await manager.spawnAgent({ role: 'temp-worker', task: 'Quick task' });
      await spawned.execute('Do the thing');

      // Agent completes its task and becomes idle
      clock.advance(6000);
      await manager.checkIdleAgents();

      expect(manager.isAgentActive(spawned.id)).toBe(false);
      expect(eventBus.emitted('agent:terminated')).toBe(true);
    });

    it('should not terminate agent that is still working', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider({ delayMs: 10000 }), // Long-running
        idleTimeout: 5000,
      });

      const spawned = await manager.spawnAgent({ role: 'worker', task: 'Long task' });
      const executePromise = spawned.execute('Start working');

      clock.advance(6000);
      await manager.checkIdleAgents();

      // Should still be active since it's working, not idle
      expect(manager.isAgentActive(spawned.id)).toBe(true);
    });

    it('should clean up resources on termination', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        idleTimeout: 1000,
      });

      const spawned = await manager.spawnAgent({ role: 'temp', task: 'test' });
      await spawned.execute('done');

      clock.advance(2000);
      await manager.checkIdleAgents();

      // Resources should be released
      const resources = manager.getResourceUsage();
      expect(resources.activeAgents).toBe(0);
    });
  });

  describe('resource limits', () => {
    it('should enforce maximum number of spawned agents', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        maxSpawnedAgents: 3,
      });

      await manager.spawnAgent({ role: 'worker-1', task: 'task 1' });
      await manager.spawnAgent({ role: 'worker-2', task: 'task 2' });
      await manager.spawnAgent({ role: 'worker-3', task: 'task 3' });

      // Fourth spawn should fail
      await expect(
        manager.spawnAgent({ role: 'worker-4', task: 'task 4' })
      ).rejects.toThrow(/max.*agents.*exceeded|limit.*reached/i);
    });

    it('should allow spawning after terminated agents free up slots', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        maxSpawnedAgents: 2,
        idleTimeout: 1000,
      });

      const agent1 = await manager.spawnAgent({ role: 'worker-1', task: 'task 1' });
      await manager.spawnAgent({ role: 'worker-2', task: 'task 2' });

      // Terminate agent1
      await manager.terminateAgent(agent1.id);

      // Now there's room for another
      const agent3 = await manager.spawnAgent({ role: 'worker-3', task: 'task 3' });
      expect(agent3).toBeDefined();
      expect(manager.activeAgents).toBe(2);
    });

    it('should queue spawn requests when at capacity', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        maxSpawnedAgents: 2,
        queueWhenFull: true,
      });

      await manager.spawnAgent({ role: 'w1', task: 't1' });
      await manager.spawnAgent({ role: 'w2', task: 't2' });

      // This should queue instead of throw
      const queuedPromise = manager.spawnAgent({ role: 'w3', task: 't3' });
      expect(manager.queuedSpawns).toBe(1);

      // Terminate one to process queue
      await manager.terminateAgent((await manager.getActiveAgentIds())[0]);
      const agent3 = await queuedPromise;
      expect(agent3).toBeDefined();
    });
  });

  describe('context inheritance', () => {
    it('should inherit parent agent context when spawned', async () => {
      const parentState = new MockStateManager();
      parentState.set('project', 'iteratio');
      parentState.set('language', 'TypeScript');

      const spawner = new AgentSpawner({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
      });

      const spawned = await spawner.spawn({
        role: 'child',
        task: 'Continue parent work',
        parentId: 'parent',
        inheritContext: true,
        parentState: parentState.toObject(),
      });

      expect(spawned.state.get('project')).toBe('iteratio');
      expect(spawned.state.get('language')).toBe('TypeScript');
    });

    it('should inherit parent system prompt', async () => {
      const spawner = new AgentSpawner({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
      });

      const spawned = await spawner.spawn({
        role: 'child',
        task: 'Sub-task',
        parentId: 'parent',
        inheritContext: true,
        parentSystemPrompt: 'You are working on the iteratio framework. Always use TypeScript.',
      });

      expect(spawned.systemPrompt).toContain('iteratio');
    });

    it('should allow overriding inherited context', async () => {
      const parentState = new MockStateManager();
      parentState.set('role', 'general');
      parentState.set('config', { verbose: true });

      const spawner = new AgentSpawner({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
      });

      const spawned = await spawner.spawn({
        role: 'specialist',
        task: 'Specialized task',
        parentId: 'parent',
        inheritContext: true,
        parentState: parentState.toObject(),
        overrides: { role: 'specialist' }, // Override the role
      });

      expect(spawned.state.get('role')).toBe('specialist'); // Overridden
      expect(spawned.state.get('config')).toEqual({ verbose: true }); // Inherited
    });
  });

  describe('registry integration', () => {
    it('should register spawned agent in the agent registry', async () => {
      const registry = new AgentRegistry({ redis: undefined }); // Local registry
      const spawner = new AgentSpawner({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        registry,
      });

      const spawned = await spawner.spawn({
        role: 'dynamic-worker',
        task: 'Process data',
        parentId: 'parent',
      });

      const registered = await registry.get(spawned.id);
      expect(registered).toBeDefined();
      expect(registered.role).toBe('dynamic-worker');
      expect(registered.parentId).toBe('parent');
    });

    it('should deregister agent on termination', async () => {
      const registry = new AgentRegistry({ redis: undefined });
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        registry,
      });

      const spawned = await manager.spawnAgent({ role: 'temp', task: 'test' });
      const id = spawned.id;

      await manager.terminateAgent(id);
      const registered = await registry.get(id);
      expect(registered).toBeNull();
    });
  });

  describe('spawn depth limits', () => {
    it('should prevent infinite spawn chains with depth limit', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        maxSpawnDepth: 3,
      });

      // Level 0 spawns level 1
      const level1 = await manager.spawnAgent({ role: 'l1', task: 't1', parentId: 'root', depth: 1 });
      // Level 1 spawns level 2
      const level2 = await manager.spawnAgent({ role: 'l2', task: 't2', parentId: level1.id, depth: 2 });
      // Level 2 spawns level 3
      const level3 = await manager.spawnAgent({ role: 'l3', task: 't3', parentId: level2.id, depth: 3 });

      // Level 3 tries to spawn level 4 - should be blocked
      await expect(
        manager.spawnAgent({ role: 'l4', task: 't4', parentId: level3.id, depth: 4 })
      ).rejects.toThrow(/depth limit|max spawn depth/i);
    });

    it('should track spawn depth in agent metadata', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        maxSpawnDepth: 5,
      });

      const agent = await manager.spawnAgent({ role: 'child', task: 'work', parentId: 'root', depth: 2 });
      expect(agent.metadata.depth).toBe(2);
      expect(agent.metadata.parentId).toBe('root');
    });

    it('should emit warning near depth limit', async () => {
      const manager = new DynamicAgentManager({
        eventBus,
        transport,
        defaultLLM: new MockLLMProvider(),
        maxSpawnDepth: 3,
        warnAtDepth: 2,
      });

      await manager.spawnAgent({ role: 'deep', task: 'test', parentId: 'root', depth: 2 });

      expect(eventBus.emitted('agent:depth-warning')).toBe(true);
    });
  });
});
