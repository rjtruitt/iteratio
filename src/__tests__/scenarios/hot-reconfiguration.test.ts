import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockToolExecutor,
  createMockStep,
  createMockSteps,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 21: Hot Reconfiguration ---
// Pause/resume with live reconfiguration: change concurrency, system prompt,
// steps, LLM provider, atomic reconfigure, rollback, rapid reconfigurations.

describe('E2E Scenario 21: Hot Reconfiguration', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let transport: MockTransport;
  let llm: MockLLMProvider;
  let toolExecutor: MockToolExecutor;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    transport = ctx.transport;
    llm = ctx.llm;
    toolExecutor = ctx.toolExecutor;
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  describe('Pause and Resume', () => {
    it('should pause pool and wait until all workers are idle', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);

      // Assign tasks to workers
      pool.submit({ id: 'task-1', input: 'data' });
      pool.submit({ id: 'task-2', input: 'data' });

      // Pause (should wait for workers to finish)
      const pausePromise = pool.pause();

      // Workers are still busy
      expect(pool.state).toBe('pausing');

      // Complete tasks
      pool.completeTask('task-1');
      pool.completeTask('task-2');

      await pausePromise;
      expect(pool.state).toBe('paused');
    });

    it('should not accept new tasks while paused', async () => {
      const pool = stateManager.get<any>('workerPool');
      await pool.pause();

      const result = pool.submit({ id: 'rejected', input: 'data' });
      expect(result.rejected).toBe(true);
      expect(result.reason).toContain('paused');
    });

    it('should resume processing after resume() is called', async () => {
      const pool = stateManager.get<any>('workerPool');
      await pool.pause();

      pool.resume();
      expect(pool.state).toBe('running');

      const result = pool.submit({ id: 'accepted', input: 'data' });
      expect(result.rejected).toBe(false);
    });

    it('should emit pause and resume events', async () => {
      const pool = stateManager.get<any>('workerPool');

      await pool.pause();
      expect(eventBus.emitted('pool:paused')).toBe(true);

      pool.resume();
      expect(eventBus.emitted('pool:resumed')).toBe(true);
    });
  });

  describe('No Dropped Work During Pause', () => {
    it('should complete all in-progress tasks before entering paused state', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);
      const completed: string[] = [];

      pool.on('task:complete', (t: any) => completed.push(t.id));

      pool.submit({ id: 'inflight-1', input: 'data' });
      pool.submit({ id: 'inflight-2', input: 'data' });
      pool.submit({ id: 'inflight-3', input: 'data' });

      const pausePromise = pool.pause();

      // Finish all in-flight tasks
      pool.completeTask('inflight-1');
      pool.completeTask('inflight-2');
      pool.completeTask('inflight-3');

      await pausePromise;

      expect(completed).toEqual(['inflight-1', 'inflight-2', 'inflight-3']);
    });

    it('should preserve queued tasks during pause (not discard them)', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(1);

      pool.submit({ id: 'active', input: 'data' });
      pool.submit({ id: 'queued-1', input: 'data' });
      pool.submit({ id: 'queued-2', input: 'data' });

      pool.completeTask('active');
      await pool.pause();

      // Queued tasks should still be there
      expect(pool.queuedCount).toBe(2);
    });
  });

  describe('Reconfigure: maxConcurrent', () => {
    it('should change maxConcurrent while paused', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);
      await pool.pause();

      pool.reconfigure({ maxConcurrent: 10 });
      pool.resume();

      expect(pool.maxConcurrent).toBe(10);
    });

    it('should scale up workers after increasing maxConcurrent', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(2);
      await pool.pause();

      pool.reconfigure({ maxConcurrent: 5 });
      pool.resume();

      // Submit tasks that fill new capacity
      for (let i = 0; i < 5; i++) pool.submit({ id: `t-${i}`, input: 'x' });

      expect(pool.activeWorkerCount).toBe(5);
    });

    it('should drain excess workers after decreasing maxConcurrent', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);
      await pool.pause();

      pool.reconfigure({ maxConcurrent: 2 });
      pool.resume();

      expect(pool.activeWorkerCount).toBeLessThanOrEqual(2);
    });
  });

  describe('Reconfigure: System Prompt', () => {
    it('should update system prompt for all agents after reconfigure', async () => {
      const pool = stateManager.get<any>('workerPool');
      await pool.pause();

      pool.reconfigure({ systemPrompt: 'You are a v2 assistant' });
      pool.resume();

      const workers = pool.getAllWorkers();
      expect(workers.every((w: any) => w.systemPrompt === 'You are a v2 assistant')).toBe(true);
    });

    it('should use new system prompt on next turn after reconfigure', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();
      await agent.pause();

      agent.reconfigure({ systemPrompt: 'New instructions' });
      agent.resume();

      await agent.runTurn('hello');

      const lastCall = llm.calls[llm.calls.length - 1];
      expect(lastCall.messages[0].content).toContain('New instructions');
    });
  });

  describe('Reconfigure: Steps', () => {
    it('should add new steps during reconfiguration', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();
      await agent.pause();

      const newStep = createMockStep('new-step');
      agent.reconfigure({ addSteps: [newStep] });
      agent.resume();

      expect(agent.getPipeline().hasStep('new-step')).toBe(true);
    });

    it('should remove steps during reconfiguration', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('old-step'));
      agent.start();
      await agent.pause();

      agent.reconfigure({ removeSteps: ['old-step'] });
      agent.resume();

      expect(agent.getPipeline().hasStep('old-step')).toBe(false);
    });

    it('should add and remove steps atomically in one reconfigure call', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('remove-me'));
      agent.start();
      await agent.pause();

      agent.reconfigure({
        addSteps: [createMockStep('add-me')],
        removeSteps: ['remove-me'],
      });
      agent.resume();

      const pipeline = agent.getPipeline();
      expect(pipeline.hasStep('add-me')).toBe(true);
      expect(pipeline.hasStep('remove-me')).toBe(false);
    });
  });

  describe('Reconfigure: Swap LLM Provider', () => {
    it('should swap LLM provider during reconfiguration', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();
      await agent.pause();

      const newProvider = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('from new provider'),
      });
      agent.reconfigure({ llmProvider: newProvider });
      agent.resume();

      const result = await agent.runTurn('test');
      expect(result).toContain('from new provider');
    });

    it('should shutdown old provider when swapping', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const oldProvider = new MockLLMProvider();
      const shutdownSpy = vi.spyOn(oldProvider, 'shutdown');

      agent.setLLMProvider(oldProvider);
      agent.start();
      await agent.pause();

      agent.reconfigure({ llmProvider: new MockLLMProvider() });
      agent.resume();

      expect(shutdownSpy).toHaveBeenCalled();
    });
  });

  describe('Atomic Reconfigure', () => {
    it('should apply all configuration changes atomically (all-or-nothing)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('existing'));
      agent.start();
      await agent.pause();

      // This should fail (invalid provider) and rollback everything
      expect(() => {
        agent.reconfigure({
          systemPrompt: 'new prompt',
          addSteps: [createMockStep('new-step')],
          llmProvider: null, // invalid
        });
      }).toThrow();

      agent.resume();

      // Nothing should have changed
      expect(agent.getSystemPrompt()).not.toBe('new prompt');
      expect(agent.getPipeline().hasStep('new-step')).toBe(false);
    });

    it('should validate all config changes before applying any', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();
      await agent.pause();

      const validationErrors = agent.validateReconfiguration({
        maxConcurrent: -1, // invalid
        systemPrompt: '', // invalid (empty)
      });

      expect(validationErrors.length).toBeGreaterThan(0);
      expect(validationErrors.some((e: any) => e.field === 'maxConcurrent')).toBe(true);
    });
  });

  describe('Failed Reconfigure Rollback', () => {
    it('should rollback to previous config on reconfigure failure', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);
      const originalConfig = pool.getConfig();

      await pool.pause();

      // Simulate a reconfigure that fails midway
      try {
        pool.reconfigure({
          maxConcurrent: 5,
          systemPrompt: 'new',
          // This triggers an internal error
          _forceFailure: true,
        });
      } catch {}

      pool.resume();

      // Should be back to original config
      expect(pool.getConfig()).toEqual(originalConfig);
    });

    it('should emit reconfigure:failed event on rollback', async () => {
      const pool = stateManager.get<any>('workerPool');
      await pool.pause();

      try {
        pool.reconfigure({ _forceFailure: true });
      } catch {}

      pool.resume();

      expect(eventBus.emitted('reconfigure:failed')).toBe(true);
    });

    it('should resume with old config after rollback (system still functional)', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);
      await pool.pause();

      try { pool.reconfigure({ _forceFailure: true }); } catch {}

      pool.resume();

      // System should still work
      pool.submit({ id: 'test', input: 'data' });
      expect(pool.activeWorkerCount).toBeGreaterThan(0);
    });
  });

  describe('Multiple Rapid Reconfigurations', () => {
    it('should queue multiple reconfiguration requests', async () => {
      const pool = stateManager.get<any>('workerPool');

      // Submit reconfigs rapidly without waiting
      const r1 = pool.requestReconfigure({ maxConcurrent: 5 });
      const r2 = pool.requestReconfigure({ maxConcurrent: 10 });
      const r3 = pool.requestReconfigure({ maxConcurrent: 7 });

      await Promise.all([r1, r2, r3]);

      // Final state should reflect last applied config
      expect(pool.maxConcurrent).toBe(7);
    });

    it('should apply reconfigurations in order', async () => {
      const pool = stateManager.get<any>('workerPool');
      const appliedConfigs: number[] = [];

      pool.on('reconfigure:applied', (cfg: any) => appliedConfigs.push(cfg.maxConcurrent));

      await pool.requestReconfigure({ maxConcurrent: 2 });
      await pool.requestReconfigure({ maxConcurrent: 4 });
      await pool.requestReconfigure({ maxConcurrent: 6 });

      expect(appliedConfigs).toEqual([2, 4, 6]);
    });

    it('should coalesce rapid reconfigurations if configured to batch', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setReconfigureMode('batch'); // coalesce rapid changes

      pool.requestReconfigure({ maxConcurrent: 5 });
      pool.requestReconfigure({ systemPrompt: 'v2' });
      pool.requestReconfigure({ maxConcurrent: 8 }); // overrides first maxConcurrent

      await pool.flushReconfigureQueue();

      // Should have been applied as one batch
      expect(pool.maxConcurrent).toBe(8);
      expect(pool.getSystemPrompt()).toBe('v2');
      expect(eventBus.emittedCount('reconfigure:applied')).toBe(1); // single application
    });
  });

  describe('Reconfiguration Under Load', () => {
    it('should handle reconfiguration with 100 active tasks', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(10);

      // Submit 100 tasks
      for (let i = 0; i < 100; i++) {
        pool.submit({ id: `task-${i}`, input: 'data' });
      }

      // Reconfigure while under heavy load
      await pool.requestReconfigure({ maxConcurrent: 20 });

      // All tasks should eventually complete (none lost)
      pool.processAll();
      expect(pool.completedCount).toBe(100);
    });

    it('should not lose in-progress tasks during reconfiguration', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);
      const completedIds: string[] = [];

      pool.on('task:complete', (t: any) => completedIds.push(t.id));

      for (let i = 0; i < 10; i++) {
        pool.submit({ id: `task-${i}`, input: 'data' });
      }

      // Start processing
      pool.startProcessing();

      // Reconfigure mid-processing
      await pool.requestReconfigure({ maxConcurrent: 2 });

      // Finish all
      pool.processAll();

      // All 10 should have completed
      expect(completedIds.length).toBe(10);
    });

    it('should respect new maxConcurrent immediately after reconfiguration', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(2);

      for (let i = 0; i < 20; i++) {
        pool.submit({ id: `task-${i}`, input: 'data' });
      }

      await pool.requestReconfigure({ maxConcurrent: 10 });

      // Should now have up to 10 concurrent workers
      expect(pool.activeWorkerCount).toBeLessThanOrEqual(10);
      expect(pool.activeWorkerCount).toBeGreaterThan(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle reconfigure to identical config (no-op)', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);
      const originalConfig = pool.getConfig();

      await pool.pause();
      pool.reconfigure({ maxConcurrent: 5 }); // Same value
      pool.resume();

      // Should not emit reconfigure event for no-op
      expect(pool.getConfig()).toEqual(originalConfig);
      expect(eventBus.emittedCount('reconfigure:applied')).toBe(0);
    });

    it('should handle reconfigure that removes all steps (empty pipeline)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('step-1'));
      agent.addStep(createMockStep('step-2'));
      agent.addStep(createMockStep('step-3'));
      agent.start();
      await agent.pause();

      // Remove all steps
      agent.reconfigure({ removeSteps: ['step-1', 'step-2', 'step-3'] });
      agent.resume();

      const pipeline = agent.getPipeline();
      expect(pipeline.stepCount()).toBe(0);
      // Agent should still run (just pass-through with no steps)
      const result = await agent.runTurn('hello');
      expect(result).toBeDefined();
    });

    it('should handle reconfigure during step execution', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const slowStep = createMockStep('slow-step', { delayMs: 5000 });
      agent.addStep(slowStep);
      agent.start();

      // Start a turn (slow step is executing)
      const turnPromise = agent.runTurn('trigger slow step');

      // Try to reconfigure while step is mid-execution
      await expect(agent.reconfigure({ removeSteps: ['slow-step'] }))
        .rejects.toThrow(/in-progress|executing|busy/i);

      clock.advance(6000);
      await turnPromise;
    });

    it('should handle rapid reconfiguration (10 changes in 100ms)', async () => {
      const pool = stateManager.get<any>('workerPool');
      const configs: number[] = [];

      pool.on('reconfigure:applied', (cfg: any) => configs.push(cfg.maxConcurrent));

      // Fire 10 reconfigs in rapid succession (10ms apart)
      for (let i = 1; i <= 10; i++) {
        pool.requestReconfigure({ maxConcurrent: i });
        clock.advance(10);
      }

      await pool.flushReconfigureQueue();

      // Final state should be deterministic
      expect(pool.maxConcurrent).toBe(10);
    });

    it('should handle reconfigure that adds step with duplicate name', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('step-x'));
      agent.start();
      await agent.pause();

      // Adding another step with the same name should fail
      expect(() => {
        agent.reconfigure({ addSteps: [createMockStep('step-x')] });
      }).toThrow(/duplicate|already exists/i);

      agent.resume();
    });

    it('should handle reconfigure that rolls back on validation failure', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('existing-step'));
      agent.start();
      await agent.pause();

      const originalPipeline = agent.getPipeline().getStepNames();

      // Reconfigure with invalid config (e.g., step with no execute function)
      try {
        agent.reconfigure({
          addSteps: [{ name: 'broken', execute: null }], // Invalid
        });
      } catch {}

      agent.resume();

      // Should have rolled back to original
      expect(agent.getPipeline().getStepNames()).toEqual(originalPipeline);
    });

    it('should handle reconfigure while pause is in progress', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);

      // Submit tasks so pause has to wait
      pool.submit({ id: 'task-1', input: 'data' });
      pool.submit({ id: 'task-2', input: 'data' });

      // Start pausing (not yet paused)
      const pausePromise = pool.pause();
      expect(pool.state).toBe('pausing');

      // Try to reconfigure during pause transition
      await expect(pool.reconfigure({ maxConcurrent: 10 }))
        .rejects.toThrow(/pausing|not paused|transition/i);

      // Complete tasks so pause finishes
      pool.completeTask('task-1');
      pool.completeTask('task-2');
      await pausePromise;
    });

    it('should handle reconfigure with config that references removed dependencies', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.addStep(createMockStep('data-source'));
      agent.addStep(createMockStep('consumer', { dependsOn: ['data-source'] }));
      agent.start();
      await agent.pause();

      // Remove the dependency but keep the consumer
      expect(() => {
        agent.reconfigure({ removeSteps: ['data-source'] });
      }).toThrow(/dependency|depends on|required/i);

      agent.resume();

      // data-source should still exist
      expect(agent.getPipeline().hasStep('data-source')).toBe(true);
    });
  });
});
