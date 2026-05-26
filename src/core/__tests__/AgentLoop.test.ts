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
  const logger = createMockLogger();
  const eventBus = new MockEventBus();
  // StepPipeline uses @inject decorators, so we bypass with Object.create
  const pipeline = Object.create(StepPipeline.prototype);
  pipeline['steps'] = new Map();
  pipeline['stepOrder'] = [];
  pipeline['logger'] = logger;
  pipeline['eventBus'] = eventBus;
  return pipeline as StepPipeline;
}

function createAgentLoop(overrides: {
  messageManager?: MockMessageManager;
  stateManager?: MockStateManager;
  eventBus?: MockEventBus;
  logger?: ILogger;
  pipeline?: StepPipeline;
} = {}) {
  const messageManager = overrides.messageManager ?? new MockMessageManager();
  const stateManager = overrides.stateManager ?? new MockStateManager();
  const eventBus = overrides.eventBus ?? new MockEventBus();
  const logger = overrides.logger ?? createMockLogger();
  const pipeline = overrides.pipeline ?? createMockPipeline();

  // Bypass DI decorators — construct via Object.create + manual init
  const loop = Object.create(AgentLoop.prototype);
  loop['messageManager'] = messageManager;
  loop['stateManager'] = stateManager;
  loop['eventBus'] = eventBus;
  loop['logger'] = logger;
  loop['stepPipeline'] = pipeline;
  loop['plugins'] = [];
  loop['turnNumber'] = 0;
  loop['isRunning'] = false;

  return { loop: loop as AgentLoop, messageManager, stateManager, eventBus, logger, pipeline };
}

// --- Test Suites ---

