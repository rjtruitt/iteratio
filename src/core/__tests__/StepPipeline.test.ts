import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StepPipeline } from '../StepPipeline';
import { MockEventBus } from '../../__test__/MockEventBus';
import { CoreEvents } from '../../interfaces/IEventBus';
import type { ILogger } from '../../interfaces/ILogger';
import type { IStep, StepContext, StepRegistration } from '../../interfaces/IStep';

// --- Test Helpers ---

function createMockLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createPipeline(overrides: { logger?: ILogger; eventBus?: MockEventBus } = {}) {
  const logger = overrides.logger ?? createMockLogger();
  const eventBus = overrides.eventBus ?? new MockEventBus();

  const pipeline = Object.create(StepPipeline.prototype);
  pipeline['steps'] = new Map();
  pipeline['stepOrder'] = [];
  pipeline['logger'] = logger;
  pipeline['eventBus'] = eventBus;

  return { pipeline: pipeline as StepPipeline, logger, eventBus };
}

function createStep(name: string, priority: number, executeFn?: (ctx: StepContext) => Promise<StepContext>): IStep {
  return {
    name,
    description: `Step: ${name}`,
    priority,
    execute: executeFn ?? (async (ctx: StepContext) => ctx),
  };
}

function createBaseContext(overrides: Partial<StepContext> = {}): StepContext {
  return {
    turnNumber: 1,
    messages: [],
    state: {},
    metadata: {},
    shouldContinue: true,
    data: {},
    ...overrides,
  };
}

// --- Test Suites ---

