import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockEventBus,
  MockStateManager,
  MockPlugin,
  createMockPlugin,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 30: Plugin Composition ---
// Tests multiple plugins active simultaneously: ordering, shared state,
// conflict resolution, hot-add, removal, dependencies, and error isolation.

describe('E2E Scenario 30: Plugin Composition', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let llm: MockLLMProvider;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    llm = ctx.llm;
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  describe('Multiple Plugins Active', () => {
    it('should support 5 plugins all active simultaneously', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const plugins = [
        createMockPlugin('workflow'),
        createMockPlugin('memory'),
        createMockPlugin('metrics'),
        createMockPlugin('tracing'),
        createMockPlugin('constraints'),
      ];

      for (const p of plugins) agent.addPlugin(p);
      agent.start();

      await agent.runTurn('test');

      // All 5 plugins should have been called
      for (const p of plugins) {
        expect(p.beforeTurnCalls.length).toBe(1);
        expect(p.afterTurnCalls.length).toBe(1);
      }
    });

    it('should call all plugin beforeTurn hooks before any step executes', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const executionOrder: string[] = [];

      const plugin1 = createMockPlugin('plugin-1');
      plugin1.beforeTurn = async () => { executionOrder.push('plugin-1:beforeTurn'); };
      const plugin2 = createMockPlugin('plugin-2');
      plugin2.beforeTurn = async () => { executionOrder.push('plugin-2:beforeTurn'); };

      agent.addPlugin(plugin1);
      agent.addPlugin(plugin2);
      agent.onStepExecute(() => executionOrder.push('step:execute'));
      agent.start();

      await agent.runTurn('test');

      const stepIdx = executionOrder.indexOf('step:execute');
      const plugin1Idx = executionOrder.indexOf('plugin-1:beforeTurn');
      const plugin2Idx = executionOrder.indexOf('plugin-2:beforeTurn');

      expect(plugin1Idx).toBeLessThan(stepIdx);
      expect(plugin2Idx).toBeLessThan(stepIdx);
    });

    it('should call all plugin afterTurn hooks after steps complete', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const executionOrder: string[] = [];

      const plugin = createMockPlugin('after-check');
      plugin.afterTurn = async () => { executionOrder.push('afterTurn'); };

      agent.addPlugin(plugin);
      agent.onStepComplete(() => executionOrder.push('step:complete'));
      agent.start();

      await agent.runTurn('test');

      const stepComplete = executionOrder.indexOf('step:complete');
      const afterTurn = executionOrder.indexOf('afterTurn');

      expect(afterTurn).toBeGreaterThan(stepComplete);
    });
  });

  describe('Plugin Ordering', () => {
    it('should execute memory plugin beforeTurn before workflow plugin beforeTurn', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const executionOrder: string[] = [];

      const memoryPlugin = createMockPlugin('memory');
      memoryPlugin.beforeTurn = async () => { executionOrder.push('memory:beforeTurn'); };

      const workflowPlugin = createMockPlugin('workflow');
      workflowPlugin.beforeTurn = async () => { executionOrder.push('workflow:beforeTurn'); };

      // Register with explicit priority (lower = earlier)
      agent.addPlugin(memoryPlugin, { priority: 1 });
      agent.addPlugin(workflowPlugin, { priority: 2 });
      agent.start();

      await agent.runTurn('test');

      expect(executionOrder.indexOf('memory:beforeTurn')).toBeLessThan(
        executionOrder.indexOf('workflow:beforeTurn')
      );
    });

    it('should respect plugin registration order when priorities are equal', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const executionOrder: string[] = [];

      const pluginA = createMockPlugin('alpha');
      pluginA.beforeTurn = async () => { executionOrder.push('alpha'); };

      const pluginB = createMockPlugin('beta');
      pluginB.beforeTurn = async () => { executionOrder.push('beta'); };

      agent.addPlugin(pluginA);
      agent.addPlugin(pluginB);
      agent.start();

      await agent.runTurn('test');

      expect(executionOrder).toEqual(['alpha', 'beta']);
    });

    it('should allow explicit ordering override', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const executionOrder: string[] = [];

      const first = createMockPlugin('first');
      first.beforeTurn = async () => { executionOrder.push('first'); };

      const second = createMockPlugin('second');
      second.beforeTurn = async () => { executionOrder.push('second'); };

      // Register second first, but give it higher priority number (= later)
      agent.addPlugin(second, { priority: 10 });
      agent.addPlugin(first, { priority: 1 });
      agent.start();

      await agent.runTurn('test');

      expect(executionOrder).toEqual(['first', 'second']);
    });
  });

  describe('Shared State Between Plugins', () => {
    it('should allow plugin A to write state that plugin B reads', async () => {
      const agent = stateManager.get<any>('agentLoop');
      let readValue: string | undefined;

      const writerPlugin = createMockPlugin('writer');
      writerPlugin.beforeTurn = async (ctx: any) => {
        ctx.pluginState.set('shared-key', 'written-by-writer');
      };

      const readerPlugin = createMockPlugin('reader');
      readerPlugin.beforeTurn = async (ctx: any) => {
        readValue = ctx.pluginState.get('shared-key');
      };

      agent.addPlugin(writerPlugin, { priority: 1 }); // runs first
      agent.addPlugin(readerPlugin, { priority: 2 }); // runs second
      agent.start();

      await agent.runTurn('test');

      expect(readValue).toBe('written-by-writer');
    });

    it('should isolate plugin state namespaces to prevent accidental collisions', async () => {
      const agent = stateManager.get<any>('agentLoop');

      const plugin1 = createMockPlugin('plugin-1');
      plugin1.beforeTurn = async (ctx: any) => {
        ctx.pluginState.set('plugin-1:count', '1');
      };

      const plugin2 = createMockPlugin('plugin-2');
      plugin2.beforeTurn = async (ctx: any) => {
        ctx.pluginState.set('plugin-2:count', '2');
      };

      agent.addPlugin(plugin1);
      agent.addPlugin(plugin2);
      agent.start();

      await agent.runTurn('test');

      // Each plugin's state should be independent
      const state = agent.getPluginState();
      expect(state.get('plugin-1:count')).toBe('1');
      expect(state.get('plugin-2:count')).toBe('2');
    });

    it('should persist shared plugin state across turns', async () => {
      const agent = stateManager.get<any>('agentLoop');
      let turnCount = 0;

      const counterPlugin = createMockPlugin('counter');
      counterPlugin.beforeTurn = async (ctx: any) => {
        const prev = parseInt(ctx.pluginState.get('counter:turns') ?? '0');
        ctx.pluginState.set('counter:turns', String(prev + 1));
        turnCount = prev + 1;
      };

      agent.addPlugin(counterPlugin);
      agent.start();

      await agent.runTurn('first');
      await agent.runTurn('second');
      await agent.runTurn('third');

      expect(turnCount).toBe(3);
    });
  });

  describe('Plugin Conflict Resolution', () => {
    it('should handle two plugins modifying same system message with defined behavior', async () => {
      const agent = stateManager.get<any>('agentLoop');

      const plugin1 = createMockPlugin('constraints');
      plugin1.beforeTurn = async (ctx: any) => {
        ctx.systemMessage += '\nConstraint: be concise';
      };

      const plugin2 = createMockPlugin('persona');
      plugin2.beforeTurn = async (ctx: any) => {
        ctx.systemMessage += '\nPersona: friendly assistant';
      };

      agent.addPlugin(plugin1, { priority: 1 });
      agent.addPlugin(plugin2, { priority: 2 });
      agent.start();

      await agent.runTurn('test');

      const systemMsg = agent.getCurrentSystemMessage();
      // Both modifications should be present (last-writer-wins or append)
      expect(systemMsg).toContain('Constraint: be concise');
      expect(systemMsg).toContain('Persona: friendly assistant');
    });

    it('should detect conflict and emit warning when plugins overwrite same field', async () => {
      const agent = stateManager.get<any>('agentLoop');

      const plugin1 = createMockPlugin('plugin-1');
      plugin1.beforeTurn = async (ctx: any) => {
        ctx.maxTokens = 100;
      };

      const plugin2 = createMockPlugin('plugin-2');
      plugin2.beforeTurn = async (ctx: any) => {
        ctx.maxTokens = 500; // overwrites plugin-1
      };

      agent.addPlugin(plugin1, { priority: 1 });
      agent.addPlugin(plugin2, { priority: 2 });
      agent.enableConflictDetection();
      agent.start();

      await agent.runTurn('test');

      expect(eventBus.emitted('plugin:conflict')).toBe(true);
      const conflict = eventBus.lastEmitted<any>('plugin:conflict');
      expect(conflict.field).toBe('maxTokens');
      expect(conflict.plugins).toContain('plugin-1');
      expect(conflict.plugins).toContain('plugin-2');
    });
  });

  describe('Hot-Add Plugin', () => {
    it('should add plugin to a running agent loop', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      await agent.runTurn('before plugin');

      const newPlugin = createMockPlugin('hot-added');
      agent.addPlugin(newPlugin);

      await agent.runTurn('after plugin');

      expect(newPlugin.beforeTurnCalls.length).toBe(1);
    });

    it('should initialize hot-added plugin before first use', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      const plugin = createMockPlugin('late-joiner');
      agent.addPlugin(plugin);

      expect(plugin.initializeCalls).toBe(1);
    });

    it('should not affect current turn when plugin is added mid-turn', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const midTurnPlugin = createMockPlugin('mid-turn');
      agent.start();

      // Start a turn
      const turnPromise = agent.runTurn('in-progress');

      // Add plugin during turn execution
      agent.addPlugin(midTurnPlugin);

      await turnPromise;

      // Plugin should not have been called for this turn
      expect(midTurnPlugin.beforeTurnCalls.length).toBe(0);
    });
  });

  describe('Plugin Removal', () => {
    it('should remove plugin and stop calling its hooks', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const plugin = createMockPlugin('removable');

      agent.addPlugin(plugin);
      agent.start();

      await agent.runTurn('with plugin');
      expect(plugin.beforeTurnCalls.length).toBe(1);

      agent.removePlugin('removable');

      await agent.runTurn('without plugin');
      expect(plugin.beforeTurnCalls.length).toBe(1); // still 1, not called again
    });

    it('should call shutdown on removed plugin for cleanup', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const plugin = createMockPlugin('cleanup-me');

      agent.addPlugin(plugin);
      agent.start();

      agent.removePlugin('cleanup-me');

      expect(plugin.shutdownCalls).toBe(1);
    });

    it('should emit plugin:removed event', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addPlugin(createMockPlugin('to-remove'));
      agent.start();

      agent.removePlugin('to-remove');

      expect(eventBus.emitted('plugin:removed')).toBe(true);
    });
  });

  describe('Plugin Dependencies', () => {
    it('should reject plugin if its dependency is not present', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const dependent = createMockPlugin('dependent');

      expect(() => {
        agent.addPlugin(dependent, { requires: ['base-plugin'] });
      }).toThrow(/dependency.*base-plugin/i);
    });

    it('should accept plugin when its dependency is present', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const base = createMockPlugin('base-plugin');
      const dependent = createMockPlugin('dependent');

      agent.addPlugin(base);
      agent.addPlugin(dependent, { requires: ['base-plugin'] });

      agent.start();
      await agent.runTurn('test');

      expect(dependent.beforeTurnCalls.length).toBe(1);
    });

    it('should prevent removal of plugin that is dependency of another', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const base = createMockPlugin('base');
      const dependent = createMockPlugin('needs-base');

      agent.addPlugin(base);
      agent.addPlugin(dependent, { requires: ['base'] });
      agent.start();

      expect(() => {
        agent.removePlugin('base');
      }).toThrow(/required by.*needs-base/i);
    });

    it('should allow cascading removal of plugin and its dependents', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const base = createMockPlugin('base');
      const dep1 = createMockPlugin('dep-1');
      const dep2 = createMockPlugin('dep-2');

      agent.addPlugin(base);
      agent.addPlugin(dep1, { requires: ['base'] });
      agent.addPlugin(dep2, { requires: ['base'] });
      agent.start();

      agent.removePlugin('base', { cascade: true });

      expect(agent.hasPlugin('base')).toBe(false);
      expect(agent.hasPlugin('dep-1')).toBe(false);
      expect(agent.hasPlugin('dep-2')).toBe(false);
    });
  });

  describe('Plugin Error Isolation', () => {
    it('should continue running other plugins when plugin A fails', async () => {
      const agent = stateManager.get<any>('agentLoop');

      const failingPlugin = createMockPlugin('failing', { beforeTurnShouldThrow: true });
      const healthyPlugin = createMockPlugin('healthy');

      agent.addPlugin(failingPlugin, { priority: 1 });
      agent.addPlugin(healthyPlugin, { priority: 2 });
      agent.start();

      await agent.runTurn('test');

      // Healthy plugin should still execute despite failing plugin
      expect(healthyPlugin.beforeTurnCalls.length).toBe(1);
    });

    it('should emit plugin:error event when plugin throws', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const failing = createMockPlugin('crashes', { beforeTurnShouldThrow: true });

      agent.addPlugin(failing);
      agent.start();

      await agent.runTurn('test');

      expect(eventBus.emitted('plugin:error')).toBe(true);
      const error = eventBus.lastEmitted<any>('plugin:error');
      expect(error.pluginName).toBe('crashes');
    });

    it('should not abort the turn when a non-critical plugin fails', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const failing = createMockPlugin('optional-failing', { beforeTurnShouldThrow: true });

      agent.addPlugin(failing, { critical: false });
      agent.start();

      const result = await agent.runTurn('should succeed');

      expect(result).toBeDefined();
      expect(result.completed).toBe(true);
    });

    it('should abort the turn when a critical plugin fails', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const criticalFailing = createMockPlugin('critical-fail', { beforeTurnShouldThrow: true });

      agent.addPlugin(criticalFailing, { critical: true });
      agent.start();

      await expect(agent.runTurn('should fail')).rejects.toThrow();
    });

    it('should disable plugin after consecutive failures (circuit breaker pattern)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.setPluginCircuitBreaker({ maxFailures: 3 });

      const unreliable = createMockPlugin('unreliable', { beforeTurnShouldThrow: true });
      agent.addPlugin(unreliable);
      agent.start();

      await agent.runTurn('t1');
      await agent.runTurn('t2');
      await agent.runTurn('t3');

      // After 3 consecutive failures, plugin should be disabled
      expect(agent.isPluginDisabled('unreliable')).toBe(true);
      expect(eventBus.emitted('plugin:disabled')).toBe(true);
    });
  });
});
