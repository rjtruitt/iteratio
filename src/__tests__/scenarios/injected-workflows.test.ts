import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockStep,
  createMockStep,
  createMockSteps,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 19: Injecting Steps Into Running Agent Loops ---
// Tests dynamic step injection to running agents: single agent, multiple agents,
// positional insertion, context access, and atomic multi-step injection.

describe('E2E Scenario 19: Injected Workflows - Dynamic Step Injection', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let transport: MockTransport;
  let llm: MockLLMProvider;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    transport = ctx.transport;
    llm = ctx.llm;
    scheduler = new TestScheduler();
  });

  afterEach(() => {
    scheduler.reset();
  });

  describe('Single Agent Step Injection', () => {
    it('should add a new step to a running agent loop', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const newStep = createMockStep('injected-step');

      // Agent is running
      agent.start();

      // Inject step
      agent.injectStep(newStep);

      // Verify step is in pipeline
      const pipeline = agent.getPipeline();
      expect(pipeline.hasStep('injected-step')).toBe(true);
    });

    it('should execute injected step on the next turn', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const newStep = createMockStep('injected-step');

      agent.start();
      agent.injectStep(newStep);

      // Run next turn
      await agent.runTurn('test input');

      expect(newStep.callCount).toBe(1);
    });

    it('should not disrupt current turn when step is injected mid-turn', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const existingStep = createMockStep('existing');
      const injectedStep = createMockStep('injected');

      agent.addStep(existingStep);
      agent.start();

      // Start a turn
      const turnPromise = agent.runTurn('input');

      // Inject mid-turn
      agent.injectStep(injectedStep);

      const result = await turnPromise;

      // Current turn uses old pipeline (injected step not called yet)
      expect(injectedStep.callCount).toBe(0);
      // Existing step ran normally
      expect(existingStep.callCount).toBe(1);
    });
  });

  describe('Multi-Agent Simultaneous Injection', () => {
    it('should add step to 5 agents simultaneously', async () => {
      const agents = Array.from({ length: 5 }, (_, i) => {
        const ctx = TestAgentFactory.create();
        return ctx.stateManager.get<any>('agentLoop');
      });

      const newStep = createMockStep('shared-step');

      // Inject to all 5 at once
      for (const agent of agents) {
        agent.start();
        agent.injectStep(newStep);
      }

      for (const agent of agents) {
        expect(agent.getPipeline().hasStep('shared-step')).toBe(true);
      }
    });

    it('should inject step to only a subset of agents (partial update)', async () => {
      const agents = Array.from({ length: 5 }, (_, i) => {
        const ctx = TestAgentFactory.create();
        const agent = ctx.stateManager.get<any>('agentLoop');
        agent.id = `agent-${i}`;
        return agent;
      });

      const newStep = createMockStep('partial-step');

      // Only inject to first 3
      for (const agent of agents.slice(0, 3)) {
        agent.start();
        agent.injectStep(newStep);
      }

      expect(agents[0].getPipeline().hasStep('partial-step')).toBe(true);
      expect(agents[1].getPipeline().hasStep('partial-step')).toBe(true);
      expect(agents[2].getPipeline().hasStep('partial-step')).toBe(true);
      expect(agents[3].getPipeline().hasStep('partial-step')).toBe(false);
      expect(agents[4].getPipeline().hasStep('partial-step')).toBe(false);
    });

    it('should emit injection event on each affected agent', async () => {
      const agents = Array.from({ length: 3 }, () => {
        const ctx = TestAgentFactory.create();
        return { agent: ctx.stateManager.get<any>('agentLoop'), eventBus: ctx.eventBus };
      });

      const newStep = createMockStep('event-step');

      for (const { agent } of agents) {
        agent.start();
        agent.injectStep(newStep);
      }

      for (const { eventBus: eb } of agents) {
        expect(eb.emitted('step:injected')).toBe(true);
      }
    });
  });

  describe('Positional Injection', () => {
    it('should inject step at specific position: before-llm', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const llmStep = createMockStep('llm-call');
      const preProcessStep = createMockStep('pre-process');

      agent.addStep(llmStep);
      agent.start();

      agent.injectStep(preProcessStep, { position: 'before', relativeTo: 'llm-call' });

      const order = agent.getPipeline().getStepOrder();
      const preIdx = order.indexOf('pre-process');
      const llmIdx = order.indexOf('llm-call');

      expect(preIdx).toBeLessThan(llmIdx);
    });

    it('should inject step at specific position: after-tools', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const toolStep = createMockStep('tool-execution');
      const postToolStep = createMockStep('post-tool-analysis');

      agent.addStep(toolStep);
      agent.start();

      agent.injectStep(postToolStep, { position: 'after', relativeTo: 'tool-execution' });

      const order = agent.getPipeline().getStepOrder();
      const toolIdx = order.indexOf('tool-execution');
      const postIdx = order.indexOf('post-tool-analysis');

      expect(postIdx).toBe(toolIdx + 1);
    });

    it('should inject step at the end by default (no position specified)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('step-1'));
      agent.addStep(createMockStep('step-2'));
      agent.start();

      const appendedStep = createMockStep('appended');
      agent.injectStep(appendedStep);

      const order = agent.getPipeline().getStepOrder();
      expect(order[order.length - 1]).toBe('appended');
    });

    it('should throw if relativeTo step does not exist', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      const step = createMockStep('orphan');

      expect(() => {
        agent.injectStep(step, { position: 'before', relativeTo: 'non-existent' });
      }).toThrow();
    });
  });

  describe('Context Access', () => {
    it('should provide full agent context to newly injected step', async () => {
      const agent = stateManager.get<any>('agentLoop');
      let receivedContext: any = null;

      const contextCapture = createMockStep('context-capture');
      contextCapture.execute = async (ctx: any) => {
        receivedContext = ctx;
        return ctx;
      };

      agent.start();
      agent.injectStep(contextCapture);

      await agent.runTurn('hello');

      expect(receivedContext).not.toBeNull();
      expect(receivedContext.messages).toBeDefined();
      expect(receivedContext.state).toBeDefined();
      expect(receivedContext.turnNumber).toBeDefined();
    });

    it('should give injected step access to results of prior steps in pipeline', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const producerStep = createMockStep('producer');
      producerStep.execute = async (ctx: any) => {
        return { ...ctx, data: { ...ctx.data, produced: 'value-from-producer' } };
      };

      let consumedValue: string | undefined;
      const consumerStep = createMockStep('consumer');
      consumerStep.execute = async (ctx: any) => {
        consumedValue = ctx.data.produced;
        return ctx;
      };

      agent.addStep(producerStep);
      agent.start();
      agent.injectStep(consumerStep, { position: 'after', relativeTo: 'producer' });

      await agent.runTurn('test');

      expect(consumedValue).toBe('value-from-producer');
    });
  });

  describe('Atomic Multi-Step Injection', () => {
    it('should inject multiple steps atomically (all or nothing)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      const steps = createMockSteps('step-a', 'step-b', 'step-c');

      agent.injectSteps(steps);

      const pipeline = agent.getPipeline();
      expect(pipeline.hasStep('step-a')).toBe(true);
      expect(pipeline.hasStep('step-b')).toBe(true);
      expect(pipeline.hasStep('step-c')).toBe(true);
    });

    it('should rollback all if one step in batch fails injection validation', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      const validStep = createMockStep('valid');
      const invalidStep = createMockStep(''); // empty name = invalid

      expect(() => {
        agent.injectSteps([validStep, invalidStep]);
      }).toThrow();

      // Neither should be in pipeline
      const pipeline = agent.getPipeline();
      expect(pipeline.hasStep('valid')).toBe(false);
    });

    it('should maintain relative ordering of atomically injected steps', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      const steps = createMockSteps('first', 'second', 'third');
      agent.injectSteps(steps);

      const order = agent.getPipeline().getStepOrder();
      const firstIdx = order.indexOf('first');
      const secondIdx = order.indexOf('second');
      const thirdIdx = order.indexOf('third');

      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });
  });

  describe('Step Dependencies', () => {
    it('should inject step with declared dependency on existing step', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const depStep = createMockStep('dependency');
      agent.addStep(depStep);
      agent.start();

      const dependentStep = createMockStep('dependent');
      agent.injectStep(dependentStep, { dependsOn: ['dependency'] });

      const order = agent.getPipeline().getStepOrder();
      expect(order.indexOf('dependency')).toBeLessThan(order.indexOf('dependent'));
    });

    it('should reject injection if dependency is not present in pipeline', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      const step = createMockStep('needs-dep');

      expect(() => {
        agent.injectStep(step, { dependsOn: ['missing-dep'] });
      }).toThrow();
    });

    it('should detect circular dependency on injection and reject', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const stepA = createMockStep('step-a');
      agent.addStep(stepA);
      agent.start();

      // step-a depends on step-b, step-b depends on step-a → circular
      const stepB = createMockStep('step-b');
      agent.injectStep(stepB, { dependsOn: ['step-a'] });

      expect(() => {
        agent.injectStep(stepA, { dependsOn: ['step-b'] });
      }).toThrow();
    });
  });
});
