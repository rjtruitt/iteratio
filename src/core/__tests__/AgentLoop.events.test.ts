import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentLoop } from '../AgentLoop';
import { StepPipeline } from '../StepPipeline';
import { MockEventBus } from '../../__test__/MockEventBus';
import { MockStateManager } from '../../__test__/MockStateManager';
import { MockMessageManager } from '../../__test__/MockMessageManager';
import { CoreEvents } from '../../interfaces/IEventBus';
import type { ILogger } from '../../interfaces/ILogger';
import type { StepContext } from '../../interfaces/IStep';

// --- Test Helpers ---

function createMockLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockPipeline() {
  const pipeline = Object.create(StepPipeline.prototype);
  pipeline['steps'] = new Map();
  pipeline['stepOrder'] = [];
  pipeline['logger'] = createMockLogger();
  pipeline['eventBus'] = new MockEventBus();
  return pipeline as StepPipeline;
}

function createAgentLoop(overrides: {
  eventBus?: MockEventBus;
  pipeline?: StepPipeline;
} = {}) {
  const messageManager = new MockMessageManager();
  const stateManager = new MockStateManager();
  const eventBus = overrides.eventBus ?? new MockEventBus();
  const logger = createMockLogger();
  const pipeline = overrides.pipeline ?? createMockPipeline();

  const loop = Object.create(AgentLoop.prototype);
  loop['messageManager'] = messageManager;
  loop['stateManager'] = stateManager;
  loop['eventBus'] = eventBus;
  loop['logger'] = logger;
  loop['stepPipeline'] = pipeline;
  loop['plugins'] = [];
  loop['turnNumber'] = 0;
  loop['isRunning'] = false;

  return { loop: loop as AgentLoop, eventBus, pipeline, messageManager, stateManager };
}

// --- Test Suites ---

