import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentLoop } from '../AgentLoop';
import { StepPipeline } from '../StepPipeline';
import { MockEventBus } from '../../__test__/MockEventBus';
import { MockStateManager } from '../../__test__/MockStateManager';
import { MockMessageManager } from '../../__test__/MockMessageManager';
import type { ILogger } from '../../interfaces/ILogger';
import type { IPlugin, TurnContext } from '../../interfaces/IPlugin';
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

describe('AgentLoop - Plugins', () => {
  describe('addPlugin()', () => {
    it('should store the plugin', () => {
      const { loop } = createAgentLoop();
      const plugin = createMockPlugin('test-plugin');
      loop.addPlugin(plugin);
      expect((loop as any).plugins).toHaveLength(1);
      expect((loop as any).plugins[0]).toBe(plugin);
    });

    it('should store multiple plugins', () => {
      const { loop } = createAgentLoop();
      loop.addPlugin(createMockPlugin('plugin-a'));
      loop.addPlugin(createMockPlugin('plugin-b'));
      loop.addPlugin(createMockPlugin('plugin-c'));
      expect((loop as any).plugins).toHaveLength(3);
    });

    it('should preserve plugin insertion order', () => {
      const { loop } = createAgentLoop();
      loop.addPlugin(createMockPlugin('first'));
      loop.addPlugin(createMockPlugin('second'));
      loop.addPlugin(createMockPlugin('third'));

      const names = (loop as any).plugins.map((p: IPlugin) => p.name);
      expect(names).toEqual(['first', 'second', 'third']);
    });

    it('should reject duplicate plugin names', () => {
      const { loop } = createAgentLoop();
      loop.addPlugin(createMockPlugin('unique-name'));
      // FAILS: addPlugin doesn't check for duplicate names (per TODO)
      expect(() => loop.addPlugin(createMockPlugin('unique-name'))).toThrow();
    });

    it('should call plugin.initialize with container', async () => {
      const { loop } = createAgentLoop();
      const initializeFn = vi.fn().mockResolvedValue(undefined);
      const plugin = createMockPlugin('init-plugin', { initialize: initializeFn });

      loop.addPlugin(plugin);
      // FAILS: addPlugin doesn't call initialize (per TODO)
      expect(initializeFn).toHaveBeenCalled();
    });

    it('should emit plugin:added event', () => {
      const { loop, eventBus } = createAgentLoop();
      loop.addPlugin(createMockPlugin('my-plugin'));
      // FAILS: addPlugin doesn't emit event (per TODO)
      expect(eventBus.emitted('plugin:added')).toBe(true);
    });

    it('should call plugin.configure if config is provided', () => {
      const { loop } = createAgentLoop();
      const configureFn = vi.fn();
      const plugin = createMockPlugin('config-plugin', { configure: configureFn });

      // FAILS: no mechanism to pass config during addPlugin currently
      loop.addPlugin(plugin);
      // This tests the desired behavior where configure is called
      expect(configureFn).toHaveBeenCalled();
    });
  });

  describe('beforeTurn hooks', () => {
    it('should call beforeTurn on each plugin during runTurn', async () => {
      const { loop, pipeline } = createAgentLoop();
      const beforeTurnFn = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('hook-plugin', { beforeTurn: beforeTurnFn }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('input');
      expect(beforeTurnFn).toHaveBeenCalledOnce();
    });

    it('should call beforeTurn with TurnContext', async () => {
      const { loop, pipeline } = createAgentLoop();
      const beforeTurnFn = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('hook-plugin', { beforeTurn: beforeTurnFn }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('test input');
      const ctx = beforeTurnFn.mock.calls[0][0] as TurnContext;
      expect(ctx.turnNumber).toBe(1);
      expect(ctx.messages).toBeDefined();
      expect(ctx.state).toBeDefined();
      expect(ctx.metadata).toBeDefined();
    });

    it('should call beforeTurn on all plugins in order', async () => {
      const { loop, pipeline } = createAgentLoop();
      const callOrder: string[] = [];

      loop.addPlugin(createMockPlugin('plugin-a', {
        beforeTurn: vi.fn(async () => { callOrder.push('a'); }),
      }));
      loop.addPlugin(createMockPlugin('plugin-b', {
        beforeTurn: vi.fn(async () => { callOrder.push('b'); }),
      }));
      loop.addPlugin(createMockPlugin('plugin-c', {
        beforeTurn: vi.fn(async () => { callOrder.push('c'); }),
      }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('input');
      expect(callOrder).toEqual(['a', 'b', 'c']);
    });

    it('should call beforeTurn before pipeline execution', async () => {
      const { loop, pipeline } = createAgentLoop();
      const order: string[] = [];

      loop.addPlugin(createMockPlugin('timing-plugin', {
        beforeTurn: vi.fn(async () => { order.push('beforeTurn'); }),
      }));

      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        order.push('pipeline');
        return { ...ctx, llmResponse: { content: 'ok' } };
      });

      await loop.runTurn('input');
      expect(order).toEqual(['beforeTurn', 'pipeline']);
    });

    it('should skip plugins without beforeTurn', async () => {
      const { loop, pipeline } = createAgentLoop();
      const callOrder: string[] = [];

      loop.addPlugin(createMockPlugin('with-hook', {
        beforeTurn: vi.fn(async () => { callOrder.push('with-hook'); }),
      }));
      loop.addPlugin(createMockPlugin('no-hook')); // no beforeTurn

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('input');
      expect(callOrder).toEqual(['with-hook']);
    });

    it('should call beforeTurn on every turn', async () => {
      const { loop, pipeline } = createAgentLoop();
      const beforeTurnFn = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('counting-plugin', { beforeTurn: beforeTurnFn }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('turn 1');
      await loop.runTurn('turn 2');
      await loop.runTurn('turn 3');
      expect(beforeTurnFn).toHaveBeenCalledTimes(3);
    });
  });

  describe('afterTurn hooks', () => {
    it('should call afterTurn on each plugin during runTurn', async () => {
      const { loop, pipeline } = createAgentLoop();
      const afterTurnFn = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('hook-plugin', { afterTurn: afterTurnFn }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [{ role: 'assistant', content: 'hi' }],
        state: { key: 'val' }, metadata: { m: 1 },
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('input');
      expect(afterTurnFn).toHaveBeenCalledOnce();
    });

    it('should call afterTurn with result context data', async () => {
      const { loop, pipeline } = createAgentLoop();
      const afterTurnFn = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('hook-plugin', { afterTurn: afterTurnFn }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [{ role: 'assistant', content: 'response' }],
        state: { updated: true },
        metadata: { duration: 100 },
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'response' },
      });

      await loop.runTurn('input');
      const ctx = afterTurnFn.mock.calls[0][0] as TurnContext;
      expect(ctx.turnNumber).toBe(1);
      expect(ctx.messages).toEqual([{ role: 'assistant', content: 'response' }]);
      expect(ctx.state).toEqual({ updated: true });
      expect(ctx.metadata).toEqual({ duration: 100 });
    });

    it('should call afterTurn after pipeline execution', async () => {
      const { loop, pipeline } = createAgentLoop();
      const order: string[] = [];

      loop.addPlugin(createMockPlugin('timing-plugin', {
        afterTurn: vi.fn(async () => { order.push('afterTurn'); }),
      }));

      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        order.push('pipeline');
        return { ...ctx, llmResponse: { content: 'ok' } };
      });

      await loop.runTurn('input');
      expect(order).toEqual(['pipeline', 'afterTurn']);
    });

    it('should call afterTurn on all plugins in order', async () => {
      const { loop, pipeline } = createAgentLoop();
      const callOrder: string[] = [];

      loop.addPlugin(createMockPlugin('plugin-x', {
        afterTurn: vi.fn(async () => { callOrder.push('x'); }),
      }));
      loop.addPlugin(createMockPlugin('plugin-y', {
        afterTurn: vi.fn(async () => { callOrder.push('y'); }),
      }));

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {}, llmResponse: { content: 'ok' },
      });

      await loop.runTurn('input');
      expect(callOrder).toEqual(['x', 'y']);
    });

    it('should not call afterTurn when pipeline throws', async () => {
      const { loop, pipeline } = createAgentLoop();
      const afterTurnFn = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('hook-plugin', { afterTurn: afterTurnFn }));

      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('exploded'));

      try { await loop.runTurn('input'); } catch {}
      expect(afterTurnFn).not.toHaveBeenCalled();
    });
  });

  describe('Plugin shutdown', () => {
    it('should call shutdown on all plugins during loop shutdown', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      const shutdownA = vi.fn().mockResolvedValue(undefined);
      const shutdownB = vi.fn().mockResolvedValue(undefined);

      loop.addPlugin(createMockPlugin('plugin-a', { shutdown: shutdownA }));
      loop.addPlugin(createMockPlugin('plugin-b', { shutdown: shutdownB }));

      await loop.shutdown();
      expect(shutdownA).toHaveBeenCalledOnce();
      expect(shutdownB).toHaveBeenCalledOnce();
    });

    it('should call plugin shutdown in registration order', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      const order: string[] = [];
      loop.addPlugin(createMockPlugin('first', {
        shutdown: vi.fn(async () => { order.push('first'); }),
      }));
      loop.addPlugin(createMockPlugin('second', {
        shutdown: vi.fn(async () => { order.push('second'); }),
      }));

      await loop.shutdown();
      expect(order).toEqual(['first', 'second']);
    });

    it('should call pipeline cleanup before plugin shutdown', async () => {
      const { loop, pipeline } = createAgentLoop();
      const order: string[] = [];

      vi.spyOn(pipeline, 'cleanup').mockImplementation(async () => {
        order.push('pipeline_cleanup');
      });

      loop.addPlugin(createMockPlugin('plugin', {
        shutdown: vi.fn(async () => { order.push('plugin_shutdown'); }),
      }));

      await loop.shutdown();
      expect(order).toEqual(['pipeline_cleanup', 'plugin_shutdown']);
    });

    it('should handle plugins without shutdown method gracefully', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      loop.addPlugin(createMockPlugin('no-shutdown'));
      await expect(loop.shutdown()).resolves.toBeUndefined();
    });

    it('should continue shutting down remaining plugins if one throws', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      const secondShutdown = vi.fn().mockResolvedValue(undefined);
      loop.addPlugin(createMockPlugin('failing', {
        shutdown: vi.fn().mockRejectedValue(new Error('shutdown error')),
      }));
      loop.addPlugin(createMockPlugin('succeeding', { shutdown: secondShutdown }));

      // FAILS: shutdown doesn't have error handling for individual plugins
      try { await loop.shutdown(); } catch {}
      expect(secondShutdown).toHaveBeenCalledOnce();
    });
  });

  describe('Plugin interaction with pipeline', () => {
    it('should allow plugins to register steps via registerStep', () => {
      const { loop, pipeline } = createAgentLoop();
      const registerSpy = vi.spyOn(pipeline, 'registerStep');

      const step = { name: 'plugin-step', description: 'from plugin', priority: 150, execute: vi.fn() };
      const plugin = createMockPlugin('step-plugin', {
        initialize: vi.fn(async () => {
          loop.registerStep({ step });
        }),
      });

      loop.addPlugin(plugin);
      // FAILS: addPlugin doesn't call initialize
      expect(registerSpy).toHaveBeenCalledWith({ step });
    });

    it('should allow multiple plugins to register steps', () => {
      const { loop, pipeline } = createAgentLoop();
      const registerSpy = vi.spyOn(pipeline, 'registerStep');

      const stepA = { name: 'step-a', description: 'a', priority: 150, execute: vi.fn() };
      const stepB = { name: 'step-b', description: 'b', priority: 250, execute: vi.fn() };

      loop.addPlugin(createMockPlugin('plugin-a', {
        initialize: vi.fn(async () => { loop.registerStep({ step: stepA }); }),
      }));
      loop.addPlugin(createMockPlugin('plugin-b', {
        initialize: vi.fn(async () => { loop.registerStep({ step: stepB }); }),
      }));

      // FAILS: addPlugin doesn't call initialize
      expect(registerSpy).toHaveBeenCalledTimes(2);
    });
  });
});
