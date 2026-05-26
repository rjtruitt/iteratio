/**
 * Scenario Family 11: Graph-Based Agent Workflows
 * Tests linear DAGs, conditional routing, parallel branches, join nodes,
 * cycle detection, dynamic graph modification, subgraph embedding,
 * node failure handling, and data transformation between nodes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  MockToolExecutor,
  TestAgentFactory,
  TestClock,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentGraph } from '../../graphs/AgentGraph';
import { GraphNode } from '../../graphs/GraphNode';
import { GraphEdge } from '../../graphs/GraphEdge';
import { GraphExecutor } from '../../graphs/GraphExecutor';
import { GraphBuilder } from '../../graphs/GraphBuilder';

describe('Agent Graphs - E2E', () => {
  let eventBus: MockEventBus;
  let clock: TestClock;

  beforeEach(() => {
    eventBus = new MockEventBus();
    clock = new TestClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('linear DAG execution', () => {
    it('should execute A→B→C in order', async () => {
      const executionOrder: string[] = [];

      const graph = new GraphBuilder()
        .addNode('A', {
          execute: async (input: any) => { executionOrder.push('A'); return { ...input, a: true }; },
        })
        .addNode('B', {
          execute: async (input: any) => { executionOrder.push('B'); return { ...input, b: true }; },
        })
        .addNode('C', {
          execute: async (input: any) => { executionOrder.push('C'); return { ...input, c: true }; },
        })
        .addEdge('A', 'B')
        .addEdge('B', 'C')
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      const result = await executor.execute({ initial: true });

      expect(executionOrder).toEqual(['A', 'B', 'C']);
      expect(result.a).toBe(true);
      expect(result.b).toBe(true);
      expect(result.c).toBe(true);
    });

    it('should pass output of each node as input to the next', async () => {
      const graph = new GraphBuilder()
        .addNode('double', {
          execute: async (input: any) => ({ value: input.value * 2 }),
        })
        .addNode('addTen', {
          execute: async (input: any) => ({ value: input.value + 10 }),
        })
        .addNode('stringify', {
          execute: async (input: any) => ({ result: `Value is ${input.value}` }),
        })
        .addEdge('double', 'addTen')
        .addEdge('addTen', 'stringify')
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      const result = await executor.execute({ value: 5 });

      expect(result.result).toBe('Value is 20'); // (5*2)+10 = 20
    });

    it('should emit events for each node execution', async () => {
      const graph = new GraphBuilder()
        .addNode('A', { execute: async (i: any) => i })
        .addNode('B', { execute: async (i: any) => i })
        .addEdge('A', 'B')
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      await executor.execute({});

      expect(eventBus.emitted('graph:node:start')).toBe(true);
      expect(eventBus.emitted('graph:node:complete')).toBe(true);
      expect(eventBus.emittedCount('graph:node:start')).toBe(2);
      expect(eventBus.emittedCount('graph:node:complete')).toBe(2);
    });
  });

  describe('conditional routing', () => {
    it('should route to coder node for coding tasks', async () => {
      const routed: string[] = [];

      const graph = new GraphBuilder()
        .addNode('classifier', {
          execute: async (input: any) => ({ ...input, taskType: 'coding' }),
        })
        .addNode('coder', {
          execute: async (input: any) => { routed.push('coder'); return { result: 'code written' }; },
        })
        .addNode('writer', {
          execute: async (input: any) => { routed.push('writer'); return { result: 'text written' }; },
        })
        .addEdge('classifier', 'coder', { condition: (output: any) => output.taskType === 'coding' })
        .addEdge('classifier', 'writer', { condition: (output: any) => output.taskType === 'writing' })
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      const result = await executor.execute({ task: 'Write a sort function' });

      expect(routed).toEqual(['coder']);
      expect(result.result).toBe('code written');
    });

    it('should route to writer node for writing tasks', async () => {
      const routed: string[] = [];

      const graph = new GraphBuilder()
        .addNode('classifier', {
          execute: async (input: any) => ({ ...input, taskType: 'writing' }),
        })
        .addNode('coder', {
          execute: async (input: any) => { routed.push('coder'); return { result: 'code' }; },
        })
        .addNode('writer', {
          execute: async (input: any) => { routed.push('writer'); return { result: 'prose' }; },
        })
        .addEdge('classifier', 'coder', { condition: (output: any) => output.taskType === 'coding' })
        .addEdge('classifier', 'writer', { condition: (output: any) => output.taskType === 'writing' })
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      const result = await executor.execute({ task: 'Write a blog post' });

      expect(routed).toEqual(['writer']);
      expect(result.result).toBe('prose');
    });

    it('should handle default route when no condition matches', async () => {
      const graph = new GraphBuilder()
        .addNode('classifier', {
          execute: async (input: any) => ({ taskType: 'unknown' }),
        })
        .addNode('fallback', {
          execute: async () => ({ result: 'handled by fallback' }),
        })
        .addEdge('classifier', 'fallback', { isDefault: true })
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      const result = await executor.execute({});

      expect(result.result).toBe('handled by fallback');
    });
  });

  describe('parallel branches', () => {
    it('should execute researcher and writer simultaneously', async () => {
      const startTimes: Record<string, number> = {};

      const graph = new GraphBuilder()
        .addNode('start', { execute: async (input: any) => input })
        .addNode('researcher', {
          execute: async (input: any) => {
            startTimes['researcher'] = Date.now();
            return { research: 'findings' };
          },
        })
        .addNode('writer', {
          execute: async (input: any) => {
            startTimes['writer'] = Date.now();
            return { draft: 'text' };
          },
        })
        .addNode('reviewer', {
          execute: async (input: any) => ({ review: 'approved', ...input }),
        })
        .addEdge('start', 'researcher')
        .addEdge('start', 'writer')
        .addEdge('researcher', 'reviewer')
        .addEdge('writer', 'reviewer')
        .build();

      const executor = new GraphExecutor({ graph, eventBus, parallelExecution: true });
      const result = await executor.execute({ topic: 'AI' });

      // Researcher and writer should start at roughly the same time
      expect(Math.abs(startTimes['researcher'] - startTimes['writer'])).toBeLessThan(10);
      expect(result.review).toBe('approved');
    });

    it('should merge results from parallel branches at join node', async () => {
      const graph = new GraphBuilder()
        .addNode('split', { execute: async (input: any) => input })
        .addNode('branch-a', { execute: async () => ({ dataA: [1, 2, 3] }) })
        .addNode('branch-b', { execute: async () => ({ dataB: [4, 5, 6] }) })
        .addNode('merge', {
          execute: async (inputs: any[]) => ({
            combined: [...inputs[0].dataA, ...inputs[1].dataB],
          }),
          isJoinNode: true,
        })
        .addEdge('split', 'branch-a')
        .addEdge('split', 'branch-b')
        .addEdge('branch-a', 'merge')
        .addEdge('branch-b', 'merge')
        .build();

      const executor = new GraphExecutor({ graph, eventBus, parallelExecution: true });
      const result = await executor.execute({});

      expect(result.combined).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe('join node behavior', () => {
    it('should wait for all incoming branches before executing', async () => {
      const completionOrder: string[] = [];

      const graph = new GraphBuilder()
        .addNode('start', { execute: async (i: any) => i })
        .addNode('fast', {
          execute: async () => { completionOrder.push('fast'); return { fast: true }; },
        })
        .addNode('slow', {
          execute: async () => {
            await new Promise(r => setTimeout(r, 100));
            completionOrder.push('slow');
            return { slow: true };
          },
        })
        .addNode('join', {
          execute: async (inputs: any[]) => {
            completionOrder.push('join');
            return { bothDone: true };
          },
          isJoinNode: true,
        })
        .addEdge('start', 'fast')
        .addEdge('start', 'slow')
        .addEdge('fast', 'join')
        .addEdge('slow', 'join')
        .build();

      const executor = new GraphExecutor({ graph, eventBus, parallelExecution: true });
      await executor.execute({});

      // Join must come after both fast and slow
      expect(completionOrder.indexOf('join')).toBeGreaterThan(completionOrder.indexOf('fast'));
      expect(completionOrder.indexOf('join')).toBeGreaterThan(completionOrder.indexOf('slow'));
    });
  });

  describe('cycle detection', () => {
    it('should detect cycles and throw at build time', () => {
      expect(() => {
        new GraphBuilder()
          .addNode('A', { execute: async (i: any) => i })
          .addNode('B', { execute: async (i: any) => i })
          .addNode('C', { execute: async (i: any) => i })
          .addEdge('A', 'B')
          .addEdge('B', 'C')
          .addEdge('C', 'A') // Cycle!
          .build();
      }).toThrow(/cycle detected/i);
    });

    it('should detect self-loop', () => {
      expect(() => {
        new GraphBuilder()
          .addNode('A', { execute: async (i: any) => i })
          .addEdge('A', 'A') // Self-loop
          .build();
      }).toThrow(/cycle|self-loop/i);
    });

    it('should allow DAGs with diamond shapes (not cycles)', () => {
      // A → B → D
      // A → C → D
      // This is a valid DAG (diamond), not a cycle
      expect(() => {
        new GraphBuilder()
          .addNode('A', { execute: async (i: any) => i })
          .addNode('B', { execute: async (i: any) => i })
          .addNode('C', { execute: async (i: any) => i })
          .addNode('D', { execute: async (i: any) => i, isJoinNode: true })
          .addEdge('A', 'B')
          .addEdge('A', 'C')
          .addEdge('B', 'D')
          .addEdge('C', 'D')
          .build();
      }).not.toThrow();
    });
  });

  describe('dynamic graph modification', () => {
    it('should add a node during execution', async () => {
      const graph = new GraphBuilder()
        .addNode('start', { execute: async (i: any) => ({ ...i, started: true }) })
        .addNode('end', { execute: async (i: any) => ({ ...i, ended: true }) })
        .addEdge('start', 'end')
        .build();

      const executor = new GraphExecutor({ graph, eventBus, allowDynamicModification: true });

      // Add a node dynamically before execution reaches 'end'
      executor.onBeforeNode('end', async (graph) => {
        graph.insertBefore('end', 'middleware', {
          execute: async (i: any) => ({ ...i, middlewareRan: true }),
        });
      });

      const result = await executor.execute({});
      expect(result.started).toBe(true);
      expect(result.middlewareRan).toBe(true);
      expect(result.ended).toBe(true);
    });

    it('should remove a node during execution based on condition', async () => {
      const executed: string[] = [];

      const graph = new GraphBuilder()
        .addNode('A', { execute: async (i: any) => { executed.push('A'); return { ...i, skipB: true }; } })
        .addNode('B', { execute: async (i: any) => { executed.push('B'); return i; } })
        .addNode('C', { execute: async (i: any) => { executed.push('C'); return i; } })
        .addEdge('A', 'B')
        .addEdge('B', 'C')
        .build();

      const executor = new GraphExecutor({ graph, eventBus, allowDynamicModification: true });
      executor.onAfterNode('A', async (graph, output) => {
        if (output.skipB) graph.skipNode('B');
      });

      await executor.execute({});
      expect(executed).toEqual(['A', 'C']); // B was skipped
    });
  });

  describe('subgraph embedding', () => {
    it('should embed a reusable subgraph as a single node', async () => {
      // Create a reusable "research" subgraph
      const researchSubgraph = new GraphBuilder()
        .addNode('search', { execute: async (i: any) => ({ ...i, searchResults: ['r1', 'r2'] }) })
        .addNode('filter', { execute: async (i: any) => ({ ...i, filtered: i.searchResults.filter(Boolean) }) })
        .addEdge('search', 'filter')
        .build();

      // Embed it in a larger graph
      const mainGraph = new GraphBuilder()
        .addNode('start', { execute: async (i: any) => ({ query: 'AI trends' }) })
        .addSubgraph('research', researchSubgraph)
        .addNode('summarize', { execute: async (i: any) => ({ summary: `Found ${i.filtered.length} results` }) })
        .addEdge('start', 'research')
        .addEdge('research', 'summarize')
        .build();

      const executor = new GraphExecutor({ graph: mainGraph, eventBus });
      const result = await executor.execute({});

      expect(result.summary).toBe('Found 2 results');
    });
  });

  describe('node failure and recovery', () => {
    it('should route to error handler when a node fails', async () => {
      const graph = new GraphBuilder()
        .addNode('risky', {
          execute: async () => { throw new Error('Node failure'); },
        })
        .addNode('error-handler', {
          execute: async (input: any) => ({ recovered: true, error: input.error }),
        })
        .addEdge('risky', 'error-handler', { isErrorEdge: true })
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      const result = await executor.execute({});

      expect(result.recovered).toBe(true);
      expect(result.error).toContain('Node failure');
    });

    it('should retry failed nodes up to configured max', async () => {
      let attempts = 0;

      const graph = new GraphBuilder()
        .addNode('flaky', {
          execute: async () => {
            attempts++;
            if (attempts < 3) throw new Error('Transient');
            return { success: true };
          },
          retries: 3,
        })
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      const result = await executor.execute({});

      expect(attempts).toBe(3);
      expect(result.success).toBe(true);
    });

    it('should propagate failure if no error handler and retries exhausted', async () => {
      const graph = new GraphBuilder()
        .addNode('fatal', {
          execute: async () => { throw new Error('Permanent failure'); },
          retries: 1,
        })
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      await expect(executor.execute({})).rejects.toThrow('Permanent failure');
    });
  });

  describe('data transformation between nodes', () => {
    it('should apply transform function on edges', async () => {
      const graph = new GraphBuilder()
        .addNode('producer', {
          execute: async () => ({ items: [1, 2, 3, 4, 5] }),
        })
        .addNode('consumer', {
          execute: async (input: any) => ({ sum: input.numbers.reduce((a: number, b: number) => a + b, 0) }),
        })
        .addEdge('producer', 'consumer', {
          transform: (output: any) => ({ numbers: output.items.filter((n: number) => n > 2) }),
        })
        .build();

      const executor = new GraphExecutor({ graph, eventBus });
      const result = await executor.execute({});

      expect(result.sum).toBe(12); // 3 + 4 + 5
    });

    it('should validate data shape at edge boundaries', async () => {
      const graph = new GraphBuilder()
        .addNode('producer', {
          execute: async () => ({ wrong: 'format' }),
        })
        .addNode('consumer', {
          execute: async (input: any) => input,
          inputSchema: { type: 'object', required: ['numbers'] },
        })
        .addEdge('producer', 'consumer')
        .build();

      const executor = new GraphExecutor({ graph, eventBus, validateEdges: true });
      await expect(executor.execute({})).rejects.toThrow(/validation|schema|missing.*numbers/i);
    });
  });
});