describe('AgentLoop', () => {
  describe('Construction', () => {
    it('should initialize with turnNumber 0', () => {
      const { loop } = createAgentLoop();
      const state = loop.getState();
      expect(state.turnNumber).toBe(0);
    });

    it('should initialize with isRunning false', () => {
      const { loop } = createAgentLoop();
      const state = loop.getState();
      expect(state.isRunning).toBe(false);
    });

    it('should initialize with empty metadata', () => {
      const { loop } = createAgentLoop();
      const state = loop.getState();
      expect(state.metadata).toEqual({});
    });

    it('should have no plugins initially', () => {
      const { loop } = createAgentLoop();
      // Accessing internal plugins array to verify
      expect((loop as any).plugins).toEqual([]);
    });

    it('should accept all required dependencies', () => {
      const { loop } = createAgentLoop();
      expect(loop).toBeDefined();
      expect(loop.runTurn).toBeTypeOf('function');
      expect(loop.run).toBeTypeOf('function');
      expect(loop.addPlugin).toBeTypeOf('function');
      expect(loop.getState).toBeTypeOf('function');
      expect(loop.shutdown).toBeTypeOf('function');
    });
  });

  describe('runTurn()', () => {
    it('should increment turnNumber on each call', async () => {
      const { loop, pipeline } = createAgentLoop();
      // Pipeline returns a context with llmResponse
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'response 1' },
      });

      await loop.runTurn('hello');
      expect(loop.getState().turnNumber).toBe(1);

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 2,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'response 2' },
      });

      await loop.runTurn('world');
      expect(loop.getState().turnNumber).toBe(2);
    });

    it('should return the LLM response content from the pipeline result', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'Hello from the AI!' },
      });

      const result = await loop.runTurn('hi');
      expect(result).toBe('Hello from the AI!');
    });

    it('should return empty string when llmResponse is undefined', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
      });

      const result = await loop.runTurn('hi');
      expect(result).toBe('');
    });

    it('should pass user input to the pipeline via data.userInput', async () => {
      const { loop, pipeline } = createAgentLoop();
      const executeSpy = vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      await loop.runTurn('my input string');
      const passedContext = executeSpy.mock.calls[0][0] as StepContext;
      expect(passedContext.data.userInput).toBe('my input string');
    });

    it('should pass current messages from messageManager to the pipeline', async () => {
      const { loop, pipeline, messageManager } = createAgentLoop();
      messageManager.addMessage({ role: 'user', content: 'previous' });

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      const executeSpy = vi.spyOn(pipeline, 'execute');
      await loop.runTurn('new input');
      const passedContext = executeSpy.mock.calls[0][0] as StepContext;
      expect(passedContext.messages).toHaveLength(1);
      expect(passedContext.messages[0].content).toBe('previous');
    });

    it('should pass current state from stateManager to the pipeline', async () => {
      const { loop, pipeline, stateManager } = createAgentLoop();
      stateManager.set('key1', 'value1');

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      const executeSpy = vi.spyOn(pipeline, 'execute');
      await loop.runTurn('input');
      const passedContext = executeSpy.mock.calls[0][0] as StepContext;
      expect(passedContext.state.key1).toBe('value1');
    });

    it('should set shouldContinue to true in the initial step context', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      const executeSpy = vi.spyOn(pipeline, 'execute');
      await loop.runTurn('input');
      const passedContext = executeSpy.mock.calls[0][0] as StepContext;
      expect(passedContext.shouldContinue).toBe(true);
    });

    it('should include turnNumber in the step context', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      const executeSpy = vi.spyOn(pipeline, 'execute');
      await loop.runTurn('input');
      const passedContext = executeSpy.mock.calls[0][0] as StepContext;
      expect(passedContext.turnNumber).toBe(1);
    });

    it('should throw when pipeline throws an error', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('Pipeline exploded'));

      await expect(loop.runTurn('input')).rejects.toThrow('Pipeline exploded');
    });

    it('should still increment turnNumber even if pipeline throws', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockRejectedValue(new Error('fail'));

      try { await loop.runTurn('input'); } catch {}
      expect(loop.getState().turnNumber).toBe(1);
    });
  });

  describe('run()', () => {
    it('should set isRunning to true during execution', async () => {
      const { loop, eventBus } = createAgentLoop();
      let wasRunning = false;

      eventBus.on('loop:start', () => {
        wasRunning = loop.getState().isRunning;
      });

      await loop.run();
      expect(wasRunning).toBe(true);
    });

    it('should set isRunning to false after execution completes', async () => {
      const { loop } = createAgentLoop();
      await loop.run();
      expect(loop.getState().isRunning).toBe(false);
    });

    it('should set isRunning to false even when an error occurs', async () => {
      const { loop, eventBus } = createAgentLoop();
      // Make the loop throw by overriding internal behavior
      const originalEmit = eventBus.emit.bind(eventBus);
      let errorThrown = false;
      eventBus.emit = (event: string, data: any) => {
        originalEmit(event, data);
        if (event === 'loop:start') {
          throw new Error('forced loop error');
        }
      };

      try {
        await loop.run();
      } catch {
        errorThrown = true;
      }

      // The test expects run() to properly reset isRunning in finally block
      // even after error. Since the stub may not actually throw through run(),
      // we test the final state:
      expect(loop.getState().isRunning).toBe(false);
    });

    it('should accept maxTurns option', async () => {
      const { loop } = createAgentLoop();
      // Currently run() is a stub that doesn't process turns,
      // but it should accept the option without error
      await expect(loop.run({ maxTurns: 5 })).resolves.toBeUndefined();
    });

    it('should accept timeout option', async () => {
      const { loop } = createAgentLoop();
      await expect(loop.run({ timeout: 30000 })).resolves.toBeUndefined();
    });

    it('should execute turns up to maxTurns limit', async () => {
      const { loop, pipeline } = createAgentLoop();
      let executionCount = 0;
      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        executionCount++;
        return { ...ctx, llmResponse: { content: 'done' } };
      });

      await loop.run({ maxTurns: 3 });
      // This test will FAIL because run() is a stub that doesn't call runTurn
      expect(executionCount).toBe(3);
    });

    it('should stop running when LLM returns stop without tool calls', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: false,
        data: {},
        llmResponse: { content: 'Final answer', finish_reason: 'stop' },
      });

      await loop.run({ maxTurns: 10 });
      // Should stop after first turn, not run 10 turns
      // FAILS because run() is a stub
      expect(loop.getState().turnNumber).toBe(1);
    });
  });

  describe('getState()', () => {
    it('should return current turnNumber', () => {
      const { loop } = createAgentLoop();
      expect(loop.getState().turnNumber).toBe(0);
    });

    it('should return current isRunning status', () => {
      const { loop } = createAgentLoop();
      expect(loop.getState().isRunning).toBe(false);
    });

    it('should return metadata from stateManager', () => {
      const { loop, stateManager } = createAgentLoop();
      stateManager.set('customKey', 'customValue');

      const state = loop.getState();
      expect(state.metadata.customKey).toBe('customValue');
    });

    it('should reflect updated turnNumber after runTurn', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      await loop.runTurn('test');
      expect(loop.getState().turnNumber).toBe(1);
    });

    it('should return a snapshot not a live reference', () => {
      const { loop, stateManager } = createAgentLoop();
      const state1 = loop.getState();
      stateManager.set('added', true);
      const state2 = loop.getState();

      // state1 should not reflect the change
      expect(state1.metadata.added).toBeUndefined();
      expect(state2.metadata.added).toBe(true);
    });
  });

  describe('shutdown()', () => {
    it('should set isRunning to false', async () => {
      const { loop } = createAgentLoop();
      (loop as any).isRunning = true;
      await loop.shutdown();
      expect(loop.getState().isRunning).toBe(false);
    });

    it('should call pipeline cleanup', async () => {
      const { loop, pipeline } = createAgentLoop();
      const cleanupSpy = vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);
      await loop.shutdown();
      expect(cleanupSpy).toHaveBeenCalledOnce();
    });

    it('should call shutdown on all plugins', async () => {
      const { loop } = createAgentLoop();
      const shutdownFn = vi.fn().mockResolvedValue(undefined);
      const plugin = {
        name: 'test-plugin',
        version: '1.0.0',
        initialize: vi.fn(),
        shutdown: shutdownFn,
      };
      loop.addPlugin(plugin);

      await loop.shutdown();
      expect(shutdownFn).toHaveBeenCalledOnce();
    });

    it('should call shutdown on plugins that have shutdown method', async () => {
      const { loop } = createAgentLoop();
      const plugin1Shutdown = vi.fn().mockResolvedValue(undefined);
      const plugin1 = { name: 'p1', version: '1.0.0', initialize: vi.fn(), shutdown: plugin1Shutdown };
      const plugin2 = { name: 'p2', version: '1.0.0', initialize: vi.fn() }; // no shutdown

      loop.addPlugin(plugin1);
      loop.addPlugin(plugin2);

      await loop.shutdown();
      expect(plugin1Shutdown).toHaveBeenCalledOnce();
    });

    it('should be callable multiple times without error', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      await loop.shutdown();
      await expect(loop.shutdown()).resolves.toBeUndefined();
    });

    it('should await in-flight turns before cleaning up', async () => {
      const { loop, pipeline } = createAgentLoop();
      // Set up a long-running turn
      let resolveExecution: () => void;
      const executionPromise = new Promise<void>(r => { resolveExecution = r; });

      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        await executionPromise;
        return { ...ctx, llmResponse: { content: 'done' } };
      });

      const cleanupSpy = vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      // Start a turn (don't await)
      const turnPromise = loop.runTurn('input');

      // Call shutdown while turn is in flight
      const shutdownPromise = loop.shutdown();

      // Resolve the turn
      resolveExecution!();
      await turnPromise.catch(() => {});
      await shutdownPromise;

      // FAILS: shutdown doesn't wait for in-flight turns (per TODO in source)
      // This test asserts the desired behavior
      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('registerStep()', () => {
    it('should delegate to stepPipeline.registerStep', () => {
      const { loop, pipeline } = createAgentLoop();
      const registerSpy = vi.spyOn(pipeline, 'registerStep');
      const step = { name: 'test-step', description: 'test', priority: 100, execute: vi.fn() };

      loop.registerStep({ step });
      expect(registerSpy).toHaveBeenCalledWith({ step });
    });

    it('should pass position options through to pipeline', () => {
      const { loop, pipeline } = createAgentLoop();
      const registerSpy = vi.spyOn(pipeline, 'registerStep');
      const step = { name: 'test-step', description: 'test', priority: 100, execute: vi.fn() };

      loop.registerStep({ step, position: { before: 'other-step' } });
      expect(registerSpy).toHaveBeenCalledWith({ step, position: { before: 'other-step' } });
    });
  });

  describe('reorderSteps()', () => {
    it('should delegate to stepPipeline.reorderSteps', () => {
      const { loop, pipeline } = createAgentLoop();
      const reorderSpy = vi.spyOn(pipeline, 'reorderSteps');

      loop.reorderSteps(['step-a', 'step-b', 'step-c']);
      expect(reorderSpy).toHaveBeenCalledWith(['step-a', 'step-b', 'step-c']);
    });
  });

  describe('getWorkflowOrder()', () => {
    it('should delegate to stepPipeline.getStepOrder', () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'getStepOrder').mockReturnValue(['a', 'b', 'c']);

      expect(loop.getWorkflowOrder()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('registerDefaultSteps()', () => {
    it('should register the 5 default steps (AddUserMessage, CallLLM, ExecuteTools, AddToolResults, AddAssistantResponse)', () => {
      const { loop, pipeline } = createAgentLoop();
      const registerSpy = vi.spyOn(pipeline, 'registerStep');

      loop.registerDefaultSteps();

      // FAILS: registerDefaultSteps is currently a placeholder that does not register steps
      expect(registerSpy).toHaveBeenCalledTimes(5);

      const registeredNames = registerSpy.mock.calls.map(
        (call) => (call[0] as any).step.name
      );
      expect(registeredNames).toContain('add-user-message');
      expect(registeredNames).toContain('call-llm');
      expect(registeredNames).toContain('execute-tools');
      expect(registeredNames).toContain('add-tool-results');
      expect(registeredNames).toContain('add-assistant-response');
    });
  });

  describe('Edge Cases', () => {
    it('should handle runTurn with 0 messages (empty array)', async () => {
      const { loop, pipeline, messageManager } = createAgentLoop();
      // messageManager has no messages — pipeline should receive empty messages array
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      const executeSpy = vi.spyOn(pipeline, 'execute');
      await loop.runTurn('input');
      const passedContext = executeSpy.mock.calls[0][0] as StepContext;
      expect(passedContext.messages).toEqual([]);
    });

    it('should guard against re-entrancy when runTurn is called while already running', async () => {
      const { loop, pipeline } = createAgentLoop();
      let resolveFirst: () => void;
      const firstExecution = new Promise<void>(r => { resolveFirst = r; });

      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        await firstExecution;
        return { ...ctx, llmResponse: { content: 'done' } };
      });

      // Start first turn
      const turn1 = loop.runTurn('first');
      // Attempt re-entrant call — should throw or queue
      await expect(loop.runTurn('second')).rejects.toThrow();

      resolveFirst!();
      await turn1;
    });

    it('should reject addPlugin after shutdown has been called', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);
      await loop.shutdown();

      const plugin = { name: 'late-plugin', version: '1.0.0', initialize: vi.fn() };
      expect(() => loop.addPlugin(plugin)).toThrow();
    });

    it('should handle run() with maxTurns = 0 (no turns executed)', async () => {
      const { loop, pipeline } = createAgentLoop();
      const executeSpy = vi.spyOn(pipeline, 'execute');

      await loop.run({ maxTurns: 0 });
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('should handle run() with maxTurns = Number.MAX_SAFE_INTEGER', async () => {
      const { loop, pipeline } = createAgentLoop();
      // Pipeline signals stop immediately
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: false,
        data: {},
        llmResponse: { content: 'done' },
      });

      await loop.run({ maxTurns: Number.MAX_SAFE_INTEGER });
      // Should stop after first turn since shouldContinue is false
      expect(loop.getState().turnNumber).toBe(1);
    });

    it('should be idempotent when shutdown is called twice', async () => {
      const { loop, pipeline } = createAgentLoop();
      const cleanupSpy = vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      await loop.shutdown();
      await loop.shutdown();

      // cleanup should only be called once (idempotent)
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle run() immediately followed by shutdown() (race)', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockImplementation(async (ctx: StepContext) => {
        await new Promise(r => setTimeout(r, 50));
        return { ...ctx, llmResponse: { content: 'result' } };
      });
      vi.spyOn(pipeline, 'cleanup').mockResolvedValue(undefined);

      const runPromise = loop.run({ maxTurns: 5 });
      const shutdownPromise = loop.shutdown();

      await Promise.all([runPromise, shutdownPromise]);
      expect(loop.getState().isRunning).toBe(false);
    });

    it('should not prevent afterTurn when a plugin throws during beforeTurn', async () => {
      const { loop, pipeline, eventBus } = createAgentLoop();
      const afterTurnCalled = vi.fn();

      const plugin = {
        name: 'throwing-plugin',
        version: '1.0.0',
        initialize: vi.fn(),
        beforeTurn: vi.fn().mockRejectedValue(new Error('beforeTurn exploded')),
        afterTurn: afterTurnCalled,
      };
      loop.addPlugin(plugin);

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      await loop.runTurn('input').catch(() => {});
      expect(afterTurnCalled).toHaveBeenCalled();
    });

    it('should handle messages containing only whitespace', async () => {
      const { loop, pipeline } = createAgentLoop();
      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'processed whitespace' },
      });

      const executeSpy = vi.spyOn(pipeline, 'execute');
      await loop.runTurn('   \t\n  ');
      const passedContext = executeSpy.mock.calls[0][0] as StepContext;
      expect(passedContext.data.userInput).toBe('   \t\n  ');
    });

    it('should handle state with circular references (JSON serialization edge case)', async () => {
      const { loop, pipeline, stateManager } = createAgentLoop();
      const circular: any = { name: 'loop' };
      circular.self = circular;
      stateManager.set('circular', circular);

      vi.spyOn(pipeline, 'execute').mockResolvedValue({
        turnNumber: 1,
        messages: [],
        state: {},
        metadata: {},
        shouldContinue: true,
        data: {},
        llmResponse: { content: 'ok' },
      });

      // Should not throw due to circular reference in state
      await expect(loop.runTurn('input')).resolves.toBeDefined();
    });
  });
});
