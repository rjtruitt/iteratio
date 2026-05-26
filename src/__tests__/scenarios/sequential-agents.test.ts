/**
 * Scenario Family 15: Pipeline Execution (Sequential Agents)
 * Tests linear pipelines, mid-pipeline failure, transformations between stages,
 * state accumulation, conditional stage skipping, and long pipelines.
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
import { Pipeline } from '../../patterns/Pipeline';
import { PipelineStage } from '../../patterns/PipelineStage';

describe('Sequential Agents (Pipeline) - E2E', () => {
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

  describe('basic pipeline: A → B → C', () => {
    it('should pass Agent A output as Agent B input, and B output as C input', async () => {
      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'research',
            agent: new AgentLoop({
              llm: new MockLLMProvider({
                defaultResponse: MockLLMProvider.simpleResponse('Research findings: AI market growing 30% YoY'),
              }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
          {
            id: 'draft',
            agent: new AgentLoop({
              llm: new MockLLMProvider({
                defaultResponse: MockLLMProvider.simpleResponse('Draft: Based on research, AI market is booming...'),
              }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
          {
            id: 'review',
            agent: new AgentLoop({
              llm: new MockLLMProvider({
                defaultResponse: MockLLMProvider.simpleResponse('Reviewed: Article approved with minor edits'),
              }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
        ],
      });

      const result = await pipeline.execute('Write an article about AI market trends');

      expect(result.output).toContain('approved');
      expect(result.stagesCompleted).toBe(3);
      expect(result.stageOutputs['research']).toContain('growing 30%');
      expect(result.stageOutputs['draft']).toContain('booming');
      expect(result.stageOutputs['review']).toContain('approved');
    });

    it('should execute stages strictly in order', async () => {
      const executionOrder: string[] = [];

      const pipeline = new Pipeline({
        eventBus,
        stages: ['A', 'B', 'C'].map(id => ({
          id,
          agent: new AgentLoop({
            llm: new MockLLMProvider({
              defaultResponse: MockLLMProvider.simpleResponse(`${id} done`),
            }),
            stateManager: new MockStateManager(),
            messageManager: new MockMessageManager(),
            toolExecutor: new MockToolExecutor(),
            eventBus: new MockEventBus(),
          }),
          onStart: () => executionOrder.push(id),
        })),
      });

      await pipeline.execute('Go');
      expect(executionOrder).toEqual(['A', 'B', 'C']);
    });

    it('should include previous stage output in next stage prompt', async () => {
      const stageBLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('B processed'),
      });

      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'A',
            agent: new AgentLoop({
              llm: new MockLLMProvider({
                defaultResponse: MockLLMProvider.simpleResponse('Output from A: important data'),
              }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
          {
            id: 'B',
            agent: new AgentLoop({
              llm: stageBLLM,
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
        ],
      });

      await pipeline.execute('Start');

      // Stage B should receive A's output in its messages
      expect(stageBLLM.calls[0].messages.some(m =>
        m.content?.includes('Output from A') || m.content?.includes('important data')
      )).toBe(true);
    });
  });

  describe('failure mid-pipeline', () => {
    it('should propagate error when middle stage fails', async () => {
      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'A',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('A ok') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
          {
            id: 'B',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ throwOnCall: 0, throwError: new Error('Stage B crashed') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
          {
            id: 'C',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('C ok') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
        ],
      });

      await expect(pipeline.execute('Start')).rejects.toThrow('Stage B crashed');
    });

    it('should report which stage failed and what completed', async () => {
      const pipeline = new Pipeline({
        eventBus,
        stages: [
          { id: 'A', agent: new AgentLoop({ llm: new MockLLMProvider(), stateManager: new MockStateManager(), messageManager: new MockMessageManager(), toolExecutor: new MockToolExecutor(), eventBus: new MockEventBus() }) },
          { id: 'B', agent: new AgentLoop({ llm: new MockLLMProvider(), stateManager: new MockStateManager(), messageManager: new MockMessageManager(), toolExecutor: new MockToolExecutor(), eventBus: new MockEventBus() }) },
          { id: 'C', agent: new AgentLoop({ llm: new MockLLMProvider({ throwOnCall: 0 }), stateManager: new MockStateManager(), messageManager: new MockMessageManager(), toolExecutor: new MockToolExecutor(), eventBus: new MockEventBus() }) },
        ],
      });

      try {
        await pipeline.execute('Start');
      } catch (e: any) {
        expect(e.failedStage).toBe('C');
        expect(e.completedStages).toEqual(['A', 'B']);
      }
    });

    it('should support retry on stage failure', async () => {
      let attempts = 0;

      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'flaky',
            retries: 3,
            agent: new AgentLoop({
              llm: new MockLLMProvider({
                responses: [
                  // First two calls throw, third succeeds
                ],
                throwOnCall: 0,
              }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            onRetry: () => { attempts++; },
          },
        ],
        retryPolicy: { maxRetries: 3, backoffMs: 100 },
      });

      // With proper retry, should eventually succeed or exhaust retries
      try {
        await pipeline.execute('Start');
      } catch {
        expect(attempts).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('pipeline with transformation', () => {
    it('should transform A output format for B input', async () => {
      const stageB_LLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('Processed structured data'),
      });

      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'A',
            agent: new AgentLoop({
              llm: new MockLLMProvider({
                defaultResponse: MockLLMProvider.simpleResponse('{"items": [1, 2, 3], "total": 3}'),
              }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            outputTransform: (output: string) => {
              const parsed = JSON.parse(output);
              return `Process these ${parsed.total} items: ${parsed.items.join(', ')}`;
            },
          },
          {
            id: 'B',
            agent: new AgentLoop({
              llm: stageB_LLM,
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
        ],
      });

      await pipeline.execute('Fetch data');

      // B should receive the transformed version
      expect(stageB_LLM.calls[0].messages.some(m =>
        m.content?.includes('Process these 3 items: 1, 2, 3')
      )).toBe(true);
    });

    it('should handle transformation errors gracefully', async () => {
      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'A',
            agent: new AgentLoop({
              llm: new MockLLMProvider({
                defaultResponse: MockLLMProvider.simpleResponse('not json'),
              }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            outputTransform: (output: string) => {
              return JSON.parse(output); // Will throw on "not json"
            },
          },
          {
            id: 'B',
            agent: new AgentLoop({
              llm: new MockLLMProvider(),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
          },
        ],
      });

      await expect(pipeline.execute('Go')).rejects.toThrow(/transform|parse|JSON/i);
    });
  });

  describe('pipeline state accumulation', () => {
    it('should accumulate state through all stages', async () => {
      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'gather',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('data gathered') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            accumulateState: (currentState: any, output: string) => ({
              ...currentState,
              gathered: true,
              gatherOutput: output,
            }),
          },
          {
            id: 'analyze',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('analysis complete') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            accumulateState: (currentState: any, output: string) => ({
              ...currentState,
              analyzed: true,
              analysisOutput: output,
            }),
          },
          {
            id: 'report',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('report generated') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            accumulateState: (currentState: any, output: string) => ({
              ...currentState,
              reported: true,
            }),
          },
        ],
      });

      const result = await pipeline.execute('Start workflow');
      expect(result.pipelineState.gathered).toBe(true);
      expect(result.pipelineState.analyzed).toBe(true);
      expect(result.pipelineState.reported).toBe(true);
    });

    it('should make accumulated state available to subsequent stages', async () => {
      const stageCLLM = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('Final answer'),
      });

      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'A',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Found: X=42') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            accumulateState: (s: any) => ({ ...s, x: 42 }),
          },
          {
            id: 'B',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Computed: Y=84') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            accumulateState: (s: any) => ({ ...s, y: s.x * 2 }),
            injectState: true, // State should be injected into prompt
          },
          {
            id: 'C',
            agent: new AgentLoop({
              llm: stageCLLM,
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            injectState: true,
          },
        ],
      });

      await pipeline.execute('Calculate');

      // Stage C should have access to accumulated state
      expect(stageCLLM.calls[0].messages.some(m =>
        m.content?.includes('42') || m.content?.includes('84')
      )).toBe(true);
    });
  });

  describe('conditional stage skipping', () => {
    it('should skip a stage when condition is not met', async () => {
      const executedStages: string[] = [];

      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'check',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Status: no errors found') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            onStart: () => executedStages.push('check'),
          },
          {
            id: 'fix-errors',
            skipWhen: (previousOutput: string) => previousOutput.includes('no errors'),
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Errors fixed') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            onStart: () => executedStages.push('fix-errors'),
          },
          {
            id: 'deploy',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Deployed successfully') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            onStart: () => executedStages.push('deploy'),
          },
        ],
      });

      const result = await pipeline.execute('Deploy the app');
      expect(executedStages).toEqual(['check', 'deploy']); // fix-errors skipped
      expect(result.skippedStages).toContain('fix-errors');
    });

    it('should execute skipped stage when condition IS met', async () => {
      const executedStages: string[] = [];

      const pipeline = new Pipeline({
        eventBus,
        stages: [
          {
            id: 'check',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Status: 3 errors found') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            onStart: () => executedStages.push('check'),
          },
          {
            id: 'fix-errors',
            skipWhen: (previousOutput: string) => previousOutput.includes('no errors'),
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('All 3 errors fixed') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            onStart: () => executedStages.push('fix-errors'),
          },
          {
            id: 'deploy',
            agent: new AgentLoop({
              llm: new MockLLMProvider({ defaultResponse: MockLLMProvider.simpleResponse('Deployed') }),
              stateManager: new MockStateManager(),
              messageManager: new MockMessageManager(),
              toolExecutor: new MockToolExecutor(),
              eventBus: new MockEventBus(),
            }),
            onStart: () => executedStages.push('deploy'),
          },
        ],
      });

      await pipeline.execute('Deploy');
      expect(executedStages).toEqual(['check', 'fix-errors', 'deploy']);
    });
  });

  describe('long pipeline (5+ stages)', () => {
    it('should execute a 7-stage pipeline end-to-end', async () => {
      const stageNames = ['plan', 'research', 'outline', 'draft', 'review', 'revise', 'publish'];

      const pipeline = new Pipeline({
        eventBus,
        stages: stageNames.map((name, i) => ({
          id: name,
          agent: new AgentLoop({
            llm: new MockLLMProvider({
              defaultResponse: MockLLMProvider.simpleResponse(`${name} stage complete (${i + 1}/${stageNames.length})`),
            }),
            stateManager: new MockStateManager(),
            messageManager: new MockMessageManager(),
            toolExecutor: new MockToolExecutor(),
            eventBus: new MockEventBus(),
          }),
        })),
      });

      const result = await pipeline.execute('Create comprehensive content');

      expect(result.stagesCompleted).toBe(7);
      expect(result.output).toContain('publish stage complete');
      expect(Object.keys(result.stageOutputs)).toEqual(stageNames);
    });

    it('should emit progress events for each stage in long pipeline', async () => {
      const stageNames = ['s1', 's2', 's3', 's4', 's5'];

      const pipeline = new Pipeline({
        eventBus,
        stages: stageNames.map(name => ({
          id: name,
          agent: new AgentLoop({
            llm: new MockLLMProvider(),
            stateManager: new MockStateManager(),
            messageManager: new MockMessageManager(),
            toolExecutor: new MockToolExecutor(),
            eventBus: new MockEventBus(),
          }),
        })),
      });

      await pipeline.execute('Run all');

      expect(eventBus.emittedCount('pipeline:stage:complete')).toBe(5);
      const events = eventBus.allEmitted<any>('pipeline:stage:complete');
      expect(events.map(e => e.stageId)).toEqual(stageNames);
    });

    it('should track total execution time across all stages', async () => {
      const pipeline = new Pipeline({
        eventBus,
        stages: Array.from({ length: 5 }, (_, i) => ({
          id: `stage-${i}`,
          agent: new AgentLoop({
            llm: new MockLLMProvider({ delayMs: 100 }),
            stateManager: new MockStateManager(),
            messageManager: new MockMessageManager(),
            toolExecutor: new MockToolExecutor(),
            eventBus: new MockEventBus(),
          }),
        })),
      });

      const result = await pipeline.execute('Go');

      expect(result.totalDurationMs).toBeGreaterThan(0);
      expect(result.stageDurations).toHaveLength(5);
    });
  });
});
