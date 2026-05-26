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

function createStep(name: string, priority: number): IStep {
  return {
    name,
    description: `Step: ${name}`,
    priority,
    execute: async (ctx: StepContext) => ctx,
  };
}

function createBaseContext(): StepContext {
  return {
    turnNumber: 1,
    messages: [],
    state: {},
    metadata: {},
    shouldContinue: true,
    data: {},
  };
}

// --- Test Suites ---

describe('StepPipeline - Ordering', () => {
  describe('Priority-based ordering', () => {
    it('should order steps by ascending priority', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('mid', 200) });
      pipeline.registerStep({ step: createStep('high', 300) });
      pipeline.registerStep({ step: createStep('low', 100) });

      const order = pipeline.getStepOrder();
      const lowIdx = order.indexOf('low');
      const midIdx = order.indexOf('mid');
      const highIdx = order.indexOf('high');

      expect(lowIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(highIdx);
    });

    it('should maintain insertion order for equal priorities', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('first-100', 100) });
      pipeline.registerStep({ step: createStep('second-100', 100) });
      pipeline.registerStep({ step: createStep('third-100', 100) });

      const order = pipeline.getStepOrder();
      expect(order).toEqual(['first-100', 'second-100', 'third-100']);
    });

    it('should handle default step priorities (100, 200, 300, 400, 500)', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('add-user-message', 100) });
      pipeline.registerStep({ step: createStep('call-llm', 200) });
      pipeline.registerStep({ step: createStep('execute-tools', 300) });
      pipeline.registerStep({ step: createStep('add-tool-results', 400) });
      pipeline.registerStep({ step: createStep('add-assistant-response', 500) });

      expect(pipeline.getStepOrder()).toEqual([
        'add-user-message',
        'call-llm',
        'execute-tools',
        'add-tool-results',
        'add-assistant-response',
      ]);
    });

    it('should allow inserting between default priorities (150, 250, etc)', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('step-100', 100) });
      pipeline.registerStep({ step: createStep('step-200', 200) });
      pipeline.registerStep({ step: createStep('step-150', 150) }); // inserted between

      const order = pipeline.getStepOrder();
      const idx100 = order.indexOf('step-100');
      const idx150 = order.indexOf('step-150');
      const idx200 = order.indexOf('step-200');

      expect(idx100).toBeLessThan(idx150);
      expect(idx150).toBeLessThan(idx200);
    });

    it('should handle priority 0 (first position)', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('normal', 100) });
      pipeline.registerStep({ step: createStep('first', 0) });

      expect(pipeline.getStepOrder()[0]).toBe('first');
    });

    it('should handle very high priority (last position)', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('normal', 100) });
      pipeline.registerStep({ step: createStep('last', 9999) });

      const order = pipeline.getStepOrder();
      expect(order[order.length - 1]).toBe('last');
    });

    it('should override step priority with position.priority', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('high-default', 500) });
      // step has priority 500 but position overrides to 50
      pipeline.registerStep({ step: createStep('overridden', 500), position: { priority: 50 } });

      const order = pipeline.getStepOrder();
      expect(order.indexOf('overridden')).toBeLessThan(order.indexOf('high-default'));
    });
  });

  describe('Before/After positioning', () => {
    it('should insert step immediately before target', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });
      pipeline.registerStep({ step: createStep('c', 300) });
      pipeline.registerStep({ step: createStep('before-b', 150), position: { before: 'b' } });

      const order = pipeline.getStepOrder();
      expect(order.indexOf('before-b')).toBe(order.indexOf('b') - 1);
    });

    it('should insert step immediately after target', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });
      pipeline.registerStep({ step: createStep('c', 300) });
      pipeline.registerStep({ step: createStep('after-b', 250), position: { after: 'b' } });

      const order = pipeline.getStepOrder();
      expect(order.indexOf('after-b')).toBe(order.indexOf('b') + 1);
    });

    it('should handle multiple before insertions at same target', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('target', 200) });
      pipeline.registerStep({ step: createStep('before-1', 100), position: { before: 'target' } });
      pipeline.registerStep({ step: createStep('before-2', 100), position: { before: 'target' } });

      const order = pipeline.getStepOrder();
      const targetIdx = order.indexOf('target');
      expect(order.indexOf('before-1')).toBeLessThan(targetIdx);
      expect(order.indexOf('before-2')).toBeLessThan(targetIdx);
    });

    it('should handle multiple after insertions at same target', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('target', 200) });
      pipeline.registerStep({ step: createStep('after-1', 300), position: { after: 'target' } });
      pipeline.registerStep({ step: createStep('after-2', 300), position: { after: 'target' } });

      const order = pipeline.getStepOrder();
      const targetIdx = order.indexOf('target');
      expect(order.indexOf('after-1')).toBeGreaterThan(targetIdx);
      expect(order.indexOf('after-2')).toBeGreaterThan(targetIdx);
    });

    it('should warn and append when before target does not exist', () => {
      const { pipeline, logger } = createPipeline();
      pipeline.registerStep({ step: createStep('existing', 100) });
      pipeline.registerStep({ step: createStep('orphan', 200), position: { before: 'ghost' } });

      expect(logger.warn).toHaveBeenCalled();
      const order = pipeline.getStepOrder();
      expect(order[order.length - 1]).toBe('orphan');
    });

    it('should warn and append when after target does not exist', () => {
      const { pipeline, logger } = createPipeline();
      pipeline.registerStep({ step: createStep('existing', 100) });
      pipeline.registerStep({ step: createStep('orphan', 200), position: { after: 'ghost' } });

      expect(logger.warn).toHaveBeenCalled();
      const order = pipeline.getStepOrder();
      expect(order[order.length - 1]).toBe('orphan');
    });
  });

  describe('Replace positioning', () => {
    it('should remove old step and add new one', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('original', 100) });
      pipeline.registerStep({ step: createStep('replacement', 100), position: { replace: 'original' } });

      expect(pipeline.getStep('original')).toBeUndefined();
      expect(pipeline.getStep('replacement')).toBeDefined();
    });

    it('should preserve the position of the replaced step', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });
      pipeline.registerStep({ step: createStep('c', 300) });
      pipeline.registerStep({ step: createStep('b-replacement', 200), position: { replace: 'b' } });

      // FAILS: replacement inserts based on priority, doesn't inherit position
      // The desired behavior is for replacement to take the exact slot
      const order = pipeline.getStepOrder();
      const aIdx = order.indexOf('a');
      const repIdx = order.indexOf('b-replacement');
      const cIdx = order.indexOf('c');
      expect(repIdx).toBeGreaterThan(aIdx);
      expect(repIdx).toBeLessThan(cIdx);
    });

    it('should handle replacing a non-existent step gracefully', () => {
      const { pipeline } = createPipeline();
      // Replacing something that doesn't exist should just add the new step
      pipeline.registerStep({ step: createStep('new', 100), position: { replace: 'nonexistent' } });
      expect(pipeline.getStep('new')).toBeDefined();
    });
  });

  describe('reorderSteps()', () => {
    it('should set the step order to the provided array', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });
      pipeline.registerStep({ step: createStep('c', 300) });

      pipeline.reorderSteps(['c', 'a', 'b']);
      expect(pipeline.getStepOrder()).toEqual(['c', 'a', 'b']);
    });

    it('should execute in new order after reorder', async () => {
      const { pipeline } = createPipeline();
      const executionOrder: string[] = [];

      pipeline.registerStep({
        step: { name: 'a', description: '', priority: 100, execute: async (ctx) => { executionOrder.push('a'); return ctx; } },
      });
      pipeline.registerStep({
        step: { name: 'b', description: '', priority: 200, execute: async (ctx) => { executionOrder.push('b'); return ctx; } },
      });
      pipeline.registerStep({
        step: { name: 'c', description: '', priority: 300, execute: async (ctx) => { executionOrder.push('c'); return ctx; } },
      });

      pipeline.reorderSteps(['c', 'b', 'a']);
      await pipeline.execute(createBaseContext());

      expect(executionOrder).toEqual(['c', 'b', 'a']);
    });

    it('should allow partial reorder (subset of steps)', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });
      pipeline.registerStep({ step: createStep('c', 300) });

      // Only include a and c — b is excluded
      pipeline.reorderSteps(['a', 'c']);
      expect(pipeline.getStepOrder()).toEqual(['a', 'c']);
    });

    it('should validate all step names exist in the reorder', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });

      // FAILS: reorderSteps doesn't validate (per TODO)
      expect(() => pipeline.reorderSteps(['a', 'nonexistent'])).toThrow();
    });

    it('should log the reorder operation', () => {
      const { pipeline, logger } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.reorderSteps(['a']);
      expect(logger.info).toHaveBeenCalled();
    });
  });

  describe('getStepOrder()', () => {
    it('should return current step order', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('x', 100) });
      pipeline.registerStep({ step: createStep('y', 200) });

      expect(pipeline.getStepOrder()).toEqual(['x', 'y']);
    });

    it('should return a defensive copy', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });

      const order = pipeline.getStepOrder();
      order.push('hacked');

      expect(pipeline.getStepOrder()).toEqual(['a']);
    });

    it('should reflect changes after registerStep', () => {
      const { pipeline } = createPipeline();
      expect(pipeline.getStepOrder()).toEqual([]);

      pipeline.registerStep({ step: createStep('added', 100) });
      expect(pipeline.getStepOrder()).toEqual(['added']);
    });

    it('should reflect changes after removeStep', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('removed', 100) });
      pipeline.removeStep('removed');
      expect(pipeline.getStepOrder()).toEqual([]);
    });

    it('should reflect changes after reorderSteps', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });

      pipeline.reorderSteps(['b', 'a']);
      expect(pipeline.getStepOrder()).toEqual(['b', 'a']);
    });
  });

  describe('Complex ordering scenarios', () => {
    it('should handle plugin inserting between default steps', () => {
      const { pipeline } = createPipeline();
      // Simulate default pipeline
      pipeline.registerStep({ step: createStep('add-user-message', 100) });
      pipeline.registerStep({ step: createStep('call-llm', 200) });
      pipeline.registerStep({ step: createStep('execute-tools', 300) });

      // Plugin inserts between add-user-message and call-llm
      pipeline.registerStep({
        step: createStep('validate-input', 150),
        position: { after: 'add-user-message' },
      });

      const order = pipeline.getStepOrder();
      const addMsgIdx = order.indexOf('add-user-message');
      const validateIdx = order.indexOf('validate-input');
      const callLlmIdx = order.indexOf('call-llm');

      expect(validateIdx).toBeGreaterThan(addMsgIdx);
      expect(validateIdx).toBeLessThan(callLlmIdx);
    });

    it('should handle replacing a step and inserting new ones around it', () => {
      const { pipeline } = createPipeline();
      pipeline.registerStep({ step: createStep('a', 100) });
      pipeline.registerStep({ step: createStep('b', 200) });
      pipeline.registerStep({ step: createStep('c', 300) });

      // Replace b with enhanced-b
      pipeline.registerStep({
        step: createStep('enhanced-b', 200),
        position: { replace: 'b' },
      });
      // Add pre-b step
      pipeline.registerStep({
        step: createStep('pre-b', 150),
        position: { before: 'enhanced-b' },
      });

      const order = pipeline.getStepOrder();
      expect(order).not.toContain('b');
      expect(order.indexOf('pre-b')).toBeLessThan(order.indexOf('enhanced-b'));
    });
  });
});
