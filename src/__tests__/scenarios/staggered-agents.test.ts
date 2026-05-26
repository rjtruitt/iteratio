import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 17: Staggered Agents (Rolling Deployment) ---
// Gradually ramp up/down workers, drain-and-replace, zero-downtime reconfiguration.

describe('E2E Scenario 17: Staggered Agents - Rolling Deployment', () => {
  let transport: MockTransport;
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    transport = ctx.transport;
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  describe('Gradual Ramp-Up', () => {
    it('should start with 1 worker and add more over time', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setRampUpStrategy({ initial: 1, step: 1, intervalMs: 1000, max: 5 });

      pool.startRampUp();

      expect(pool.activeWorkerCount).toBe(1);

      clock.advance(1000);
      expect(pool.activeWorkerCount).toBe(2);

      clock.advance(1000);
      expect(pool.activeWorkerCount).toBe(3);
    });

    it('should stop ramping at maxConcurrent', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setRampUpStrategy({ initial: 1, step: 2, intervalMs: 500, max: 5 });

      pool.startRampUp();
      clock.advance(5000); // More than enough time to max out

      expect(pool.activeWorkerCount).toBe(5);
    });

    it('should emit worker:added event for each new worker', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setRampUpStrategy({ initial: 1, step: 1, intervalMs: 1000, max: 3 });

      pool.startRampUp();
      clock.advance(2000);

      expect(eventBus.emittedCount('worker:added')).toBe(3); // initial + 2 added
    });
  });

  describe('Drain and Replace', () => {
    it('should drain worker before stopping it (finish in-progress tasks)', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);

      // Assign a task to worker-0
      pool.assignTask('worker-0', { id: 'task-1', input: 'data' });

      // Initiate drain on worker-0
      const drainPromise = pool.drainWorker('worker-0');

      // Worker should still be active (finishing task)
      expect(pool.getWorkerState('worker-0')).toBe('draining');

      // Complete the in-progress task
      pool.completeTask('task-1');

      await drainPromise;
      expect(pool.getWorkerState('worker-0')).toBe('stopped');
    });

    it('should replace drained worker with new one using updated config', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(2);

      const newConfig = { systemPrompt: 'You are v2' };
      await pool.drainAndReplace('worker-0', newConfig);

      const replacementWorker = pool.getWorker('worker-0-replacement');
      expect(replacementWorker.config.systemPrompt).toBe('You are v2');
      expect(pool.activeWorkerCount).toBe(2); // same count as before
    });

    it('should not drop any tasks during drain-and-replace', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(2);

      // Submit tasks and start processing
      for (let i = 0; i < 5; i++) {
        pool.submit({ id: `task-${i}`, input: `item ${i}` });
      }

      // Drain and replace worker-0
      await pool.drainAndReplace('worker-0', { systemPrompt: 'v2' });

      // All 5 tasks should eventually complete
      pool.processAll();
      expect(pool.completedCount).toBe(5);
    });
  });

  describe('Zero-Downtime Reconfiguration', () => {
    it('should always maintain at least N workers active during rolling restart', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);
      pool.setMinActive(2);

      const activeCountHistory: number[] = [];
      pool.on('worker:stateChange', () => {
        activeCountHistory.push(pool.activeWorkerCount);
      });

      await pool.rollingRestart({ newConfig: { model: 'v2' } });

      // At no point should active count drop below minActive
      expect(activeCountHistory.every(count => count >= 2)).toBe(true);
    });

    it('should complete rolling restart with all workers on new config', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(3);

      await pool.rollingRestart({ newConfig: { model: 'claude-v2' } });

      const workers = pool.getAllWorkers();
      expect(workers.every((w: any) => w.config.model === 'claude-v2')).toBe(true);
    });
  });

  describe('Rolling Restart', () => {
    it('should replace workers one-by-one with no service interruption', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(4);

      const restartEvents: string[] = [];
      pool.on('worker:stopped', (w: any) => restartEvents.push(`stop:${w.id}`));
      pool.on('worker:started', (w: any) => restartEvents.push(`start:${w.id}`));

      await pool.rollingRestart({ newConfig: { version: '2.0' } });

      // Pattern: start new, stop old, start new, stop old...
      // Each start should precede its corresponding stop (overlap)
      expect(restartEvents.length).toBe(8); // 4 stops + 4 starts
    });

    it('should handle task reassignment during rolling restart', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(2);

      pool.submit({ id: 'task-1', input: 'a' });
      pool.submit({ id: 'task-2', input: 'b' });

      // Start rolling restart while tasks are being processed
      await pool.rollingRestart({ newConfig: { version: '2.0' } });

      // All tasks should still complete
      expect(pool.completedCount).toBe(2);
    });
  });

  describe('Canary Deployment', () => {
    it('should deploy one canary worker with new config while others remain on old', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);

      await pool.deployCanary({ model: 'experimental-v3' });

      const workers = pool.getAllWorkers();
      const canaries = workers.filter((w: any) => w.config.model === 'experimental-v3');
      const stable = workers.filter((w: any) => w.config.model !== 'experimental-v3');

      expect(canaries.length).toBe(1);
      expect(stable.length).toBe(4);
    });

    it('should promote canary to full rollout after observation period', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);

      await pool.deployCanary({ model: 'experimental-v3' });
      // Simulate observation period
      clock.advance(30000);

      await pool.promoteCanary();

      const workers = pool.getAllWorkers();
      expect(workers.every((w: any) => w.config.model === 'experimental-v3')).toBe(true);
    });

    it('should rollback canary if error rate exceeds threshold', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);

      await pool.deployCanary({ model: 'broken-model' });

      // Simulate errors from canary worker
      pool.reportCanaryError(new Error('model failed'));
      pool.reportCanaryError(new Error('model failed'));
      pool.reportCanaryError(new Error('model failed'));

      // Pool should auto-rollback canary
      const workers = pool.getAllWorkers();
      const canaries = workers.filter((w: any) => w.config.model === 'broken-model');
      expect(canaries.length).toBe(0);
      expect(eventBus.emitted('canary:rollback')).toBe(true);
    });
  });

  describe('Ramp-Down', () => {
    it('should gradually reduce workers as queue empties', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);
      pool.setRampDownStrategy({ minWorkers: 1, checkIntervalMs: 1000 });

      // Queue is empty → should ramp down
      pool.startRampDown();

      clock.advance(1000);
      expect(pool.activeWorkerCount).toBeLessThan(5);

      clock.advance(4000);
      expect(pool.activeWorkerCount).toBe(1);
    });

    it('should not ramp down below minWorkers', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);
      pool.setRampDownStrategy({ minWorkers: 2, checkIntervalMs: 500 });

      pool.startRampDown();
      clock.advance(10000);

      expect(pool.activeWorkerCount).toBeGreaterThanOrEqual(2);
    });

    it('should cancel ramp-down if new tasks arrive', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);
      pool.setRampDownStrategy({ minWorkers: 1, checkIntervalMs: 1000 });

      pool.startRampDown();
      clock.advance(2000); // Some workers removed

      const countAfterRampDown = pool.activeWorkerCount;

      // New work arrives
      pool.submit({ id: 'new-task', input: 'urgent' });

      // Should stop ramping down (or ramp back up)
      clock.advance(1000);
      expect(pool.activeWorkerCount).toBeGreaterThanOrEqual(countAfterRampDown);
    });
  });
});