describe('AgentLoop - Events', () => {
  describe('TURN_START', () => {
    it('should emit TURN_START at the beginning of runTurn', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('hello');
      expect(eventBus.emitted(CoreEvents.TURN_START)).toBe(true);
    });

    it('should include turnNumber in TURN_START payload', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('hello');
      const payload = eventBus.lastEmitted<{ turnNumber: number; input: string }>(CoreEvents.TURN_START);
      expect(payload?.turnNumber).toBe(1);
    });

    it('should include input in TURN_START payload', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('my question');
      const payload = eventBus.lastEmitted<{ turnNumber: number; input: string }>(CoreEvents.TURN_START);
      expect(payload?.input).toBe('my question');
    });

    it('should emit TURN_START before pipeline execution', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      const order: string[] = [];

      eventBus.on(CoreEvents.TURN_START, () => order.push('turn_start'));
      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        order.push('pipeline_execute');
        return { ...ctx, llmResponse: { content: 'ok' } };
      });

      await loop.runTurn('input');
      expect(order).toEqual(['turn_start', 'pipeline_execute']);
    });

    it('should emit TURN_START with incrementing turnNumber on successive calls', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('first');
      await loop.runTurn('second');

      const allPayloads = eventBus.allEmitted<{ turnNumber: number }>(CoreEvents.TURN_START);
      expect(allPayloads[0].turnNumber).toBe(1);
      expect(allPayloads[1].turnNumber).toBe(2);
    });
  });

  describe('TURN_END', () => {
    it('should emit TURN_END after successful runTurn', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'response text' },
      });

      await loop.runTurn('input');
      expect(eventBus.emitted(CoreEvents.TURN_END)).toBe(true);
    });

    it('should include turnNumber in TURN_END payload', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('input');
      const payload = eventBus.lastEmitted<{ turnNumber: number; response: string }>(CoreEvents.TURN_END);
      expect(payload?.turnNumber).toBe(1);
    });

    it('should include response in TURN_END payload', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'the answer is 42' },
      });

      await loop.runTurn('input');
      const payload = eventBus.lastEmitted<{ turnNumber: number; response: string }>(CoreEvents.TURN_END);
      expect(payload?.response).toBe('the answer is 42');
    });

    it('should emit TURN_END after pipeline execution', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      const order: string[] = [];

      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        order.push('pipeline_execute');
        return { ...ctx, llmResponse: { content: 'ok' } };
      });
      eventBus.on(CoreEvents.TURN_END, () => order.push('turn_end'));

      await loop.runTurn('input');
      expect(order).toEqual(['pipeline_execute', 'turn_end']);
    });

    it('should not emit TURN_END when pipeline throws', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('fail'));

      try { await loop.runTurn('input'); } catch {}
      expect(eventBus.emitted(CoreEvents.TURN_END)).toBe(false);
    });
  });

  describe('TURN_ERROR', () => {
    it('should emit TURN_ERROR when pipeline throws', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('pipeline error'));

      try { await loop.runTurn('input'); } catch {}
      expect(eventBus.emitted(CoreEvents.TURN_ERROR)).toBe(true);
    });

    it('should include turnNumber in TURN_ERROR payload', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('fail'));

      try { await loop.runTurn('input'); } catch {}
      const payload = eventBus.lastEmitted<{ turnNumber: number; error: unknown }>(CoreEvents.TURN_ERROR);
      expect(payload?.turnNumber).toBe(1);
    });

    it('should include error in TURN_ERROR payload', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      const error = new Error('specific error message');
      vi.spyOn(pipeline, 'execute').mockRejectedValue(error);

      try { await loop.runTurn('input'); } catch {}
      const payload = eventBus.lastEmitted<{ turnNumber: number; error: Error }>(CoreEvents.TURN_ERROR);
      expect(payload?.error).toBe(error);
    });

    it('should emit TURN_ERROR even for non-Error throws', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue('string error');

      try { await loop.runTurn('input'); } catch {}
      expect(eventBus.emitted(CoreEvents.TURN_ERROR)).toBe(true);
    });
  });

  describe('LOOP_START', () => {
    it('should emit LOOP_START when run() is called', async () => {
      const { loop, eventBus } = createAgentLoop();
      await loop.run();
      expect(eventBus.emitted(CoreEvents.LOOP_START)).toBe(true);
    });

    it('should emit LOOP_START before any turns execute', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      const order: string[] = [];

      eventBus.on(CoreEvents.LOOP_START, () => order.push('loop_start'));
      eventBus.on(CoreEvents.TURN_START, () => order.push('turn_start'));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: false, data: {}, llmResponse: { content: 'done' },
      });

      await loop.run({ maxTurns: 1 });
      // FAILS: run() is a stub that doesn't execute turns
      expect(order[0]).toBe('loop_start');
      expect(order[1]).toBe('turn_start');
    });

    it('should emit LOOP_START exactly once per run() call', async () => {
      const { loop, eventBus } = createAgentLoop();
      await loop.run();
      expect(eventBus.emittedCount(CoreEvents.LOOP_START)).toBe(1);
    });
  });

  describe('LOOP_END', () => {
    it('should emit LOOP_END when run() completes successfully', async () => {
      const { loop, eventBus } = createAgentLoop();
      await loop.run();
      expect(eventBus.emitted(CoreEvents.LOOP_END)).toBe(true);
    });

    it('should emit LOOP_END even when run() throws', async () => {
      const { loop, eventBus } = createAgentLoop();
      // Force an error inside run()
      (loop as any).eventBus = {
        ...eventBus,
        emit: (event: string, data: any) => {
          eventBus.emit(event, data);
          if (event === CoreEvents.LOOP_START) throw new Error('forced');
        },
      };

      try { await loop.run(); } catch {}
      // FAILS: the overridden eventBus causes issues but tests the finally block
      expect(eventBus.emitted(CoreEvents.LOOP_END)).toBe(true);
    });

    it('should emit LOOP_END after all turns complete', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      const order: string[] = [];

      eventBus.on(CoreEvents.TURN_END, () => order.push('turn_end'));
      eventBus.on(CoreEvents.LOOP_END, () => order.push('loop_end'));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: false, data: {}, llmResponse: { content: 'done' },
      });

      await loop.run({ maxTurns: 1 });
      // FAILS: run() stub doesn't actually execute turns
      const turnEndIdx = order.indexOf('turn_end');
      const loopEndIdx = order.indexOf('loop_end');
      expect(turnEndIdx).toBeLessThan(loopEndIdx);
    });
  });

  describe('LOOP_ERROR', () => {
    it('should emit LOOP_ERROR when run() encounters an error', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('turn failed'));

      // FAILS: run() stub doesn't call pipeline.execute
      try { await loop.run({ maxTurns: 1 }); } catch {}
      expect(eventBus.emitted(CoreEvents.LOOP_ERROR)).toBe(true);
    });

    it('should include error in LOOP_ERROR payload', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      const error = new Error('loop failure');
      vi.spyOn(pipeline, 'execute').mockRejectedValue(error);

      try { await loop.run({ maxTurns: 1 }); } catch {}
      const payload = eventBus.lastEmitted<{ error: Error }>(CoreEvents.LOOP_ERROR);
      // FAILS: run() stub doesn't call pipeline
      expect(payload?.error).toBe(error);
    });
  });

  describe('Event ordering', () => {
    it('should emit events in order: TURN_START -> TURN_END for success', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('input');

      const events = eventBus.emittedEvents.map(e => e.event);
      const startIdx = events.indexOf(CoreEvents.TURN_START);
      const endIdx = events.indexOf(CoreEvents.TURN_END);
      expect(startIdx).toBeLessThan(endIdx);
    });

    it('should emit events in order: TURN_START -> TURN_ERROR for failure', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('fail'));

      try { await loop.runTurn('input'); } catch {}

      const events = eventBus.emittedEvents.map(e => e.event);
      const startIdx = events.indexOf(CoreEvents.TURN_START);
      const errorIdx = events.indexOf(CoreEvents.TURN_ERROR);
      expect(startIdx).toBeLessThan(errorIdx);
    });

    it('should emit LOOP_START before LOOP_END', async () => {
      const { loop, eventBus } = createAgentLoop();
      await loop.run();

      const events = eventBus.emittedEvents.map(e => e.event);
      const startIdx = events.indexOf(CoreEvents.LOOP_START);
      const endIdx = events.indexOf(CoreEvents.LOOP_END);
      expect(startIdx).toBeLessThan(endIdx);
    });
  });
});
