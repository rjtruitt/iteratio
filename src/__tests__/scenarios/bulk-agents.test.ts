import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockToolExecutor,
  MockStateManager,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 16: Bulk Agent Processing ---
// 100+ tasks processed by an agent worker pool.
// Tests queue depth management, backpressure, ordering, progress, and memory bounds.

describe('E2E Scenario 16: Bulk Agent Processing', () => {
  let transport: MockTransport;
  let eventBus: MockEventBus;
  let llm: MockLLMProvider;
  let stateManager: MockStateManager;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    transport = ctx.transport;
    eventBus = ctx.eventBus;
    llm = ctx.llm;
    stateManager = ctx.stateManager;
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  describe('Task Submission', () => {
    it('should accept 100 tasks submitted to a WorkerPool', async () => {
      // Submit 100 tasks to pool; all should be acknowledged
      const pool = stateManager.get<any>('workerPool');
      const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, input: `process item ${i}` }));

      const submissions = tasks.map(t => pool.submit(t));
      const results = await Promise.allSettled(submissions);

      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      expect(pool.totalSubmitted).toBe(100);
    });

    it('should not load all 100 tasks into memory at once', async () => {
      // Pool should batch-load from queue, keeping resident set bounded
      const pool = stateManager.get<any>('workerPool');
      const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, input: `item ${i}` }));

      for (const t of tasks) pool.submit(t);

      // At any moment, no more than maxConcurrent + buffer tasks should be loaded
      const maxResident = pool.getResidentTaskCount();
      expect(maxResident).toBeLessThanOrEqual(pool.maxConcurrent + pool.bufferSize);
    });

    it('should enqueue tasks in FIFO order by default', async () => {
      const pool = stateManager.get<any>('workerPool');
      const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `task-${i}`, input: `item ${i}` }));

      for (const t of tasks) pool.submit(t);
      const queueOrder = pool.getQueuedTaskIds();

      expect(queueOrder).toEqual(tasks.map(t => t.id));
    });
  });

  describe('Backpressure', () => {
    it('should apply backpressure when workers are overwhelmed', async () => {
      // When all workers are busy and buffer is full, submit should block or return backpressure signal
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(2);
      pool.setBufferSize(3);

      // Fill up workers and buffer (5 total capacity)
      for (let i = 0; i < 5; i++) {
        pool.submit({ id: `task-${i}`, input: `item ${i}` });
      }

      // 6th submission should trigger backpressure
      const result = pool.submit({ id: 'task-overflow', input: 'overflow' });
      expect(result.backpressure).toBe(true);
    });

    it('should emit a backpressure event when queue reaches capacity', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(2);
      pool.setBufferSize(3);

      for (let i = 0; i < 6; i++) {
        pool.submit({ id: `task-${i}`, input: `item ${i}` });
      }

      expect(eventBus.emitted('pool:backpressure')).toBe(true);
    });

    it('should resume accepting tasks after backpressure clears', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(2);
      pool.setBufferSize(2);

      // Fill capacity
      for (let i = 0; i < 4; i++) {
        pool.submit({ id: `task-${i}`, input: `item ${i}` });
      }

      // Complete one task to free capacity
      pool.completeTask('task-0');

      // Now submission should succeed without backpressure
      const result = pool.submit({ id: 'task-new', input: 'new' });
      expect(result.backpressure).toBe(false);
    });
  });

  describe('Completion Ordering', () => {
    it('should deliver results as workers finish (not in submission order)', async () => {
      const pool = stateManager.get<any>('workerPool');
      const completionOrder: string[] = [];

      pool.on('task:complete', (result: any) => {
        completionOrder.push(result.taskId);
      });

      // Submit 5 tasks with varying durations
      pool.submit({ id: 'slow', input: 'data', durationMs: 100 });
      pool.submit({ id: 'fast', input: 'data', durationMs: 10 });
      pool.submit({ id: 'medium', input: 'data', durationMs: 50 });

      clock.advance(150);

      // Fast should complete before slow
      expect(completionOrder.indexOf('fast')).toBeLessThan(completionOrder.indexOf('slow'));
    });

    it('should track completed vs pending counts accurately', async () => {
      const pool = stateManager.get<any>('workerPool');
      const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `task-${i}`, input: `item ${i}` }));

      for (const t of tasks) pool.submit(t);

      // Complete 3 tasks
      pool.completeTask('task-0');
      pool.completeTask('task-1');
      pool.completeTask('task-2');

      expect(pool.completedCount).toBe(3);
      expect(pool.pendingCount).toBe(7);
    });
  });

  describe('Progress Reporting', () => {
    it('should report progress as X of N complete', async () => {
      const pool = stateManager.get<any>('workerPool');
      const progressReports: Array<{ completed: number; total: number }> = [];

      pool.on('pool:progress', (report: any) => {
        progressReports.push(report);
      });

      const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, input: `item ${i}` }));
      for (const t of tasks) pool.submit(t);

      // Simulate completing 50 tasks
      for (let i = 0; i < 50; i++) {
        pool.completeTask(`task-${i}`);
      }

      const lastReport = progressReports[progressReports.length - 1];
      expect(lastReport.completed).toBe(50);
      expect(lastReport.total).toBe(100);
    });

    it('should emit progress events at configurable intervals', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setProgressInterval(10); // report every 10 completions

      const progressReports: any[] = [];
      pool.on('pool:progress', (report: any) => progressReports.push(report));

      const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `task-${i}`, input: `item ${i}` }));
      for (const t of tasks) pool.submit(t);

      for (let i = 0; i < 50; i++) {
        pool.completeTask(`task-${i}`);
      }

      // Should have 5 progress reports (at 10, 20, 30, 40, 50)
      expect(progressReports.length).toBe(5);
    });
  });

  describe('Partial Results', () => {
    it('should make partial results available before all tasks complete', async () => {
      const pool = stateManager.get<any>('workerPool');
      const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, input: `item ${i}` }));
      for (const t of tasks) pool.submit(t);

      // Complete 30 of 100
      for (let i = 0; i < 30; i++) {
        pool.completeTask(`task-${i}`);
      }

      const partialResults = pool.getCompletedResults();
      expect(partialResults.length).toBe(30);
      expect(pool.isComplete).toBe(false);
    });

    it('should allow streaming results as they arrive', async () => {
      const pool = stateManager.get<any>('workerPool');
      const streamedResults: any[] = [];

      const stream = pool.createResultStream();
      stream.on('data', (result: any) => streamedResults.push(result));

      pool.submit({ id: 'task-1', input: 'a' });
      pool.submit({ id: 'task-2', input: 'b' });

      pool.completeTask('task-1');

      // Should have 1 result streamed even though task-2 is not done
      expect(streamedResults.length).toBe(1);
      expect(streamedResults[0].taskId).toBe('task-1');
    });
  });

  describe('Memory Bounds', () => {
    it('should not grow memory unbounded during bulk processing', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(5);
      pool.setResultRetention('streaming'); // don't hold completed results in memory

      const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, input: `item ${i}` }));
      for (const t of tasks) pool.submit(t);

      // Complete all tasks
      for (let i = 0; i < 100; i++) {
        pool.completeTask(`task-${i}`);
      }

      // Internal state should not retain all 100 results
      const internalSize = pool.getInternalBufferSize();
      expect(internalSize).toBeLessThan(20); // well below 100
    });

    it('should evict completed results from memory when retention policy is bounded', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setResultRetention('bounded');
      pool.setMaxRetainedResults(10);

      const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `task-${i}`, input: `item ${i}` }));
      for (const t of tasks) pool.submit(t);

      for (let i = 0; i < 50; i++) {
        pool.completeTask(`task-${i}`);
      }

      const retained = pool.getRetainedResultCount();
      expect(retained).toBeLessThanOrEqual(10);
    });
  });

  describe('Priority Ordering', () => {
    it('should process high-priority tasks before low-priority tasks', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(1); // serial processing to observe order
      const processingOrder: string[] = [];

      pool.on('task:start', (task: any) => processingOrder.push(task.id));

      pool.submit({ id: 'low-1', input: 'data', priority: 1 });
      pool.submit({ id: 'low-2', input: 'data', priority: 1 });
      pool.submit({ id: 'high-1', input: 'data', priority: 10 });
      pool.submit({ id: 'critical', input: 'data', priority: 100 });

      // Process all
      pool.processAll();

      // Critical and high should come before lows
      expect(processingOrder.indexOf('critical')).toBeLessThan(processingOrder.indexOf('low-1'));
      expect(processingOrder.indexOf('high-1')).toBeLessThan(processingOrder.indexOf('low-2'));
    });

    it('should maintain FIFO within the same priority level', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(1);
      const processingOrder: string[] = [];

      pool.on('task:start', (task: any) => processingOrder.push(task.id));

      pool.submit({ id: 'a', input: 'data', priority: 5 });
      pool.submit({ id: 'b', input: 'data', priority: 5 });
      pool.submit({ id: 'c', input: 'data', priority: 5 });

      pool.processAll();

      expect(processingOrder).toEqual(['a', 'b', 'c']);
    });

    it('should support dynamic priority boost for in-queue tasks', async () => {
      const pool = stateManager.get<any>('workerPool');
      pool.setMaxConcurrent(1);
      const processingOrder: string[] = [];

      pool.on('task:start', (task: any) => processingOrder.push(task.id));

      pool.submit({ id: 'first', input: 'data', priority: 1 });
      pool.submit({ id: 'second', input: 'data', priority: 1 });
      pool.submit({ id: 'boosted', input: 'data', priority: 1 });

      // Boost priority of 'boosted' before it starts processing
      pool.boostPriority('boosted', 100);

      pool.processAll();

      // 'boosted' should now come first
      expect(processingOrder[0]).toBe('boosted');
    });
  });
});

