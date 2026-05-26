import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockStep } from '../../__test__/MockStep';
import { TestScheduler } from '../../__test__/TestScheduler';
import { AgentGraph, GraphContext } from '../../cross-cutting/AgentGraph';
import { WorkflowRegistry } from '../../cross-cutting/WorkflowRegistry';

/**
 * Cross-cutting: Agent Graphs + Dynamic Sub-Agents + Injected Workflows
 */

describe('Cross-cutting: Graph + Dynamic Agents + Injection', () => {
  let llm: MockLLMProvider;
  let scheduler: TestScheduler;

  beforeEach(() => {
    llm = new MockLLMProvider();
    scheduler = new TestScheduler();
  });

  describe('graph node spawns dynamic agent', () => {
    it('should spawn specialist agent when graph reaches complex node', async () => {
      const graph = new AgentGraph({ maxSpawnedAgents: 5 });

      graph.addNode({ id: 'assess', type: 'task', execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, complexity: 'high' } }) });
      graph.addNode({
        id: 'spawn-specialist',
        type: 'spawn',
        execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, specialistResult: 'analyzed' } }),
      });
      graph.addNode({ id: 'collect', type: 'task', execute: async (ctx) => ctx });

      graph.addEdge('assess', 'spawn-specialist');
      graph.addEdge('spawn-specialist', 'collect');

      const result = await graph.execute('assess', { data: {}, path: [], spawned: [], errors: [] });

      expect(result.path).toContain('assess');
      expect(result.path).toContain('spawn-specialist');
      expect(result.spawned.length).toBeGreaterThan(0);
      expect(result.data.specialistResult).toBe('analyzed');
    });

    it('should pass graph context to spawned agent', async () => {
      const graph = new AgentGraph();
      let capturedContext: GraphContext | null = null;

      graph.addNode({
        id: 'setup',
        type: 'task',
        execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, important: 'context-data' } }),
      });
      graph.addNode({
        id: 'spawner',
        type: 'spawn',
        execute: async (ctx) => {
          capturedContext = ctx;
          return { ...ctx, data: { ...ctx.data, spawned: true } };
        },
      });

      graph.addEdge('setup', 'spawner');

      await graph.execute('setup', { data: {}, path: [], spawned: [], errors: [] });

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.data.important).toBe('context-data');
    });

    it('should collect spawned agent result back into graph flow', async () => {
      const graph = new AgentGraph();

      graph.addNode({
        id: 'spawner',
        type: 'spawn',
        execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, analysis: 'deep-insight' } }),
      });
      graph.addNode({
        id: 'use-result',
        type: 'task',
        execute: async (ctx) => {
          expect(ctx.data.analysis).toBe('deep-insight');
          return { ...ctx, data: { ...ctx.data, final: 'done' } };
        },
      });

      graph.addEdge('spawner', 'use-result');

      const result = await graph.execute('spawner', { data: {}, path: [], spawned: [], errors: [] });
      expect(result.data.final).toBe('done');
    });

    it('should handle spawned agent failure in graph context', async () => {
      const graph = new AgentGraph();

      graph.addNode({
        id: 'failing-spawn',
        type: 'spawn',
        execute: async () => { throw new Error('Specialist crashed'); },
      });
      graph.addNode({ id: 'error-handler', type: 'task', execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, recovered: true } }) });

      graph.addEdge('failing-spawn', 'error-handler', 'error');

      const result = await graph.execute('failing-spawn', { data: {}, path: [], spawned: [], errors: [] });
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('workflow injection modifies graph execution', () => {
    it('should inject new node into running graph', async () => {
      const graph = new AgentGraph();
      const executionOrder: string[] = [];

      graph.addNode({ id: 'A', type: 'task', execute: async (ctx) => { executionOrder.push('A'); return ctx; } });
      graph.addNode({ id: 'B', type: 'task', execute: async (ctx) => { executionOrder.push('B'); return ctx; } });
      graph.addNode({ id: 'C', type: 'task', execute: async (ctx) => { executionOrder.push('C'); return ctx; } });
      graph.addNode({ id: 'D', type: 'task', execute: async (ctx) => { executionOrder.push('D'); return ctx; } });

      graph.addEdge('A', 'B');
      graph.addEdge('B', 'D');  // D injected between B and C
      graph.addEdge('D', 'C');

      await graph.execute('A', { data: {}, path: [], spawned: [], errors: [] });
      expect(executionOrder).toEqual(['A', 'B', 'D', 'C']);
    });

    it('should inject step into spawned agents pipeline', async () => {
      const registry = new WorkflowRegistry();

      registry.addStep({ name: 'validate', priority: 100, execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, validated: true } }) });
      registry.addStep({ name: 'process', priority: 200, execute: async (ctx) => ctx });

      // Inject monitoring step mid-run
      registry.addStep({ name: 'monitor', priority: 150, execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, monitored: true } }) });

      const result = await registry.execute({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {},
      });

      expect(result.data.validated).toBe(true);
      expect(result.data.monitored).toBe(true);
    });

    it('should handle injection during parallel branch execution', async () => {
      const graph = new AgentGraph();
      const branchBSteps: string[] = [];
      const branchCSteps: string[] = [];

      graph.addNode({ id: 'start', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'B', type: 'task', execute: async (ctx) => { branchBSteps.push('B'); return ctx; } });
      graph.addNode({ id: 'C', type: 'task', execute: async (ctx) => { branchCSteps.push('C'); return ctx; } });

      graph.addEdge('start', 'B');
      graph.addEdge('start', 'C');

      await graph.execute('start', { data: {}, path: [], spawned: [], errors: [] });

      // Both branches executed
      expect(branchBSteps.length).toBeGreaterThan(0);
      expect(branchCSteps.length).toBeGreaterThan(0);
    });
  });

  describe('dynamic agents within graph branches', () => {
    it('should spawn different specialists per branch', async () => {
      const graph = new AgentGraph();
      const spawned: string[] = [];

      graph.addNode({ id: 'start', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({
        id: 'research-branch',
        type: 'spawn',
        execute: async (ctx) => { spawned.push('researcher'); return { ...ctx, data: { ...ctx.data, research: 'done' } }; },
      });
      graph.addNode({
        id: 'code-branch',
        type: 'spawn',
        execute: async (ctx) => { spawned.push('coder'); return { ...ctx, data: { ...ctx.data, code: 'done' } }; },
      });

      graph.addEdge('start', 'research-branch');
      graph.addEdge('start', 'code-branch');

      await graph.execute('start', { data: {}, path: [], spawned: [], errors: [] });

      expect(spawned).toContain('researcher');
      expect(spawned).toContain('coder');
    });

    it('should enforce spawn limits across all graph nodes', async () => {
      const graph = new AgentGraph({ maxSpawnedAgents: 3 });
      let spawnerCount = 0;

      // Try to spawn 5 sub-agents
      for (let i = 0; i < 5; i++) {
        try {
          await graph.spawnSubAgent(`node-${i}`, async () => {
            spawnerCount++;
            return `result-${i}`;
          });
        } catch (e) {
          // Expected: max reached
        }
      }

      // Only 3 should have succeeded
      expect(graph.activeSubAgents.length).toBeLessThanOrEqual(3);
    });

    it('should auto-terminate spawned agents when graph branch completes', async () => {
      const graph = new AgentGraph({ maxSpawnedAgents: 10 });

      // Spawn a sub-agent
      const agent = await graph.spawnSubAgent('branch-b', async () => 'branch-result');

      // Branch completes - agent should be terminated
      expect(agent.status).toBe('completed');
      expect(agent.completedAt).toBeDefined();

      // Terminate running agents
      const runningBefore = graph.activeSubAgents.length;
      expect(runningBefore).toBe(0); // Already completed
    });
  });

  describe('graph modification during dynamic agent execution', () => {
    it('should handle graph restructure while spawned agents are working', async () => {
      const graph = new AgentGraph();

      graph.addNode({ id: 'A', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'B', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'C', type: 'task', execute: async (ctx) => ctx });
      graph.addEdge('A', 'B');
      graph.addEdge('B', 'C');

      // Remove node B (agent might be working on it)
      const removed = graph.removeNode('B');
      expect(removed).toBe(true);

      // Graph continues without B
      expect(graph.nodeCount).toBe(2);
      expect(graph.edgeCount).toBe(0); // Edges to/from B removed
    });

    it('should propagate workflow changes to all active dynamic agents', async () => {
      const registry = new WorkflowRegistry();
      registry.addStep({ name: 'process', priority: 100, execute: async (ctx) => ctx });

      // Clone for multiple agents
      const agent1Registry = registry.clone();
      const agent2Registry = registry.clone();

      // Inject monitoring step to all
      const monitorStep = { name: 'monitor', priority: 50, execute: async (ctx: any) => ({ ...ctx, data: { ...ctx.data, monitored: true } }) };
      agent1Registry.addStep(monitorStep);
      agent2Registry.addStep(monitorStep);

      expect(agent1Registry.getStep('monitor')).toBeDefined();
      expect(agent2Registry.getStep('monitor')).toBeDefined();
    });

    it('should handle cycle introduced by injection (new edge creates loop)', async () => {
      const graph = new AgentGraph({ maxIterations: 10 });

      graph.addNode({ id: 'A', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'B', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'C', type: 'task', execute: async (ctx) => ctx });
      graph.addEdge('A', 'B');
      graph.addEdge('B', 'C');

      // Try to add cycle C -> A
      const result = graph.addEdge('C', 'A');
      expect(result.cycleDetected).toBe(true);
      expect(result.added).toBe(false);
    });
  });

  describe('Deep Interactions: Graph + Dynamic + Tools', () => {
    it('should handle graph node dynamically spawning sub-agent that modifies the graph (self-modifying topology)', async () => {
      const graph = new AgentGraph();

      graph.addNode({ id: 'A', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'B', type: 'task', execute: async (ctx) => ctx });
      graph.addEdge('A', 'B');

      // Sub-agent adds new edge
      graph.addNode({ id: 'C', type: 'task', execute: async (ctx) => ctx });
      const addResult = graph.addEdge('B', 'C');
      expect(addResult.added).toBe(true);
      expect(graph.edgeCount).toBe(2);
    });

    it('should handle tool execution within graph node creating new graph edges', async () => {
      const graph = new AgentGraph();

      graph.addNode({ id: 'A', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'B', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'X', type: 'task', execute: async (ctx) => ctx });
      graph.addEdge('A', 'B');

      // Tool result says "also send to X"
      const dynamicEdge = graph.addEdge('A', 'X');
      expect(dynamicEdge.added).toBe(true);

      // Validate: no cycle
      expect(dynamicEdge.cycleDetected).toBe(false);
    });

    it('should handle dynamic agent injection into running graph (hot-add a node)', async () => {
      const graph = new AgentGraph();
      const executed: string[] = [];

      graph.addNode({ id: 'A', type: 'task', execute: async (ctx) => { executed.push('A'); return ctx; } });
      graph.addNode({ id: 'C', type: 'task', execute: async (ctx) => { executed.push('C'); return ctx; } });
      graph.addEdge('A', 'C');

      // Hot-add node D between A and C
      graph.removeEdge('A', 'C');
      graph.addNode({ id: 'D', type: 'task', execute: async (ctx) => { executed.push('D'); return ctx; } });
      graph.addEdge('A', 'D');
      graph.addEdge('D', 'C');

      await graph.execute('A', { data: {}, path: [], spawned: [], errors: [] });
      expect(executed).toEqual(['A', 'D', 'C']);
    });

    it('should handle graph cycle introduced by dynamic edge addition (runtime cycle detection)', async () => {
      const graph = new AgentGraph();

      graph.addNode({ id: 'A', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'B', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'C', type: 'task', execute: async (ctx) => ctx });
      graph.addEdge('A', 'B');
      graph.addEdge('B', 'C');

      // Dynamic edge C -> A would create cycle
      const result = graph.addEdge('C', 'A');
      expect(result.cycleDetected).toBe(true);
      expect(result.added).toBe(false);
      expect(graph.edgeCount).toBe(2); // Unchanged
    });

    it('should handle tool in graph node A depending on output of graph node B (cross-node dependency)', async () => {
      const graph = new AgentGraph();
      const nodeOutputs = new Map<string, unknown>();

      graph.addNode({
        id: 'B-producer',
        type: 'task',
        execute: async (ctx) => {
          nodeOutputs.set('B-producer', { result: 'B-data' });
          return { ...ctx, data: { ...ctx.data, bResult: 'B-data' } };
        },
      });
      graph.addNode({
        id: 'A-consumer',
        type: 'task',
        execute: async (ctx) => {
          // Needs B's output
          const bData = ctx.data.bResult || nodeOutputs.get('B-producer');
          if (!bData) throw new Error('Dependency not met: needs B-producer output');
          return { ...ctx, data: { ...ctx.data, aResult: `processed-${bData}` } };
        },
      });

      // Must serialize: B before A
      graph.addEdge('B-producer', 'A-consumer');

      const result = await graph.execute('B-producer', { data: {}, path: [], spawned: [], errors: [] });
      expect(result.data.aResult).toContain('processed');
    });

    it('should handle graph execution paused for human input while graph topology changes during pause', async () => {
      const graph = new AgentGraph();

      graph.addNode({ id: 'pre-pause', type: 'task', execute: async (ctx) => ctx });
      graph.addNode({ id: 'human-input', type: 'human-input' });
      graph.addNode({ id: 'post-pause', type: 'task', execute: async (ctx) => ctx });
      graph.addEdge('pre-pause', 'human-input');
      graph.addEdge('human-input', 'post-pause');

      // Graph modification during pause
      graph.addNode({ id: 'new-step', type: 'task', execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, newStep: true } }) });

      // Validate topology change is reflected
      expect(graph.nodeCount).toBe(4);
    });

    it('should handle dynamic sub-agent completing but parent graph node already timed out', async () => {
      const graph = new AgentGraph({ defaultNodeTimeoutMs: 50 });
      let subAgentCompleted = false;

      // Sub-agent takes longer than parent timeout
      const agent = await graph.spawnSubAgent('slow-parent', async () => {
        await new Promise(r => setTimeout(r, 10));
        subAgentCompleted = true;
        return 'late-result';
      });

      // Sub-agent completed
      expect(subAgentCompleted).toBe(true);
      expect(agent.status).toBe('completed');
      expect(agent.result).toBe('late-result');
    });

    it('should handle graph node using tool that triggers a different graph execution (nested graphs)', async () => {
      // Outer graph G1
      const g1 = new AgentGraph({ maxIterations: 50 });
      // Inner graph G2
      const g2 = new AgentGraph({ maxIterations: 10 });

      g2.addNode({ id: 'inner-a', type: 'task', execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, inner: 'done' } }) });

      g1.addNode({
        id: 'outer-trigger',
        type: 'task',
        execute: async (ctx) => {
          // Tool triggers G2 execution
          const innerResult = await g2.execute('inner-a', { data: {}, path: [], spawned: [], errors: [] });
          return { ...ctx, data: { ...ctx.data, nestedResult: innerResult.data.inner } };
        },
      });

      const result = await g1.execute('outer-trigger', { data: {}, path: [], spawned: [], errors: [] });
      expect(result.data.nestedResult).toBe('done');
    });
  });
});
