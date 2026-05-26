import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockEventBus,
  MockStateManager,
  MockStep,
  createMockStep,
  createMockSteps,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 20: Removing Steps From Running Loops ---
// Tests graceful removal, mid-pipeline removal, dependent steps,
// critical step removal, optional step removal, and batch removal.

describe('E2E Scenario 20: Removed Steps - Dynamic Step Removal', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let llm: MockLLMProvider;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    llm = ctx.llm;
    scheduler = new TestScheduler();
  });

  afterEach(() => {
    scheduler.reset();
  });

  describe('Graceful Removal', () => {
    it('should finish current execution before removing step', async () => {
      const agent = stateManager.get<any>('agentLoop');
      let stepExecuting = false;
      let stepCompleted = false;

      const slowStep = createMockStep('slow-step');
      slowStep.execute = async (ctx: any) => {
        stepExecuting = true;
        await new Promise(r => setTimeout(r, 50));
        stepCompleted = true;
        return ctx;
      };

      agent.addStep(slowStep);
      agent.start();

      // Start a turn (step begins executing)
      const turnPromise = agent.runTurn('input');

      // Remove step while it's executing
      agent.removeStep('slow-step');

      await turnPromise;

      // Current execution should have completed
      expect(stepCompleted).toBe(true);
    });

    it('should not run removed step on subsequent turns', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const step = createMockStep('removable');

      agent.addStep(step);
      agent.start();

      await agent.runTurn('first');
      expect(step.callCount).toBe(1);

      // Remove it
      agent.removeStep('removable');

      await agent.runTurn('second');
      // Should still be 1 (not called on second turn)
      expect(step.callCount).toBe(1);
    });

    it('should emit step:removed event', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('to-remove'));
      agent.start();

      agent.removeStep('to-remove');

      expect(eventBus.emitted('step:removed')).toBe(true);
      expect(eventBus.lastEmitted<any>('step:removed').stepName).toBe('to-remove');
    });
  });

  describe('Mid-Pipeline Removal', () => {
    it('should apply removal after current turn completes (current turn uses old pipeline)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const steps = createMockSteps('step-1', 'step-2', 'step-3');

      for (const s of steps) agent.addStep(s);
      agent.start();

      // Start turn
      const turnPromise = agent.runTurn('input');

      // Remove step-2 mid-turn
      agent.removeStep('step-2');

      await turnPromise;

      // step-2 still executed in this turn (old pipeline)
      expect(steps[1].callCount).toBe(1);
    });

    it('should correctly relink pipeline after middle step is removed', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const executionOrder: string[] = [];

      const step1 = createMockStep('step-1');
      step1.execute = async (ctx: any) => { executionOrder.push('step-1'); return ctx; };
      const step2 = createMockStep('step-2');
      step2.execute = async (ctx: any) => { executionOrder.push('step-2'); return ctx; };
      const step3 = createMockStep('step-3');
      step3.execute = async (ctx: any) => { executionOrder.push('step-3'); return ctx; };

      agent.addStep(step1);
      agent.addStep(step2);
      agent.addStep(step3);
      agent.start();

      agent.removeStep('step-2');

      await agent.runTurn('input');

      expect(executionOrder).toEqual(['step-1', 'step-3']);
    });
  });

  describe('Dependent Step Removal', () => {
    it('should warn when removing a step that has dependents', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const baseStep = createMockStep('base');
      const dependentStep = createMockStep('dependent');

      agent.addStep(baseStep);
      agent.addStep(dependentStep, { dependsOn: ['base'] });
      agent.start();

      // Removing base should warn about dependent
      const warnings = agent.removeStep('base');
      expect(warnings).toContainEqual(expect.objectContaining({
        type: 'orphaned-dependency',
        affectedStep: 'dependent',
      }));
    });

    it('should cascade removal to dependent steps when cascade option is set', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const baseStep = createMockStep('base');
      const dep1 = createMockStep('dep-1');
      const dep2 = createMockStep('dep-2');

      agent.addStep(baseStep);
      agent.addStep(dep1, { dependsOn: ['base'] });
      agent.addStep(dep2, { dependsOn: ['base'] });
      agent.start();

      agent.removeStep('base', { cascade: true });

      const pipeline = agent.getPipeline();
      expect(pipeline.hasStep('base')).toBe(false);
      expect(pipeline.hasStep('dep-1')).toBe(false);
      expect(pipeline.hasStep('dep-2')).toBe(false);
    });

    it('should keep dependent steps if they have fallback behavior', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const baseStep = createMockStep('base');
      const resilientStep = createMockStep('resilient');

      agent.addStep(baseStep);
      agent.addStep(resilientStep, { dependsOn: ['base'], optional: true });
      agent.start();

      agent.removeStep('base');

      // resilientStep marked as optional dependency → stays in pipeline
      const pipeline = agent.getPipeline();
      expect(pipeline.hasStep('resilient')).toBe(true);
    });
  });

  describe('Critical Step Removal', () => {
    it('should error on next turn if critical step (LLM call) is removed', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const llmStep = createMockStep('llm-call');
      llmStep.execute = async (ctx: any) => {
        return { ...ctx, llmResponse: { content: 'response' } };
      };

      agent.addStep(llmStep, { critical: true });
      agent.start();

      agent.removeStep('llm-call');

      // Next turn should fail because critical step is missing
      await expect(agent.runTurn('input')).rejects.toThrow(/critical.*missing/i);
    });

    it('should require force flag to remove a critical step', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('critical-step'), { critical: true });
      agent.start();

      // Without force: should throw
      expect(() => agent.removeStep('critical-step')).toThrow();

      // With force: should succeed
      agent.removeStep('critical-step', { force: true });
      expect(agent.getPipeline().hasStep('critical-step')).toBe(false);
    });
  });

  describe('Optional Step Removal', () => {
    it('should allow pipeline to continue without optional step', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const mainStep = createMockStep('main');
      const optionalStep = createMockStep('optional-logging');

      agent.addStep(mainStep);
      agent.addStep(optionalStep, { optional: true });
      agent.start();

      agent.removeStep('optional-logging');

      // Should run fine without it
      const result = await agent.runTurn('input');
      expect(result).toBeDefined();
      expect(mainStep.callCount).toBe(1);
    });

    it('should not emit warnings when removing optional steps', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('optional-metrics'), { optional: true });
      agent.start();

      const warnings = agent.removeStep('optional-metrics');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('Batch Removal', () => {
    it('should remove 3 steps at once atomically', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const steps = createMockSteps('a', 'b', 'c', 'd', 'e');
      for (const s of steps) agent.addStep(s);
      agent.start();

      agent.removeSteps(['a', 'c', 'e']);

      const pipeline = agent.getPipeline();
      expect(pipeline.hasStep('a')).toBe(false);
      expect(pipeline.hasStep('b')).toBe(true);
      expect(pipeline.hasStep('c')).toBe(false);
      expect(pipeline.hasStep('d')).toBe(true);
      expect(pipeline.hasStep('e')).toBe(false);
    });

    it('should rollback batch removal if any step cannot be removed', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('removable'));
      agent.addStep(createMockStep('critical'), { critical: true });
      agent.start();

      // Batch includes a critical step without force → should fail entirely
      expect(() => {
        agent.removeSteps(['removable', 'critical']);
      }).toThrow();

      // Both should still be present (atomic rollback)
      const pipeline = agent.getPipeline();
      expect(pipeline.hasStep('removable')).toBe(true);
      expect(pipeline.hasStep('critical')).toBe(true);
    });

    it('should emit single batch event rather than individual events', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const steps = createMockSteps('x', 'y', 'z');
      for (const s of steps) agent.addStep(s);
      agent.start();

      agent.removeSteps(['x', 'y', 'z']);

      // Should emit one batch event, not 3 individual ones
      expect(eventBus.emittedCount('steps:removed')).toBe(1);
      const batchData = eventBus.lastEmitted<any>('steps:removed');
      expect(batchData.stepNames).toEqual(['x', 'y', 'z']);
    });
  });
});