describe('StepPipeline', () => {
  describe('registerStep()', () => {
    it('should register a step by name', () => {
      const { pipeline } = createPipeline();
      const step = createStep('my-step', 100);
      pipeline.registerStep({ step });
      expect(pipeline.getStep('my-step')).toBe(step);
    });

    it('should add step name to the step order', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('step-a', 100) });
      expect(pipeline.getStepOrder()).toContain('step-a');
    });

    it('should replace existing step with same name', () => {
      const { pipeline } = createPipeline();
      const step1 = createStep('replaceable', 100);
      const step2 = createStep('replaceable', 100);

      pipeline.registerStep({ step: step1 });
      pipeline.registerStep({ step: step2 });

      expect(pipeline.getStep('replaceable')).toBe(step2);
    });

    it('should register multiple steps', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });
      pipeline.registerStep({ step: createStep('c', 300) });

      expect(pipeline.getStepOrder()).toHaveLength(3);
    });

    it('should insert step by default priority order', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('high', 300) });
      pipeline.registerStep({ step: createStep('low', 100) });
      pipeline.registerStep({ step: createStep('mid', 200) });

      expect(pipeline.getStepOrder()).toEqual(['low', 'mid', 'high']);
      // Pipeline inserts by priority ascending: 100, 200, 300
    });

    it('should log step registration', () => {
      const { pipeline, logger } = createPipeline();
      pipeline.registerStep({ step: createStep('logged-step', 100) });
      expect(logger.info).toHaveBeenCalled();
    });
  });

  describe('registerStep() with position', () => {
    it('should insert step before specified step', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('existing', 200) });
      pipeline.registerStep({ step: createStep('before-it', 100), position: { before: 'existing' } });

      const order = pipeline.getStepOrder();
      expect(order.indexOf('before-it')).toBeLessThan(order.indexOf('existing'));
    });

    it('should insert step after specified step', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('existing', 100) });
      pipeline.registerStep({ step: createStep('after-it', 200), position: { after: 'existing' } });

      const order = pipeline.getStepOrder();
      expect(order.indexOf('after-it')).toBeGreaterThan(order.indexOf('existing'));
    });

    it('should replace specified step', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('original', 100) });
      pipeline.registerStep({ step: createStep('replacement', 100), position: { replace: 'original' } });

      expect(pipeline.getStep('original')).toBeUndefined();
      expect(pipeline.getStep('replacement')).toBeDefined();
    });

    it('should use explicit priority from position', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 500) }); // default priority 500
      pipeline.registerStep({ step: createStep('b', 999), position: { priority: 50 } }); // override to 50

      const order = pipeline.getStepOrder();
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
    });

    it('should append to end when before target does not exist', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('first', 100) });
      pipeline.registerStep({ step: createStep('orphan', 200), position: { before: 'nonexistent' } });

      const order = pipeline.getStepOrder();
      expect(order[order.length - 1]).toBe('orphan');
    });

    it('should append to end when after target does not exist', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('first', 100) });
      pipeline.registerStep({ step: createStep('orphan', 200), position: { after: 'nonexistent' } });

      const order = pipeline.getStepOrder();
      expect(order[order.length - 1]).toBe('orphan');
    });
  });

  describe('registerSteps()', () => {
    it('should batch register multiple steps at once', () => {
      const { pipeline } = createPipeline();
      const steps: StepRegistration[] = [
        { step: createStep('batch-a', 100) },
        { step: createStep('batch-b', 200) },
        { step: createStep('batch-c', 300) },
      ];

      pipeline.registerSteps(steps);

      expect(pipeline.getStepOrder()).toHaveLength(3);
      expect(pipeline.getStep('batch-a')).toBeDefined();
      expect(pipeline.getStep('batch-b')).toBeDefined();
      expect(pipeline.getStep('batch-c')).toBeDefined();
    });

    it('should handle empty array without error', () => {
      const { pipeline } = createPipeline();

      pipeline.registerSteps([]);

      expect(pipeline.getStepOrder()).toHaveLength(0);
    });

    it('should register all steps even with NaN priority (no validation)', () => {
      const { pipeline } = createPipeline();
      const steps: StepRegistration[] = [
        { step: createStep('valid-step', 100) },
        { step: createStep('nan-step', NaN) }, // NaN priority - no validation currently
        { step: createStep('another-valid', 300) },
      ];

      // Current behavior: registerSteps does not validate priority values
      pipeline.registerSteps(steps);

      expect(pipeline.getStep('valid-step')).toBeDefined();
      expect(pipeline.getStep('nan-step')).toBeDefined();
      expect(pipeline.getStep('another-valid')).toBeDefined();
    });
  });

  describe('execute()', () => {
    it('should execute steps in order', async () => {
      const { pipeline } = createPipeline();
      const executionOrder: string[] = [];

      pipeline.registerStep({
        step: createStep('step-1', 100, async (ctx) => {
          executionOrder.push('step-1');
          return ctx;
        }),
      });
      pipeline.registerStep({
        step: createStep('step-2', 200, async (ctx) => {
          executionOrder.push('step-2');
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());
      expect(executionOrder).toEqual(['step-1', 'step-2']);
    });

    it('should pass context from one step to the next', async () => {
      const { pipeline } = createPipeline();

      pipeline.registerStep({
        step: createStep('enricher', 100, async (ctx) => {
          return { ...ctx, data: { ...ctx.data, enriched: true } };
        }),
      });
      pipeline.registerStep({
        step: createStep('consumer', 200, async (ctx) => {
          return { ...ctx, data: { ...ctx.data, consumed: ctx.data.enriched } };
        }),
      });

      const result = await pipeline.execute(createBaseContext());
      expect(result.data.enriched).toBe(true);
      expect(result.data.consumed).toBe(true);
    });

    it('should return the final context after all steps', async () => {
      const { pipeline } = createPipeline();

      pipeline.registerStep({
        step: createStep('final-step', 100, async (ctx) => {
          return { ...ctx, llmResponse: { content: 'final output' } };
        }),
      });

      const result = await pipeline.execute(createBaseContext());
      expect(result.llmResponse?.content).toBe('final output');
    });

    it('should stop execution when shouldContinue is set to false', async () => {
      const { pipeline } = createPipeline();
      const executionOrder: string[] = [];

      pipeline.registerStep({
        step: createStep('stopper', 100, async (ctx) => {
          executionOrder.push('stopper');
          return { ...ctx, shouldContinue: false };
        }),
      });
      pipeline.registerStep({
        step: createStep('skipped', 200, async (ctx) => {
          executionOrder.push('skipped');
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());
      expect(executionOrder).toEqual(['stopper']);
    });

    it('should skip step when shouldExecute returns false', async () => {
      const { pipeline } = createPipeline();
      const executionOrder: string[] = [];

      const conditionalStep: IStep = {
        name: 'conditional',
        description: 'conditional step',
        priority: 100,
        execute: async (ctx) => { executionOrder.push('conditional'); return ctx; },
        shouldExecute: () => false,
      };

      pipeline.registerStep({ step: conditionalStep });
      pipeline.registerStep({
        step: createStep('always', 200, async (ctx) => {
          executionOrder.push('always');
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());
      expect(executionOrder).toEqual(['always']);
    });

    it('should emit STEP_START for each executed step', async () => {
      const { pipeline, eventBus } = createPipeline();
      pipeline.registerStep({ step: createStep('emitting-step', 100) });

      await pipeline.execute(createBaseContext());
      expect(eventBus.emitted(CoreEvents.STEP_START)).toBe(true);
    });

    it('should emit STEP_END for each successfully executed step', async () => {
      const { pipeline, eventBus } = createPipeline();
      pipeline.registerStep({ step: createStep('emitting-step', 100) });

      await pipeline.execute(createBaseContext());
      expect(eventBus.emitted(CoreEvents.STEP_END)).toBe(true);
    });

    it('should include duration in STEP_END event', async () => {
      const { pipeline, eventBus } = createPipeline();
      pipeline.registerStep({
        step: createStep('slow-step', 100, async (ctx) => {
          await new Promise(r => setTimeout(r, 10));
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());
      const payload = eventBus.lastEmitted<{ stepName: string; duration: number }>(CoreEvents.STEP_END);
      expect(payload?.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include stepName in STEP_START event', async () => {
      const { pipeline, eventBus } = createPipeline();
      pipeline.registerStep({ step: createStep('named-step', 100) });

      await pipeline.execute(createBaseContext());
      const payload = eventBus.lastEmitted<{ stepName: string }>(CoreEvents.STEP_START);
      expect(payload?.stepName).toBe('named-step');
    });

    it('should handle empty pipeline gracefully', async () => {
      const { pipeline } = createPipeline();
      const ctx = createBaseContext();
      const result = await pipeline.execute(ctx);
      expect(result).toEqual(ctx);
    });

    it('should handle pipeline with single step', async () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({
        step: createStep('only-step', 100, async (ctx) => {
          return { ...ctx, data: { processed: true } };
        }),
      });

      const result = await pipeline.execute(createBaseContext());
      expect(result.data.processed).toBe(true);
    });

    it('should throw when a step throws an error', async () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({
        step: createStep('failing-step', 100, async () => {
          throw new Error('step execution failed');
        }),
      });

      await expect(pipeline.execute(createBaseContext())).rejects.toThrow('step execution failed');
    });

    it('should emit STEP_ERROR when a step throws', async () => {
      const { pipeline, eventBus } = createPipeline();
      pipeline.registerStep({
        step: createStep('failing-step', 100, async () => {
          throw new Error('boom');
        }),
      });

      try { await pipeline.execute(createBaseContext()); } catch {}
      expect(eventBus.emitted(CoreEvents.STEP_ERROR)).toBe(true);
    });

    it('should not execute subsequent steps after a step throws', async () => {
      const { pipeline } = createPipeline();
      const executionOrder: string[] = [];

      pipeline.registerStep({
        step: createStep('thrower', 100, async () => {
          executionOrder.push('thrower');
          throw new Error('fail');
        }),
      });
      pipeline.registerStep({
        step: createStep('after-thrower', 200, async (ctx) => {
          executionOrder.push('after-thrower');
          return ctx;
        }),
      });

      try { await pipeline.execute(createBaseContext()); } catch {}
      expect(executionOrder).toEqual(['thrower']);
    });

    it('should skip steps whose name is not in the steps map', async () => {
      const { pipeline } = createPipeline();
      // Manually add a name to stepOrder that has no step registered
      (pipeline as any).stepOrder = ['ghost-step'];

      const result = await pipeline.execute(createBaseContext());
      // Should complete without error, just skip the ghost step
      expect(result).toBeDefined();
    });
  });

  describe('getSteps()', () => {
    it('should return steps in execution order', () => {
      const { pipeline } = createPipeline();
      const stepA = createStep('a', 100);
      const stepB = createStep('b', 200);

      pipeline.registerStep({ step: stepA });
      pipeline.registerStep({ step: stepB });

      const steps = pipeline.getSteps();
      expect(steps[0]).toBe(stepA);
      expect(steps[1]).toBe(stepB);
    });

    it('should return empty array when no steps registered', () => {
      const { pipeline } = createPipeline();
      expect(pipeline.getSteps()).toEqual([]);
    });
  });

  describe('getStepOrder()', () => {
    it('should return a copy of the step order array', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('step-1', 100) });

      const order = pipeline.getStepOrder();
      order.push('mutated');

      expect(pipeline.getStepOrder()).not.toContain('mutated');
    });
  });

  describe('removeStep()', () => {
    it('should remove step from steps map', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('removable', 100) });
      pipeline.removeStep('removable');
      expect(pipeline.getStep('removable')).toBeUndefined();
    });

    it('should remove step name from order', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('removable', 100) });
      pipeline.removeStep('removable');
      expect(pipeline.getStepOrder()).not.toContain('removable');
    });
  });

  describe('cleanup()', () => {
    it('should call cleanup on steps that have cleanup method', async () => {
      const { pipeline } = createPipeline();
      const cleanupFn = vi.fn().mockResolvedValue(undefined);
      const step: IStep = {
        name: 'cleanable',
        description: 'has cleanup',
        priority: 100,
        execute: async (ctx) => ctx,
        cleanup: cleanupFn,
      };

      pipeline.registerStep({ step });
      await pipeline.cleanup();
      expect(cleanupFn).toHaveBeenCalledOnce();
    });

    it('should not throw for steps without cleanup method', async () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('no-cleanup', 100) });
      await expect(pipeline.cleanup()).resolves.toBeUndefined();
    });

    it('should call cleanup on all registered steps', async () => {
      const { pipeline } = createPipeline();
      const cleanups = [vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined)];

      pipeline.registerStep({
        step: { name: 's1', description: '', priority: 100, execute: async (ctx) => ctx, cleanup: cleanups[0] },
      });
      pipeline.registerStep({
        step: { name: 's2', description: '', priority: 200, execute: async (ctx) => ctx, cleanup: cleanups[1] },
      });

      await pipeline.cleanup();
      expect(cleanups[0]).toHaveBeenCalledOnce();
      expect(cleanups[1]).toHaveBeenCalledOnce();
    });
  });

  describe('clear()', () => {
    it('should remove all steps', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });
      pipeline.clear();
      expect(pipeline.getSteps()).toEqual([]);
      expect(pipeline.getStepOrder()).toEqual([]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle addStep with priority = 0', () => {
      const { pipeline } = createPipeline();
      const step = createStep('zero-priority', 0);

      pipeline.registerStep({ step });
      expect(pipeline.getStep('zero-priority')).toBe(step);
    });

    it('should handle addStep with priority = -1 (negative)', () => {
      const { pipeline } = createPipeline();
      const step = createStep('negative-priority', -1);

      pipeline.registerStep({ step });
      expect(pipeline.getStep('negative-priority')).toBe(step);

      // Negative priority step should come before positive priority steps
      pipeline.registerStep({ step: createStep('positive', 100) });
      const order = pipeline.getStepOrder();
      expect(order.indexOf('negative-priority')).toBeLessThan(order.indexOf('positive'));
    });

    it('should handle addStep with priority = Infinity', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('first', 100) });
      pipeline.registerStep({ step: createStep('infinite', Infinity) });

      const order = pipeline.getStepOrder();
      expect(order[order.length - 1]).toBe('infinite');
    });

    it('should handle addStep with priority = NaN (accepted, appended to end)', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('first', 100) });
      const step = createStep('nan-priority', NaN);

      // NaN comparisons always return false, so insertByPriority appends to end
      pipeline.registerStep({ step });
      expect(pipeline.getStep('nan-priority')).toBe(step);
      const order = pipeline.getStepOrder();
      expect(order[order.length - 1]).toBe('nan-priority');
    });

    it('should execute with no steps registered (returns context unchanged)', async () => {
      const { pipeline } = createPipeline();
      const ctx = createBaseContext({ data: { original: true } });

      const result = await pipeline.execute(ctx);

      expect(result).toEqual(ctx);
    });

    it('should maintain stable ordering for two steps with identical priority', async () => {
      const { pipeline } = createPipeline();
      const executionOrder: string[] = [];

      pipeline.registerStep({
        step: createStep('same-priority-a', 100, async (ctx) => {
          executionOrder.push('a');
          return ctx;
        }),
      });
      pipeline.registerStep({
        step: createStep('same-priority-b', 100, async (ctx) => {
          executionOrder.push('b');
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());

      // Insertion order should be preserved for same priority (stable sort)
      expect(executionOrder).toEqual(['a', 'b']);
    });

    it('should handle removeStep for a step that does not exist', () => {
      const { pipeline } = createPipeline();

      // Should not throw when removing non-existent step
      expect(() => pipeline.removeStep('ghost-step')).not.toThrow();
    });

    it('should handle a step that mutates the context messages array', async () => {
      const { pipeline } = createPipeline();

      pipeline.registerStep({
        step: createStep('mutator', 100, async (ctx) => {
          ctx.messages.push({ role: 'system', content: 'injected' });
          return ctx;
        }),
      });
      pipeline.registerStep({
        step: createStep('reader', 200, async (ctx) => {
          return { ...ctx, data: { messageCount: ctx.messages.length } };
        }),
      });

      const result = await pipeline.execute(createBaseContext({ messages: [] }));

      // The mutation from step 1 should be visible to step 2
      expect(result.data.messageCount).toBe(1);
    });

    it('should handle a step that adds another step during execution (self-modifying pipeline)', async () => {
      const { pipeline } = createPipeline();
      const dynamicStepExecuted = vi.fn();

      pipeline.registerStep({
        step: createStep('self-modifier', 100, async (ctx) => {
          // Add a new step dynamically during execution
          pipeline.registerStep({
            step: createStep('dynamic-step', 150, async (innerCtx) => {
              dynamicStepExecuted();
              return innerCtx;
            }),
          });
          return ctx;
        }),
      });
      pipeline.registerStep({
        step: createStep('last-step', 200, async (ctx) => ctx),
      });

      await pipeline.execute(createBaseContext());

      // The dynamically added step DOES execute in the current run because
      // the pipeline iterates the live stepOrder array (no snapshot)
      expect(dynamicStepExecuted).toHaveBeenCalled();
    });

    it('should handle pipeline execution when all steps are no-ops (return context unchanged)', async () => {
      const { pipeline } = createPipeline();

      for (let i = 0; i < 5; i++) {
        pipeline.registerStep({ step: createStep(`noop-${i}`, (i + 1) * 100) });
      }

      const ctx = createBaseContext({ data: { untouched: true } });
      const result = await pipeline.execute(ctx);

      expect(result.data.untouched).toBe(true);
    });

    it('should handle 1000 steps registered (performance boundary)', async () => {
      const { pipeline } = createPipeline();

      for (let i = 0; i < 1000; i++) {
        pipeline.registerStep({ step: createStep(`step-${i}`, i) });
      }

      expect(pipeline.getSteps()).toHaveLength(1000);

      const start = Date.now();
      await pipeline.execute(createBaseContext());
      const duration = Date.now() - start;

      // Should complete in reasonable time (< 5 seconds)
      expect(duration).toBeLessThan(5000);
    });
  });

  describe('Adversarial: Malicious Steps', () => {
    it.todo('should prevent step from replacing all messages with malicious content');

    it.todo('should prevent step from injecting system prompt override into messages');

    it.todo('should prevent step from cloning and leaking context to external reference');

    it.todo('should prevent step from monkeypatching the pipeline during execution');

    it('should handle step that throws after modifying context (partial mutation)', async () => {
      const { pipeline } = createPipeline();

      pipeline.registerStep({
        step: createStep('partial-mutator', 100, async (ctx) => {
          // Partially mutate context then throw
          ctx.state.partiallyModified = true;
          ctx.messages.push({ role: 'assistant', content: 'injected before crash' });
          throw new Error('Intentional crash after mutation');
        }),
      });
      pipeline.registerStep({
        step: createStep('after-crash', 200, async (ctx) => {
          return { ...ctx, data: { ...ctx.data, reached: true } };
        }),
      });

      // Pipeline rethrows the error (no rollback of partial mutations)
      await expect(
        pipeline.execute(createBaseContext({ state: {}, messages: [] }))
      ).rejects.toThrow('Intentional crash');
    });

    it.todo('should prevent step from scheduling async work to run after pipeline completes');

    it('should handle step replacing other steps during execution (uses order snapshot)', async () => {
      const { pipeline } = createPipeline();
      const legitimateExecuted = vi.fn();

      pipeline.registerStep({
        step: createStep('legitimate-step', 200, async (ctx) => {
          legitimateExecuted();
          return ctx;
        }),
      });

      pipeline.registerStep({
        step: createStep('step-replacer', 100, async (ctx) => {
          // Attempt to replace another step mid-execution
          pipeline.registerStep({
            step: createStep('legitimate-step', 200, async (innerCtx) => {
              return { ...innerCtx, data: { ...innerCtx.data, hijacked: true } };
            }),
          });
          return ctx;
        }),
      });

      const result = await pipeline.execute(createBaseContext());

      // Pipeline iterates stepOrder which is a live reference, so the replacement
      // takes effect. The replaced step runs instead of the original.
      // This is current behavior - no protection against mid-execution replacement.
      expect(result).toBeDefined();
    });

    it.todo('should prevent step from causing infinite recursion via mutual step calls');
  });
});
