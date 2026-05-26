import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentLoop } from '../AgentLoop';
import { StepPipeline } from '../StepPipeline';
import { MockEventBus } from '../../__test__/MockEventBus';
import { MockStateManager } from '../../__test__/MockStateManager';
import { MockMessageManager } from '../../__test__/MockMessageManager';
import { CoreEvents } from '../../interfaces/IEventBus';
import type { ILogger } from '../../interfaces/ILogger';
import type { IPlugin } from '../../interfaces/IPlugin';
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

  return { loop: loop as AgentLoop, eventBus, pipeline, messageManager, stateManager, logger };
}

function createMockPlugin(name: string, overrides: Partial<IPlugin> = {}): IPlugin {
  return {
    name,
    version: '1.0.0',
    initialize: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// --- Test Suites ---

describe('AgentLoop - Error Handling', () => {
  describe('Pipeline errors', () => {
    it('should emit TURN_ERROR when pipeline throws an Error', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('step failed'));

      try { await loop.runTurn('input'); } catch {}
      expect(eventBus.emitted(CoreEvents.TURN_ERROR)).toBe(true);
    });

    it('should re-throw the pipeline error to the caller', async () => {
      const { loop, pipeline } = createAgentLoop();
      const error = new Error('critical failure');
      vi.spyOn(pipeline, 'execute').mockRejectedValue(error);

      await expect(loop.runTurn('input')).rejects.toThrow('critical failure');
    });

    it('should log the error via logger.error', async () => {
      const { loop, pipeline, logger } = createAgentLoop();
      const error = new Error('logged error');
      vi.spyOn(pipeline, 'execute').mockRejectedValue(error);

      try { await loop.runTurn('input'); } catch {}
      expect(logger.error).toHaveBeenCalledWith('Turn execution failed', error);
    });

    it('should include error object in TURN_ERROR event payload', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      const error = new Error('payload test');
      vi.spyOn(pipeline, 'execute').mockRejectedValue(error);

      try { await loop.runTurn('input'); } catch {}
      const payload = eventBus.lastEmitted<{ turnNumber: number; error: unknown }>(CoreEvents.TURN_ERROR);
      expect(payload?.error).toBe(error);
    });

    it('should handle non-Error throws (string)', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue('string error');

      try { await loop.runTurn('input'); } catch {}
      expect(eventBus.emitted(CoreEvents.TURN_ERROR)).toBe(true);
    });

    it('should pass the raw thrown value to logger.error (no normalization)', async () => {
      const { loop, pipeline, logger } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue('just a string');

      try { await loop.runTurn('input'); } catch {}
      // Current behavior: logger.error receives the raw thrown value cast as Error
      const errorArg = (logger.error as any).mock.calls[0][1];
      expect(errorArg).toBe('just a string');
    });

    it('should handle non-Error throws (number)', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(42);

      // Should still throw (rethrow the original)
      await expect(loop.runTurn('input')).rejects.toBe(42);
    });

    it('should handle non-Error throws (object)', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      const errorObj = { code: 'ERR_TIMEOUT', message: 'timed out' };
      vi.spyOn(pipeline, 'execute').mockRejectedValue(errorObj);

      try { await loop.runTurn('input'); } catch {}
      const payload = eventBus.lastEmitted<{ error: unknown }>(CoreEvents.TURN_ERROR);
      expect(payload?.error).toBe(errorObj);
    });

    it('should handle null/undefined throws', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(null);

      await expect(loop.runTurn('input')).rejects.toBeNull();
    });
  });

  describe('Plugin beforeTurn errors', () => {
    it('should propagate error when beforeTurn plugin throws', async () => {
      const { loop, pipeline } = createAgentLoop();
      loop.addPlugin(createMockPlugin('failing-plugin', {
        beforeTurn: vi.fn().mockRejectedValue(new Error('beforeTurn failed')),
      }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await expect(loop.runTurn('input')).rejects.toThrow('beforeTurn failed');
    });

    it('should emit TURN_ERROR when beforeTurn plugin throws', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      loop.addPlugin(createMockPlugin('failing-plugin', {
        beforeTurn: vi.fn().mockRejectedValue(new Error('hook error')),
      }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      try { await loop.runTurn('input'); } catch {}
      expect(eventBus.emitted(CoreEvents.TURN_ERROR)).toBe(true);
    });

    it('should not execute pipeline when beforeTurn throws', async () => {
      const { loop, pipeline } = createAgentLoop();
      loop.addPlugin(createMockPlugin('blocker', {
        beforeTurn: vi.fn().mockRejectedValue(new Error('blocked')),
      }));

      const executeSpy = vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      try { await loop.runTurn('input'); } catch {}
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('should stop calling subsequent plugin beforeTurn hooks on error', async () => {
      const { loop, pipeline } = createAgentLoop();
      const secondBeforeTurn = vi.fn().mockResolvedValue(undefined);

      loop.addPlugin(createMockPlugin('first', {
        beforeTurn: vi.fn().mockRejectedValue(new Error('first failed')),
      }));
      loop.addPlugin(createMockPlugin('second', { beforeTurn: secondBeforeTurn }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      try { await loop.runTurn('input'); } catch {}
      expect(secondBeforeTurn).not.toHaveBeenCalled();
    });
  });

  describe('Plugin afterTurn errors', () => {
    it('should propagate error when afterTurn plugin throws', async () => {
      const { loop, pipeline } = createAgentLoop();
      loop.addPlugin(createMockPlugin('failing-plugin', {
        afterTurn: vi.fn().mockRejectedValue(new Error('afterTurn failed')),
      }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await expect(loop.runTurn('input')).rejects.toThrow('afterTurn failed');
    });

    it('should emit TURN_ERROR when afterTurn plugin throws', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      loop.addPlugin(createMockPlugin('failing-plugin', {
        afterTurn: vi.fn().mockRejectedValue(new Error('after error')),
      }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      try { await loop.runTurn('input'); } catch {}
      // afterTurn error is caught by the general catch block which emits TURN_ERROR
      expect(eventBus.emitted(CoreEvents.TURN_ERROR)).toBe(true);
    });

    it('should not emit TURN_END when afterTurn throws', async () => {
      const { loop, eventBus, pipeline } = createAgentLoop();
      loop.addPlugin(createMockPlugin('failing-plugin', {
        afterTurn: vi.fn().mockRejectedValue(new Error('after error')),
      }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      try { await loop.runTurn('input'); } catch {}
      // afterTurn throws before TURN_END is emitted, so TURN_END should not appear
      expect(eventBus.emitted(CoreEvents.TURN_END)).toBe(false);
    });
  });

  describe('Shutdown errors', () => {
    it('should handle pipeline cleanup throwing an error', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockRejectedValue(new Error('cleanup failed'));

      await expect(loop.shutdown()).rejects.toThrow('cleanup failed');
    });

    it('should not attempt plugin shutdown if pipeline cleanup fails (current behavior)', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockRejectedValue(new Error('cleanup failed'));

      const pluginShutdown = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('resilient', { shutdown: pluginShutdown }));

      try { await loop.shutdown(); } catch {}
      // Current behavior: pipeline.cleanup() throws, stopping shutdown before plugins are reached
      expect(pluginShutdown).not.toHaveBeenCalled();
    });

    it('should stop calling subsequent plugin shutdowns when one throws (current behavior)', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      const secondShutdown = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('failing', {
        shutdown: vi.fn().mockRejectedValue(new Error('plugin crash')),
      }));
      loop.addPlugin(createMockPlugin('succeeding', { shutdown: secondShutdown }));

      // Current behavior: first plugin throws, error propagates, second never called
      try { await loop.shutdown(); } catch {}
      expect(secondShutdown).not.toHaveBeenCalled();
    });

    it('should throw the first plugin shutdown error (no aggregation)', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      loop.addPlugin(createMockPlugin('fail-1', {
        shutdown: vi.fn().mockRejectedValue(new Error('error 1')),
      }));
      loop.addPlugin(createMockPlugin('fail-2', {
        shutdown: vi.fn().mockRejectedValue(new Error('error 2')),
      }));

      // Current behavior: throws the first error, no aggregation
      await expect(loop.shutdown()).rejects.toThrow('error 1');
    });
  });

  describe('Adversarial: Resource Exhaustion', () => {
    it.todo('should terminate when LLM returns infinitely growing response (streaming never stops)');

    it.todo('should bound memory when plugin beforeTurn allocates unbounded memory each call');

    it.todo('should handle tool execution that creates circular reference chain consuming memory');

    it.todo('should detect and break infinite tool call loop (tool A calls tool B which calls tool A)');

    it.todo('should trigger compression when message history grows without bound');

    it.todo('should prevent event listener registration leak (never unsubscribed)');

    it.todo('should handle step pipeline with step that spawns exponential work');

    it.todo('should enforce termination when maxTurns is not set (no termination condition)');

    it('should not enter infinite cascade when error handler throws', async () => {
      const { loop, pipeline, eventBus } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('initial error'));

      // Register an error handler that itself throws
      eventBus.on(CoreEvents.TURN_ERROR, () => {
        throw new Error('error in error handler');
      });

      // The handler throw propagates but doesn't recurse infinitely
      // because emit is synchronous and the catch block only emits once
      await expect(loop.runTurn('input')).rejects.toThrow();
    });

    it.todo('should cap state that doubles in size every persist cycle');
  });
});
