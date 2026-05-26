import { describe, it, expect, vi } from 'vitest';
import { StepPipeline } from '../StepPipeline';
import { MockEventBus } from '../../__test__/MockEventBus';
import { CoreEvents } from '../../interfaces/IEventBus';
import type { ILogger } from '../../interfaces/ILogger';
import type { IStep, StepContext } from '../../interfaces/IStep';

// --- Test Helpers ---

function createMockLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createPipeline() {
  const logger = createMockLogger();
  const eventBus = new MockEventBus();

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

describe('StepPipeline - Error Handling', () => {
  describe('Step execution errors', () => {
    it('should propagate Error thrown by a step', async () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({
        step: createStep('thrower', 100, async () => {
          throw new Error('step broke');
        }),
      });

      await expect(pipeline.execute(createBaseContext())).rejects.toThrow('step broke');
    });

    it('should propagate non-Error throws from a step', async () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({
        step: createStep('string-thrower', 100, async () => {
          throw 'string error';
        }),
      });

      await expect(pipeline.execute(createBaseContext())).rejects.toBe('string error');
    });

    it('should emit STEP_ERROR with stepName when step throws', async () => {
      const { pipeline, eventBus } = createPipeline();
      pipeline.registerStep({
        step: createStep('named-thrower', 100, async () => {
          throw new Error('fail');
        }),
      });

      try { await pipeline.execute(createBaseContext()); } catch {}
      const payload = eventBus.lastEmitted<{ stepName: string; error: unknown }>(CoreEvents.STEP_ERROR);
      expect(payload?.stepName).toBe('named-thrower');
    });

    it('should emit STEP_ERROR with the error object', async () => {
      const { pipeline, eventBus } = createPipeline();
      const error = new Error('specific error');
      pipeline.registerStep({
        step: createStep('error-step', 100, async () => { throw error; }),
      });

      try { await pipeline.execute(createBaseContext()); } catch {}
      const payload = eventBus.lastEmitted<{ stepName: string; error: unknown }>(CoreEvents.STEP_ERROR);
      expect(payload?.error).toBe(error);
    });

    it('should log the error via logger.error', async () => {
      const { pipeline, logger } = createPipeline();
      const error = new Error('logged error');
      pipeline.registerStep({
        step: createStep('logging-step', 100, async () => { throw error; }),
      });

      try { await pipeline.execute(createBaseContext()); } catch {}
      expect(logger.error).toHaveBeenCalled();
    });

    it('should include step name in logger.error call', async () => {
      const { pipeline, logger } = createPipeline();
      pipeline.registerStep({
        step: createStep('identifiable', 100, async () => { throw new Error('fail'); }),
      });

      try { await pipeline.execute(createBaseContext()); } catch {}
      const errorCall = (logger.error as any).mock.calls[0];
      expect(errorCall[0]).toContain('identifiable');
    });

    it('should emit STEP_START but not STEP_END for a failing step', async () => {
      const { pipeline, eventBus } = createPipeline();
      pipeline.registerStep({
        step: createStep('half-step', 100, async () => { throw new Error('mid-execution'); }),
      });

      try { await pipeline.execute(createBaseContext()); } catch {}

      expect(eventBus.emitted(CoreEvents.STEP_START)).toBe(true);
      expect(eventBus.emitted(CoreEvents.STEP_END)).toBe(false);
    });

    it('should not execute steps after the failing step', async () => {
      const { pipeline } = createPipeline();
      const reached = vi.fn();

      pipeline.registerStep({
        step: createStep('fail-first', 100, async () => { throw new Error('stop'); }),
      });
      pipeline.registerStep({
        step: createStep('unreachable', 200, async (ctx) => { reached(); return ctx; }),
      });

      try { await pipeline.execute(createBaseContext()); } catch {}
      expect(reached).not.toHaveBeenCalled();
    });

    it('should preserve context state up to the point of failure', async () => {
      const { pipeline } = createPipeline();

      pipeline.registerStep({
        step: createStep('enricher', 100, async (ctx) => {
          return { ...ctx, data: { ...ctx.data, enriched: true } };
        }),
      });
      pipeline.registerStep({
        step: createStep('crasher', 200, async (ctx) => {
          throw new Error('crash after enrichment');
        }),
      });

      // FAILS: the enriched context is lost when the error propagates
      // Desired: error contains/preserves partial context
      try {
        await pipeline.execute(createBaseContext());
      } catch (error: any) {
        // Desired: error has context attached
        expect(error.context?.data?.enriched).toBe(true);
      }
    });

    it('should wrap errors with step identification', async () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({
        step: createStep('mystery-step', 100, async () => { throw new Error('raw error'); }),
      });

      // FAILS: errors are thrown raw without wrapping (per TODO)
      try {
        await pipeline.execute(createBaseContext());
      } catch (error: any) {
        expect(error.stepName).toBe('mystery-step');
      }
    });
  });

  describe('shouldContinue behavior', () => {
    it('should stop pipeline when shouldContinue is set to false by a step', async () => {
      const { pipeline } = createPipeline();
      const afterStop = vi.fn();

      pipeline.registerStep({
        step: createStep('stopper', 100, async (ctx) => {
          return { ...ctx, shouldContinue: false };
        }),
      });
      pipeline.registerStep({
        step: createStep('after', 200, async (ctx) => { afterStop(); return ctx; }),
      });

      await pipeline.execute(createBaseContext());
      expect(afterStop).not.toHaveBeenCalled();
    });

    it('should return context with shouldContinue=false preserved', async () => {
      const { pipeline } = createPipeline();

      pipeline.registerStep({
        step: createStep('stopper', 100, async (ctx) => {
          return { ...ctx, shouldContinue: false, data: { reason: 'done' } };
        }),
      });

      const result = await pipeline.execute(createBaseContext());
      expect(result.shouldContinue).toBe(false);
      expect(result.data.reason).toBe('done');
    });

    it('should not emit STEP_START for steps after shouldContinue=false', async () => {
      const { pipeline, eventBus } = createPipeline();

      pipeline.registerStep({
        step: createStep('stopper', 100, async (ctx) => ({ ...ctx, shouldContinue: false })),
      });
      pipeline.registerStep({ step: createStep('skipped', 200) });

      await pipeline.execute(createBaseContext());

      const stepStarts = eventBus.allEmitted<{ stepName: string }>(CoreEvents.STEP_START);
      const stepNames = stepStarts.map(p => p.stepName);
      expect(stepNames).toContain('stopper');
      expect(stepNames).not.toContain('skipped');
    });

    it('should check shouldContinue before each step, not after', async () => {
      const { pipeline } = createPipeline();
      const executionOrder: string[] = [];

      pipeline.registerStep({
        step: createStep('first', 100, async (ctx) => {
          executionOrder.push('first');
          return { ...ctx, shouldContinue: false };
        }),
      });
      pipeline.registerStep({
        step: createStep('second', 200, async (ctx) => {
          executionOrder.push('second');
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());
      // shouldContinue is checked before step "second" executes
      expect(executionOrder).toEqual(['first']);
    });

    it('should respect initial shouldContinue=false in context', async () => {
      const { pipeline } = createPipeline();
      const reached = vi.fn();

      pipeline.registerStep({
        step: createStep('should-not-run', 100, async (ctx) => { reached(); return ctx; }),
      });

      await pipeline.execute(createBaseContext({ shouldContinue: false }));
      expect(reached).not.toHaveBeenCalled();
    });
  });

  describe('Cleanup on error', () => {
    it('should still allow cleanup after pipeline error', async () => {
      const { pipeline } = createPipeline();
      const cleanupFn = vi.fn().mockResolvedValue(undefined);

      const step: IStep = {
        name: 'error-step',
        description: 'throws',
        priority: 100,
        execute: async () => { throw new Error('fail'); },
        cleanup: cleanupFn,
      };

      pipeline.registerStep({ step });
      try { await pipeline.execute(createBaseContext()); } catch {}

      // cleanup is separate from execute - caller must invoke
      await pipeline.cleanup();
      expect(cleanupFn).toHaveBeenCalledOnce();
    });

    it('should call cleanup on all steps even if one cleanup throws', async () => {
      const { pipeline } = createPipeline();
      const secondCleanup = vi.fn().mockResolvedValue(undefined);

      pipeline.registerStep({
        step: {
          name: 'fail-cleanup',
          description: '',
          priority: 100,
          execute: async (ctx) => ctx,
          cleanup: vi.fn().mockRejectedValue(new Error('cleanup error')),
        },
      });
      pipeline.registerStep({
        step: {
          name: 'ok-cleanup',
          description: '',
          priority: 200,
          execute: async (ctx) => ctx,
          cleanup: secondCleanup,
        },
      });

      // FAILS: cleanup doesn't handle individual step cleanup errors
      try { await pipeline.cleanup(); } catch {}
      expect(secondCleanup).toHaveBeenCalledOnce();
    });

    it('should emit cleanup error events', async () => {
      const { pipeline, eventBus } = createPipeline();

      pipeline.registerStep({
        step: {
          name: 'bad-cleanup',
          description: '',
          priority: 100,
          execute: async (ctx) => ctx,
          cleanup: vi.fn().mockRejectedValue(new Error('cleanup failed')),
        },
      });

      // FAILS: cleanup doesn't emit error events
      try { await pipeline.cleanup(); } catch {}
      expect(eventBus.emitted(CoreEvents.STEP_ERROR)).toBe(true);
    });

    it('should auto-cleanup pipeline resources when execution fails', async () => {
      const { pipeline } = createPipeline();
      const cleanupFn = vi.fn().mockResolvedValue(undefined);

      pipeline.registerStep({
        step: {
          name: 'setup',
          description: 'acquires resources',
          priority: 100,
          execute: async (ctx) => ctx,
          cleanup: cleanupFn,
        },
      });
      pipeline.registerStep({
        step: createStep('crasher', 200, async () => { throw new Error('crash'); }),
      });

      // FAILS: execute() doesn't auto-call cleanup on error
      try { await pipeline.execute(createBaseContext()); } catch {}
      expect(cleanupFn).toHaveBeenCalledOnce();
    });
  });
});
