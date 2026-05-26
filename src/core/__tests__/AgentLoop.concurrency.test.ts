import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentLoop } from '../AgentLoop';
import { StepPipeline } from '../StepPipeline';
import { MockEventBus } from '../../__test__/MockEventBus';
import { MockStateManager } from '../../__test__/MockStateManager';
import { MockMessageManager } from '../../__test__/MockMessageManager';
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

function createAgentLoop() {
  const messageManager = new MockMessageManager();
  const stateManager = new MockStateManager();
  const eventBus = new MockEventBus();
  const logger = createMockLogger();
  const pipeline = createMockPipeline();

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

describe('AgentLoop - Concurrency', () => {
  describe('runTurn during active run()', () => {
    it.todo('should throw when runTurn is called while run() is active (requires mutex — see TODO in AgentLoop.ts)');

    it.todo('should reject with a descriptive error message for concurrent access (requires mutex)');

    it('should allow runTurn after run() completes', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.run();
      // run() sets isRunning back to false
      const result = await loop.runTurn('after run');
      expect(result).toBe('ok');
    });
  });

  describe('Concurrent runTurn calls', () => {
    it.todo('should not allow two runTurn calls to execute simultaneously (requires mutex)');

    it.todo('should queue concurrent runTurn calls and execute sequentially (requires queue)');

    it('should maintain correct turnNumber ordering under concurrent calls', async () => {
      const { loop, pipeline } = createAgentLoop();
      const turnNumbers: number[] = [];

      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        turnNumbers.push(ctx.turnNumber);
        return { ...ctx, llmResponse: { content: 'ok' } };
      });

      // Fire 5 concurrent calls
      await Promise.allSettled([
        loop.runTurn('a'),
        loop.runTurn('b'),
        loop.runTurn('c'),
        loop.runTurn('d'),
        loop.runTurn('e'),
      ]);

      // Each should have a unique turn number (1-5) regardless of execution order
      expect(new Set(turnNumbers).size).toBe(5);
      expect(turnNumbers.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it.todo('should reject concurrent runTurn with an appropriate error (requires mutex)');
  });

  describe('isRunning state tracking', () => {
    it('should report isRunning=true during run() execution', async () => {
      const { loop } = createAgentLoop();
      let statesDuringRun: boolean[] = [];

      // Intercept to check state mid-execution
      const originalRun = loop.run.bind(loop);
      // We can check via event
      const eventBus = (loop as any).eventBus as MockEventBus;
      eventBus.on('loop:start', () => {
        statesDuringRun.push(loop.getState().isRunning);
      });

      await loop.run();
      expect(statesDuringRun[0]).toBe(true);
    });

    it('should report isRunning=false after run() completes', async () => {
      const { loop } = createAgentLoop();
      await loop.run();
      expect(loop.getState().isRunning).toBe(false);
    });

    it('should report isRunning=false after run() throws', async () => {
      const { loop, pipeline } = createAgentLoop();
      // Force an error by making run() internals fail
      const eventBus = (loop as any).eventBus;
      const origEmit = eventBus.emit.bind(eventBus);
      let callCount = 0;
      eventBus.emit = (event: string, data: any) => {
        origEmit(event, data);
        callCount++;
        if (event === 'loop:start') throw new Error('forced');
      };

      try { await loop.run(); } catch {}
      expect(loop.getState().isRunning).toBe(false);
    });

    it('should not set isRunning during individual runTurn calls', async () => {
      const { loop, pipeline } = createAgentLoop();
      let wasRunningDuringTurn = false;

      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        wasRunningDuringTurn = loop.getState().isRunning;
        return { ...ctx, llmResponse: { content: 'ok' } };
      });

      await loop.runTurn('input');
      // runTurn doesn't set isRunning (only run() does)
      expect(wasRunningDuringTurn).toBe(false);
    });

    it('should track isRunning accurately across multiple sequential runs', async () => {
      const { loop } = createAgentLoop();

      await loop.run();
      expect(loop.getState().isRunning).toBe(false);

      await loop.run();
      expect(loop.getState().isRunning).toBe(false);
    });
  });

  describe('Shutdown during active execution', () => {
    it.todo('should wait for in-flight turn to complete before cleanup (requires in-flight tracking — see TODO in AgentLoop.ts)');

    it.todo('should reject new runTurn calls after shutdown is initiated (requires post-shutdown guard)');

    it.todo('should cancel pending queued turns on shutdown (requires queue + cancellation)');
  });

  describe('Adversarial: Race Conditions', () => {
    it.todo('should handle two runTurn calls interleaved (mutex needed)');

    it.todo('should handle shutdown during LLM call (response arrives after shutdown)');

    it('should handle plugin added between step execution and plugin notification', async () => {
      const { loop, pipeline } = createAgentLoop();
      const latePlugin = { name: 'late', version: '1.0.0', initialize: vi.fn(), onStep: vi.fn() };

      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        // Plugin is added mid-step execution
        (loop as any).plugins.push(latePlugin);
        return { ...ctx, llmResponse: { content: 'ok' } };
      });

      await loop.runTurn('input');

      // onStep is not called by the loop (only beforeTurn/afterTurn are lifecycle hooks)
      expect(latePlugin.onStep).not.toHaveBeenCalled();
    });

    it.todo('should handle state read-then-write without lock (stale state overwrite)');

    it.todo('should handle message added during message compression');

    it.todo('should handle event emitted after all listeners removed (mid-emit removal)');

    it.todo('should handle concurrent getState and setState causing torn reads');

    it.todo('should handle turn completion and new turn start at exact same tick');
  });
});
