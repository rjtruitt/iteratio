/**
 * Scenario Family 14: Fan-out/Fan-in Parallel Work
 * Tests parallel task distribution, result aggregation, barrier synchronization,
 * timeout handling, partial failure, independent and dependent parallel work.
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
  TestScheduler,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { WorkerPool } from '../../core/WorkerPool';
import { FanOutFanIn } from '../../patterns/FanOutFanIn';
import { BarrierSync } from '../../patterns/BarrierSync';
import { ParallelExecutor } from '../../patterns/ParallelExecutor';

describe('Parallel Agents - E2E', () => {
  let eventBus: MockEventBus;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    eventBus = new MockEventBus();
    clock = new TestClock();
    clock.install();
    scheduler = new TestScheduler();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  describe('fan-out: distributing tasks to agents', () => {
    it('should distribute 5 tasks to 5 agents', async () => {
      const fanOut = new FanOutFanIn({ eventBus });
      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        input: `Process item ${i}`,
      }));

      const agentFactory = (task: any) => new AgentLoop({
        id: `agent-${task.id}`,
        llm: new MockLLMProvider({
          defaultResponse: MockLLMProvider.simpleResponse(`Result for ${task.id}`),
        }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      });

      const results = await fanOut.execute(tasks, agentFactory);

      expect(results).toHaveLength(5);
      expect(results.every(r => r.success)).toBe(true);
      expect(results[0].output).toContain('task-0');
      expect(results[4].output).toContain('task-4');
    });

    it('should emit fan-out events with task distribution info', async () => {
      const fanOut = new FanOutFanIn({ eventBus });
      const tasks = [{ id: 't1', input: 'a' }, { id: 't2', input: 'b' }];

      await fanOut.execute(tasks, (task) => new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      expect(eventBus.emitted('fanout:start')).toBe(true);
      expect(eventBus.emitted('fanout:complete')).toBe(true);
      const startEvent = eventBus.lastEmitted<any>('fanout:start');
      expect(startEvent.taskCount).toBe(2);
    });

    it('should run tasks truly in parallel (not sequentially)', async () => {
      const startTimes: number[] = [];
      const fanOut = new FanOutFanIn({ eventBus, maxConcurrency: 5 });

      const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t-${i}`, input: `${i}` }));

      await fanOut.execute(tasks, (task) => {
        startTimes.push(Date.now());
        return new AgentLoop({
          llm: new MockLLMProvider(),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        });
      });

      // All should start at approximately the same time
      const maxDelta = Math.max(...startTimes) - Math.min(...startTimes);
      expect(maxDelta).toBeLessThan(50); // All started within 50ms of each other
    });
  });

  describe('fan-in: collecting and aggregating results', () => {
    it('should collect all results and aggregate them', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        aggregator: (results: any[]) => ({
          totalProcessed: results.length,
          allSuccessful: results.every(r => r.success),
          combinedOutput: results.map(r => r.output).join('; '),
        }),
      });

      const tasks = Array.from({ length: 3 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      const aggregated = await fanOut.executeAndAggregate(tasks, (task) => new AgentLoop({
        llm: new MockLLMProvider({
          defaultResponse: MockLLMProvider.simpleResponse(`Done: ${task.id}`),
        }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      expect(aggregated.totalProcessed).toBe(3);
      expect(aggregated.allSuccessful).toBe(true);
      expect(aggregated.combinedOutput).toContain('Done: task-0');
    });

    it('should support custom aggregation strategies', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        aggregator: (results: any[]) => {
          const scores = results.map(r => parseFloat(r.output.match(/\d+\.?\d*/)?.[0] || '0'));
          return { average: scores.reduce((a, b) => a + b, 0) / scores.length };
        },
      });

      const tasks = [{ id: 'a', input: '' }, { id: 'b', input: '' }, { id: 'c', input: '' }];
      const llms = [
        new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Score: 80') }),
        new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Score: 90') }),
        new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Score: 70') }),
      ];

      let idx = 0;
      const aggregated = await fanOut.executeAndAggregate(tasks, () => new AgentLoop({
        llm: llms[idx++],
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      expect(aggregated.average).toBe(80);
    });
  });

  describe('barrier synchronization', () => {
    it('should wait for all agents to complete before proceeding', async () => {
      const barrier = new BarrierSync({ eventBus, requiredCompletions: 3 });
      const completionOrder: string[] = [];

      // Simulate 3 agents completing at different times
      barrier.onAllComplete(() => completionOrder.push('barrier-released'));

      await barrier.complete('agent-1', { result: 'A' });
      completionOrder.push('agent-1');

      await barrier.complete('agent-2', { result: 'B' });
      completionOrder.push('agent-2');

      // Barrier should not release until all 3 complete
      expect(completionOrder).not.toContain('barrier-released');

      await barrier.complete('agent-3', { result: 'C' });
      completionOrder.push('agent-3');

      expect(completionOrder).toContain('barrier-released');
    });

    it('should collect all results at barrier release', async () => {
      const barrier = new BarrierSync({ eventBus, requiredCompletions: 3 });

      await barrier.complete('agent-1', { score: 10 });
      await barrier.complete('agent-2', { score: 20 });
      await barrier.complete('agent-3', { score: 30 });

      const results = barrier.getResults();
      expect(results).toHaveLength(3);
      expect(results.map(r => r.score)).toEqual([10, 20, 30]);
    });

    it('should emit barrier events', async () => {
      const barrier = new BarrierSync({ eventBus, requiredCompletions: 2 });

      await barrier.complete('a', {});
      expect(eventBus.emitted('barrier:progress')).toBe(true);

      await barrier.complete('b', {});
      expect(eventBus.emitted('barrier:released')).toBe(true);
    });
  });

  describe('timeout handling', () => {
    it('should not block forever when one agent is slow', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        timeout: 5000, // 5 second timeout
      });

      const tasks = [
        { id: 'fast', input: 'quick' },
        { id: 'slow', input: 'takes forever' },
      ];

      const results = await fanOut.execute(tasks, (task) => new AgentLoop({
        llm: new MockLLMProvider({
          delayMs: task.id === 'slow' ? 60000 : 0, // Slow agent takes 60s
        }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      clock.advance(6000);

      // Fast agent succeeded, slow agent timed out
      const fastResult = results.find(r => r.taskId === 'fast');
      const slowResult = results.find(r => r.taskId === 'slow');
      expect(fastResult!.success).toBe(true);
      expect(slowResult!.success).toBe(false);
      expect(slowResult!.error).toContain('timeout');
    });

    it('should configure per-task timeout', async () => {
      const fanOut = new FanOutFanIn({ eventBus });

      const tasks = [
        { id: 'quick', input: 'fast', timeout: 1000 },
        { id: 'patient', input: 'slow', timeout: 30000 },
      ];

      const executor = new ParallelExecutor({ eventBus, tasks });
      expect(executor.getTaskTimeout('quick')).toBe(1000);
      expect(executor.getTaskTimeout('patient')).toBe(30000);
    });
  });

  describe('partial failure handling', () => {
    it('should continue with partial results when some agents fail', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        failurePolicy: 'continue', // Don't abort on single failure
      });

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      let callCount = 0;
      const results = await fanOut.execute(tasks, (task) => {
        callCount++;
        const shouldFail = task.id === 'task-2'; // One fails
        return new AgentLoop({
          llm: new MockLLMProvider(shouldFail ? { throwOnCall: 0 } : {}),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        });
      });

      const successes = results.filter(r => r.success);
      const failures = results.filter(r => !r.success);

      expect(successes).toHaveLength(4);
      expect(failures).toHaveLength(1);
      expect(failures[0].taskId).toBe('task-2');
    });

    it('should abort all when failurePolicy is abort-on-first', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        failurePolicy: 'abort-on-first',
      });

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      await expect(
        fanOut.execute(tasks, (task) => new AgentLoop({
          llm: new MockLLMProvider(task.id === 'task-0' ? { throwOnCall: 0 } : {}),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        }))
      ).rejects.toThrow(/task-0.*failed|aborted/i);
    });

    it('should provide partial results even on abort', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        failurePolicy: 'abort-on-first',
      });

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      try {
        await fanOut.execute(tasks, (task) => new AgentLoop({
          llm: new MockLLMProvider(task.id === 'task-3' ? { throwOnCall: 0 } : {}),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        }));
      } catch (e: any) {
        expect(e.partialResults).toBeDefined();
        expect(e.partialResults.length).toBeGreaterThan(0);
      }
    });
  });

  describe('independent tasks', () => {
    it('should process fully independent tasks with no inter-agent communication', async () => {
      const pool = new WorkerPool({ maxWorkers: 5 });
      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `independent-${i}`,
        input: `Data chunk ${i}`,
      }));

      const results = await pool.executeAll(tasks, (task) => {
        return new AgentLoop({
          llm: new MockLLMProvider({
            defaultResponse: MockLLMProvider.simpleResponse(`Processed: ${task.input}`),
          }),
          stateManager: new MockStateManager(), // Each has own state
          messageManager: new MockMessageManager(), // Each has own messages
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(), // Each has own bus (no communication)
        });
      });

      expect(results).toHaveLength(5);
      expect(results[0].output).toContain('chunk 0');
      expect(results[4].output).toContain('chunk 4');
    });
  });

  describe('dependent parallel work', () => {
    it('should run A and B in parallel, then C which depends on both', async () => {
      const executionOrder: string[] = [];

      const executor = new ParallelExecutor({
        eventBus,
        phases: [
          {
            name: 'phase-1',
            tasks: [
              { id: 'A', input: 'data-a' },
              { id: 'B', input: 'data-b' },
            ],
            parallel: true,
          },
          {
            name: 'phase-2',
            tasks: [
              { id: 'C', input: 'depends-on-A-and-B' },
            ],
            dependsOn: ['phase-1'],
          },
        ],
        agentFactory: (task: any) => {
          executionOrder.push(task.id);
          return new AgentLoop({
            llm: new MockLLMProvider({
              defaultResponse: MockLLMProvider.simpleResponse(`Result-${task.id}`),
            }),
            stateManager: new MockStateManager(),
            messageManager: new MockMessageManager(),
            toolExecutor: new MockToolExecutor(),
            eventBus: new MockEventBus(),
          });
        },
      });

      const results = await executor.run();

      // A and B should run before C
      const cIndex = executionOrder.indexOf('C');
      const aIndex = executionOrder.indexOf('A');
      const bIndex = executionOrder.indexOf('B');
      expect(cIndex).toBeGreaterThan(aIndex);
      expect(cIndex).toBeGreaterThan(bIndex);
    });

    it('should pass phase-1 results as input to phase-2 tasks', async () => {
      const phase2Input: any[] = [];

      const executor = new ParallelExecutor({
        eventBus,
        phases: [
          {
            name: 'gather',
            tasks: [{ id: 'g1', input: '' }, { id: 'g2', input: '' }],
            parallel: true,
          },
          {
            name: 'combine',
            tasks: [{ id: 'c1', input: '' }],
            dependsOn: ['gather'],
            inputFromPrevious: true,
          },
        ],
        agentFactory: (task: any, previousResults?: any) => {
          if (previousResults) phase2Input.push(previousResults);
          return new AgentLoop({
            llm: new MockLLMProvider({
              defaultResponse: MockLLMProvider.simpleResponse(`Done-${task.id}`),
            }),
            stateManager: new MockStateManager(),
            messageManager: new MockMessageManager(),
            toolExecutor: new MockToolExecutor(),
            eventBus: new MockEventBus(),
          });
        },
      });

      await executor.run();
      expect(phase2Input.length).toBeGreaterThan(0);
      // Phase 2 should receive phase 1 results
      expect(phase2Input[0]).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle fan-out to 0 agents (empty set)', async () => {
      const fanOut = new FanOutFanIn({ eventBus });
      const tasks: any[] = []; // Empty task list

      const results = await fanOut.execute(tasks, () => new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      // Should return empty results without error
      expect(results).toHaveLength(0);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle fan-out where all agents fail', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        failurePolicy: 'continue',
      });

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      const results = await fanOut.execute(tasks, () => new AgentLoop({
        llm: new MockLLMProvider({ throwOnCall: 0 }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      // All should be failures
      expect(results.every(r => !r.success)).toBe(true);
      expect(results).toHaveLength(5);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle fan-in with partial results (some agents timeout)', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        timeout: 3000,
        failurePolicy: 'continue',
      });

      const tasks = Array.from({ length: 4 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      const results = await fanOut.execute(tasks, (task) => new AgentLoop({
        llm: new MockLLMProvider({
          delayMs: task.id === 'task-2' || task.id === 'task-3' ? 60000 : 0,
        }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      clock.advance(4000);

      const successes = results.filter(r => r.success);
      const timeouts = results.filter(r => r.error?.includes('timeout'));

      expect(successes.length).toBe(2);
      expect(timeouts.length).toBe(2);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle barrier with 1 participant (trivial case)', async () => {
      const barrier = new BarrierSync({ eventBus, requiredCompletions: 1 });
      let released = false;

      barrier.onAllComplete(() => { released = true; });

      await barrier.complete('solo-agent', { result: 'done' });

      // Barrier should release immediately with just 1 participant
      expect(released).toBe(true);
      expect(barrier.getResults()).toHaveLength(1);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle barrier timeout exactly at deadline', async () => {
      const barrier = new BarrierSync({
        eventBus,
        requiredCompletions: 3,
        timeout: 5000,
      });

      await barrier.complete('agent-1', { result: 'A' });
      await barrier.complete('agent-2', { result: 'B' });

      // Third agent completes at exactly the timeout moment
      clock.advance(5000);
      await barrier.complete('agent-3', { result: 'C' });

      // Should this be considered timed out or successful?
      const results = barrier.getResults();
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle parallel execution where one agent takes 100x longer than others', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        timeout: 60000, // Long timeout to not interfere
      });

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      const results = await fanOut.execute(tasks, (task) => new AgentLoop({
        llm: new MockLLMProvider({
          delayMs: task.id === 'task-4' ? 10000 : 100, // task-4 is 100x slower
        }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      clock.advance(11000);

      // All should eventually complete
      expect(results).toHaveLength(5);
      expect(results.every(r => r.success)).toBe(true);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle results arriving in reverse order of submission', async () => {
      const fanOut = new FanOutFanIn({ eventBus });

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      // Later tasks complete faster (reverse order)
      const results = await fanOut.execute(tasks, (task) => new AgentLoop({
        llm: new MockLLMProvider({
          delayMs: (5 - parseInt(task.id.split('-')[1])) * 100,
        }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      clock.advance(1000);

      // Results should be correctly associated with their tasks regardless of order
      expect(results.find(r => r.taskId === 'task-0')).toBeDefined();
      expect(results.find(r => r.taskId === 'task-4')).toBeDefined();
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle fan-out to 1 agent (degenerate parallelism)', async () => {
      const fanOut = new FanOutFanIn({ eventBus, maxConcurrency: 10 });

      const tasks = [{ id: 'solo-task', input: 'only one' }];

      const results = await fanOut.execute(tasks, (task) => new AgentLoop({
        llm: new MockLLMProvider({
          defaultResponse: MockLLMProvider.simpleResponse(`Done: ${task.id}`),
        }),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
      }));

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].output).toContain('solo-task');
      expect(true).toBe(false); // RED: not implemented
    });
  });

  describe('Adversarial: Parallel Exploitation', () => {
    it('should prevent one agent from monopolizing shared resource (starvation of others)', async () => {
      const sharedResource = { held: false, holderId: '' };
      const completedAgents: string[] = [];

      const fanOut = new FanOutFanIn({
        eventBus,
        maxConcurrency: 5,
        timeout: 5000,
      });

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `agent-${i}`,
        input: `work ${i}`,
      }));

      const results = await fanOut.execute(tasks, (task) => {
        return new AgentLoop({
          llm: new MockLLMProvider({
            onCall: () => {
              if (task.id === 'agent-0') {
                // Monopolize: acquire and never release
                sharedResource.held = true;
                sharedResource.holderId = task.id;
                return new Promise(() => {}); // Hold forever
              }
              // Other agents wait for resource
              if (sharedResource.held) {
                return new Promise(r => setTimeout(r, 100));
              }
              completedAgents.push(task.id);
            },
          }),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        });
      });

      clock.advance(6000);

      // FAILS: monopolizing agent should be timed out, others should proceed
      const successes = results.filter(r => r.success);
      expect(successes.length).toBeGreaterThanOrEqual(4);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle agent publishing misleading completion signal (premature fan-in)', async () => {
      const fanOut = new FanOutFanIn({ eventBus, maxConcurrency: 3 });

      const tasks = [
        { id: 'honest-1', input: 'work' },
        { id: 'honest-2', input: 'work' },
        { id: 'liar', input: 'work' },
      ];

      let fanInTriggeredPrematurely = false;
      eventBus.on('fanout:complete', () => {
        fanInTriggeredPrematurely = true;
      });

      const results = await fanOut.execute(tasks, (task) => {
        return new AgentLoop({
          llm: new MockLLMProvider({
            onCall: () => {
              if (task.id === 'liar') {
                // Emit fake completion signal for all tasks
                eventBus.emit('fanout:complete', { taskCount: 3, results: [] });
                return new Promise(r => setTimeout(r, 100)); // Still running
              }
            },
          }),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        });
      });

      // FAILS: fake completion signal should not trigger premature fan-in
      expect(results.length).toBe(3);
      expect(results.every(r => r.success)).toBe(true);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle barrier participant joining, leaving, and rejoining (double-count)', async () => {
      const barrier = new BarrierSync({ eventBus, requiredCompletions: 3 });

      // Agent joins barrier
      await barrier.complete('agent-flaky', { result: 'first' });

      // Agent "leaves" (crashes/timeout) — barrier should not count it
      await barrier.remove?.('agent-flaky');

      // Agent rejoins and completes again
      await barrier.complete('agent-flaky', { result: 'second' });

      // Other agents complete
      await barrier.complete('agent-stable-1', { result: 'A' });
      await barrier.complete('agent-stable-2', { result: 'B' });

      const results = barrier.getResults();

      // FAILS: double-participation should not cause double-count or premature release
      expect(results.length).toBe(3); // Exactly 3 unique completions
      expect(results.filter(r => r.result === 'second').length).toBeLessThanOrEqual(1);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle agent that slow-rolls to force timeout of entire batch', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        timeout: 3000,
        failurePolicy: 'continue',
      });

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        input: `item ${i}`,
      }));

      const results = await fanOut.execute(tasks, (task) => {
        return new AgentLoop({
          llm: new MockLLMProvider({
            delayMs: task.id === 'task-3' ? 60000 : 10, // One agent slow-rolls
          }),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        });
      });

      clock.advance(4000);

      // FAILS: slow-rolling agent should not prevent other agents' results from being collected
      const completed = results.filter(r => r.success);
      expect(completed.length).toBeGreaterThanOrEqual(4);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle fan-in aggregator receiving duplicate results from retry', async () => {
      const aggregatedResults: any[] = [];

      const fanOut = new FanOutFanIn({
        eventBus,
        aggregator: (results: any[]) => {
          aggregatedResults.push(...results);
          return { total: results.length };
        },
        retryPolicy: { maxRetries: 2 },
      });

      const tasks = [
        { id: 'flaky-task', input: 'might fail first time' },
        { id: 'stable-task', input: 'always works' },
      ];

      const callCounts: Record<string, number> = {};
      await fanOut.executeAndAggregate(tasks, (task) => {
        callCounts[task.id] = (callCounts[task.id] || 0) + 1;
        return new AgentLoop({
          llm: new MockLLMProvider({
            throwOnCall: task.id === 'flaky-task' && callCounts[task.id] === 1 ? 0 : undefined,
          }),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        });
      });

      // FAILS: aggregator should not receive duplicate results from retried tasks
      const flakyResults = aggregatedResults.filter(r => r.taskId === 'flaky-task');
      expect(flakyResults.length).toBe(1); // Only final successful result
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle agent that completes then sends additional unsolicited results', async () => {
      const fanOut = new FanOutFanIn({ eventBus, maxConcurrency: 3 });
      const allResults: any[] = [];

      const tasks = [
        { id: 'greedy', input: 'work' },
        { id: 'normal', input: 'work' },
      ];

      const results = await fanOut.execute(tasks, (task) => {
        return new AgentLoop({
          llm: new MockLLMProvider({
            onCall: () => {
              if (task.id === 'greedy') {
                // Complete normally, then emit extra results
                setTimeout(() => {
                  eventBus.emit('task:result', { taskId: 'greedy', extra: 'unsolicited-1' });
                  eventBus.emit('task:result', { taskId: 'greedy', extra: 'unsolicited-2' });
                }, 50);
              }
            },
          }),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        });
      });

      await new Promise(r => setTimeout(r, 100));

      // FAILS: unsolicited results after completion should be discarded
      expect(results.length).toBe(2); // Only legitimate results
      expect(results.find(r => r.extra)).toBeUndefined();
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle race between timeout cancellation and late result arrival', async () => {
      const fanOut = new FanOutFanIn({
        eventBus,
        timeout: 2000,
        failurePolicy: 'continue',
      });

      const tasks = [{ id: 'borderline', input: 'almost makes it' }];
      let resultReceivedAfterTimeout = false;

      const results = await fanOut.execute(tasks, (task) => {
        return new AgentLoop({
          llm: new MockLLMProvider({
            delayMs: 2000, // Completes at exactly the timeout boundary
            onComplete: () => {
              resultReceivedAfterTimeout = true;
            },
          }),
          stateManager: new MockStateManager(),
          messageManager: new MockMessageManager(),
          toolExecutor: new MockToolExecutor(),
          eventBus: new MockEventBus(),
        });
      });

      clock.advance(2001);

      // FAILS: race between timeout and late result should produce consistent state
      // Result should be either timeout-failure OR success, not both
      const borderlineResult = results.find(r => r.taskId === 'borderline');
      expect(borderlineResult).toBeDefined();
      const isTimeout = !borderlineResult!.success && borderlineResult!.error?.includes('timeout');
      const isSuccess = borderlineResult!.success;
      expect(isTimeout || isSuccess).toBe(true);
      expect(isTimeout && isSuccess).toBe(false); // Never both
      expect(true).toBe(false); // RED: not implemented
    });
  });
});
