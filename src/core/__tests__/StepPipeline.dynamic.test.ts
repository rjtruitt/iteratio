import { describe, it, expect, vi } from 'vitest';
import { StepPipeline } from '../StepPipeline';
import { MockEventBus } from '../../__test__/MockEventBus';
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

describe('StepPipeline - Dynamic Modification', () => {
  describe('Adding steps after initial registration', () => {
    it('should allow registering new steps after initial setup', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('initial', 100) });

      // Later, add another step
      pipeline.registerStep({ step: createStep('dynamic', 200) });

      expect(pipeline.getStepOrder()).toContain('initial');
      expect(pipeline.getStepOrder()).toContain('dynamic');
    });

    it('should execute dynamically added steps', async () => {
      const { pipeline } = createPipeline();
      const executed: string[] = [];

      pipeline.registerStep({
        step: createStep('original', 100, async (ctx) => { executed.push('original'); return ctx; }),
      });

      // Simulate a plugin adding a step later
      pipeline.registerStep({
        step: createStep('late-addition', 200, async (ctx) => { executed.push('late-addition'); return ctx; }),
      });

      await pipeline.execute(createBaseContext());
      expect(executed).toEqual(['original', 'late-addition']);
    });

    it('should respect priority when adding steps dynamically', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('high', 500) });
      pipeline.registerStep({ step: createStep('low', 100) });
      // Add a mid-priority step dynamically
      pipeline.registerStep({ step: createStep('mid', 300) });

      const order = pipeline.getStepOrder();
      expect(order.indexOf('low')).toBeLessThan(order.indexOf('mid'));
      expect(order.indexOf('mid')).toBeLessThan(order.indexOf('high'));
    });

    it('should not affect currently executing pipeline when step is added mid-execution', async () => {
      const { pipeline } = createPipeline();
      const executed: string[] = [];

      pipeline.registerStep({
        step: createStep('adder', 100, async (ctx) => {
          executed.push('adder');
          // Dynamically add a step during execution
          pipeline.registerStep({
            step: createStep('dynamic-mid-execution', 150, async (innerCtx) => {
              executed.push('dynamic-mid-execution');
              return innerCtx;
            }),
          });
          return ctx;
        }),
      });
      pipeline.registerStep({
        step: createStep('after', 200, async (ctx) => { executed.push('after'); return ctx; }),
      });

      await pipeline.execute(createBaseContext());

      // FAILS: The pipeline iterates stepOrder which was mutated mid-execution
      // Desired: snapshot the order at start, don't execute dynamically added steps this run
      expect(executed).toEqual(['adder', 'after']);
    });

    it('should execute dynamically added step on next pipeline run', async () => {
      const { pipeline } = createPipeline();
      const executed: string[] = [];

      pipeline.registerStep({
        step: createStep('adder', 100, async (ctx) => {
          pipeline.registerStep({
            step: createStep('added-step', 150, async (innerCtx) => {
              executed.push('added-step');
              return innerCtx;
            }),
          });
          return ctx;
        }),
      });

      // First execution — adder runs, registers added-step
      await pipeline.execute(createBaseContext());

      // Second execution — added-step should now run
      await pipeline.execute(createBaseContext());
      expect(executed).toContain('added-step');
    });
  });

  describe('Removing steps dynamically', () => {
    it('should remove step from execution', async () => {
      const { pipeline } = createPipeline();
      const executed: string[] = [];

      pipeline.registerStep({
        step: createStep('a', 100, async (ctx) => { executed.push('a'); return ctx; }),
      });
      pipeline.registerStep({
        step: createStep('b', 200, async (ctx) => { executed.push('b'); return ctx; }),
      });

      pipeline.removeStep('b');
      await pipeline.execute(createBaseContext());
      expect(executed).toEqual(['a']);
    });

    it('should handle removing a step that is referenced by before/after', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('anchor', 200) });
      pipeline.registerStep({ step: createStep('relative', 150), position: { before: 'anchor' } });

      // Remove the anchor — relative should still execute
      pipeline.removeStep('anchor');
      expect(pipeline.getStepOrder()).toContain('relative');
      expect(pipeline.getStepOrder()).not.toContain('anchor');
    });

    it('should not throw when removing a non-existent step', () => {
      const { pipeline } = createPipeline();
      expect(() => pipeline.removeStep('ghost')).not.toThrow();
    });

    it('should prevent removed step from executing even if stepOrder is stale', async () => {
      const { pipeline } = createPipeline();
      const executed: string[] = [];

      pipeline.registerStep({
        step: createStep('removable', 100, async (ctx) => { executed.push('removable'); return ctx; }),
      });

      // Force stale state: add name to order without a step in the map
      (pipeline as any).stepOrder.push('phantom');

      await pipeline.execute(createBaseContext());
      // phantom should be skipped since it has no step in the map
      expect(executed).toEqual(['removable']);
    });
  });

  describe('Hot-swapping step implementations', () => {
    it('should allow replacing a step implementation at runtime', async () => {
      const { pipeline } = createPipeline();
      const results: string[] = [];

      pipeline.registerStep({
        step: createStep('swappable', 100, async (ctx) => {
          results.push('v1');
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());
      expect(results).toEqual(['v1']);

      // Hot-swap with a new implementation
      pipeline.registerStep({
        step: createStep('swappable', 100, async (ctx) => {
          results.push('v2');
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());
      expect(results).toEqual(['v1', 'v2']);
    });

    it('should maintain step position after hot-swap', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('before', 100) });
      pipeline.registerStep({ step: createStep('target', 200) });
      pipeline.registerStep({ step: createStep('after', 300) });

      const originalOrder = pipeline.getStepOrder();

      // Hot-swap target with same name
      pipeline.registerStep({ step: createStep('target', 200) });

      // FAILS: re-registering may duplicate in stepOrder or change position
      // Desired: position should remain the same
      const newOrder = pipeline.getStepOrder();
      expect(newOrder.indexOf('target')).toBe(originalOrder.indexOf('target'));
      expect(newOrder.filter(n => n === 'target')).toHaveLength(1);
    });

    it('should use new implementation immediately on next execute', async () => {
      const { pipeline } = createPipeline();
      let version = 'old';

      pipeline.registerStep({
        step: createStep('versioned', 100, async (ctx) => {
          return { ...ctx, data: { ...ctx.data, version } };
        }),
      });

      const result1 = await pipeline.execute(createBaseContext());
      expect(result1.data.version).toBe('old');

      version = 'new';
      // The step still references the closure, so new value is picked up
      const result2 = await pipeline.execute(createBaseContext());
      expect(result2.data.version).toBe('new');
    });

    it('should call cleanup on old step before swapping', async () => {
      const { pipeline } = createPipeline();
      const oldCleanup = vi.fn().mockResolvedValue(undefined);

      pipeline.registerStep({
        step: {
          name: 'swappable',
          description: 'old version',
          priority: 100,
          execute: async (ctx) => ctx,
          cleanup: oldCleanup,
        },
      });

      // Hot-swap
      // FAILS: registerStep doesn't call cleanup on replaced step
      pipeline.registerStep({
        step: createStep('swappable', 100, async (ctx) => ctx),
      });

      expect(oldCleanup).toHaveBeenCalledOnce();
    });

    it('should not allow hot-swap during active execution', async () => {
      const { pipeline } = createPipeline();
      let swapAttempted = false;

      pipeline.registerStep({
        step: createStep('running', 100, async (ctx) => {
          // Attempt to swap while executing
          try {
            pipeline.registerStep({ step: createStep('running', 100) });
            swapAttempted = true;
          } catch {
            swapAttempted = false;
          }
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());

      // FAILS: no guard against modification during execution
      // Desired: throw or queue the swap
      expect(swapAttempted).toBe(false);
    });
  });

  describe('Dynamic modification safety', () => {
    it('should snapshot step order at start of execute', async () => {
      const { pipeline } = createPipeline();
      const executed: string[] = [];

      pipeline.registerStep({
        step: createStep('modifier', 100, async (ctx) => {
          executed.push('modifier');
          // Remove a later step during execution
          pipeline.removeStep('victim');
          return ctx;
        }),
      });
      pipeline.registerStep({
        step: createStep('victim', 200, async (ctx) => {
          executed.push('victim');
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());

      // FAILS: pipeline doesn't snapshot — removal takes effect immediately
      // Desired: victim should still execute since it was in the order at start
      expect(executed).toContain('victim');
    });

    it('should provide a lock mechanism during execution', async () => {
      const { pipeline } = createPipeline();

      pipeline.registerStep({
        step: createStep('test', 100, async (ctx) => {
          // FAILS: no isExecuting flag or lock mechanism
          expect((pipeline as any).isExecuting).toBe(true);
          return ctx;
        }),
      });

      await pipeline.execute(createBaseContext());
    });

    it('should queue modifications made during execution', async () => {
      const { pipeline } = createPipeline();

      pipeline.registerStep({
        step: createStep('adder', 100, async (ctx) => {
          pipeline.registerStep({ step: createStep('queued', 150) });
          return ctx;
        }),
      });
      pipeline.registerStep({ step: createStep('existing', 200) });

      await pipeline.execute(createBaseContext());

      // FAILS: no queuing mechanism — step is added immediately to the live structure
      // After execution completes, queued step should be present
      expect(pipeline.getStepOrder()).toContain('queued');
      // But it should NOT have been executed in this run
    });
  });
});
