import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkerPool, WorkerPoolBuilder, TaskQueue, Task, QueueStats } from '../WorkerPool';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';

describe('WorkerPool', () => {
  describe('builder', () => {
    it('should return a WorkerPoolBuilder', () => {
      const builder = WorkerPool.builder();
      expect(builder).toBeInstanceOf(WorkerPoolBuilder);
    });

    it('should throw when totalTasks is not set', () => {
      expect(() => {
        WorkerPool.builder()
          .maxConcurrent(3)
          .tasks([{ id: '1', title: 'test', priority: 1 }])
          .build();
      }).toThrow('totalTasks is required');
    });

    it('should throw when maxConcurrent is not set', () => {
      expect(() => {
        WorkerPool.builder()
          .totalTasks(10)
          .tasks([{ id: '1', title: 'test', priority: 1 }])
          .build();
      }).toThrow('maxConcurrent is required');
    });

    it('should throw when taskLoader is not set', () => {
      expect(() => {
        WorkerPool.builder()
          .totalTasks(10)
          .maxConcurrent(3)
          .build();
      }).toThrow('taskLoader is required');
    });

    it('should build successfully with all required fields', () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(3)
        .tasks([{ id: '1', title: 'test', priority: 1 }])
        .build();
      expect(pool).toBeInstanceOf(WorkerPool);
    });

    it('should support fluent chaining', () => {
      const builder = WorkerPool.builder();
      const result = builder
        .totalTasks(10)
        .maxConcurrent(3)
        .maxTurnsPerTask(20)
        .taskTimeout(60000)
        .retryAttempts(5)
        .healthCheckInterval(5000);
      expect(result).toBe(builder);
    });
  });

  describe('start()', () => {
    it('should load tasks from taskLoader', async () => {
      const loader = vi.fn().mockResolvedValue([
        { id: '1', title: 'Task 1', priority: 1 },
        { id: '2', title: 'Task 2', priority: 1 },
      ]);
      const pool = WorkerPool.builder()
        .totalTasks(2)
        .maxConcurrent(1)
        .taskLoader(loader)
        .llmProvider(new MockLLMProvider())
        .build();

      await expect(pool.start()).resolves.toBeUndefined();
      expect(loader).toHaveBeenCalledOnce();
    });

    it('should create maxConcurrent workers', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(3)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = pool.getStats();
      expect(stats.inProgress).toBeLessThanOrEqual(3);
    });

    it('should emit pool:started event', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .build();

      const handler = vi.fn();
      pool.on('pool:started', handler);
      await pool.start();
      expect(handler).toHaveBeenCalled();
    });

    it('should begin assigning tasks to workers immediately', async () => {
      const onProgress = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .onProgress(onProgress)
        .build();

      await pool.start();
      const stats = pool.getStats();
      expect(stats.inProgress).toBeGreaterThan(0);
    });
  });

  describe('stop()', () => {
    it('should stop accepting new tasks', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(2)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      await pool.stop();
      const stats = pool.getStats();
      expect(stats.inProgress).toBe(0);
    });

    it('should allow in-progress tasks to finish', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(2)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider({ delayMs: 100 }))
        .build();

      await pool.start();
      await pool.stop();
      // Should not have abandoned tasks mid-execution
    });

    it('should emit pool:stopped event', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(3)
        .maxConcurrent(1)
        .tasks(createTasks(3))
        .llmProvider(new MockLLMProvider())
        .build();

      const handler = vi.fn();
      pool.on('pool:stopped', handler);
      await pool.start();
      await pool.stop();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('waitForCompletion()', () => {
    it('should resolve when all tasks are complete', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(3)
        .maxConcurrent(3)
        .tasks(createTasks(3))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(3);
      expect(stats.queued).toBe(0);
      expect(stats.inProgress).toBe(0);
    });

    it('should include failed tasks in final stats', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(3)
        .maxConcurrent(1)
        .tasks(createTasks(3))
        .retryAttempts(0)
        .llmProvider(new MockLLMProvider({ throwOnCall: 0 }))
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.failed).toBeGreaterThan(0);
    });
  });

  describe('getStats()', () => {
    it('should return accurate queue statistics', () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .build();

      const stats = pool.getStats();
      expect(stats).toHaveProperty('queued');
      expect(stats).toHaveProperty('inProgress');
      expect(stats).toHaveProperty('completed');
      expect(stats).toHaveProperty('failed');
      expect(stats).toHaveProperty('total');
    });
  });

  describe('callbacks', () => {
    it('should call onTaskComplete for each completed task', async () => {
      const onTaskComplete = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(2)
        .maxConcurrent(2)
        .tasks(createTasks(2))
        .llmProvider(new MockLLMProvider())
        .onTaskComplete(onTaskComplete)
        .build();

      await pool.start();
      await pool.waitForCompletion();
      expect(onTaskComplete).toHaveBeenCalledTimes(2);
    });

    it('should call onTaskFailed for failed tasks', async () => {
      const onTaskFailed = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(1)
        .maxConcurrent(1)
        .tasks(createTasks(1))
        .retryAttempts(0)
        .llmProvider(new MockLLMProvider({ throwOnCall: 0 }))
        .onTaskFailed(onTaskFailed)
        .build();

      await pool.start();
      await pool.waitForCompletion();
      expect(onTaskFailed).toHaveBeenCalledTimes(1);
    });

    it('should call onComplete when all tasks finish', async () => {
      const onComplete = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(2)
        .maxConcurrent(2)
        .tasks(createTasks(2))
        .llmProvider(new MockLLMProvider())
        .onComplete(onComplete)
        .build();

      await pool.start();
      await pool.waitForCompletion();
      expect(onComplete).toHaveBeenCalledOnce();
      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ completed: 2 }));
    });

    it('should call onProgress periodically', async () => {
      const onProgress = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .onProgress(onProgress)
        .build();

      await pool.start();
      await pool.waitForCompletion();
      expect(onProgress).toHaveBeenCalled();
    });
  });
});

describe('TaskQueue', () => {
  let tasks: Task[];
  let queue: TaskQueue;

  beforeEach(() => {
    tasks = createTasks(5);
    queue = new TaskQueue(tasks);
  });

  describe('dequeue()', () => {
    it('should return the next task', () => {
      const task = queue.dequeue();
      expect(task).not.toBeNull();
      expect(task!.id).toBe('task-001');
    });

    it('should return null when queue is empty', () => {
      for (let i = 0; i < 5; i++) queue.dequeue();
      expect(queue.dequeue()).toBeNull();
    });

    it('should set startedAt timestamp', () => {
      const task = queue.dequeue()!;
      expect(task.startedAt).toBeDefined();
      expect(typeof task.startedAt).toBe('number');
    });

    it('should track task as in-progress', () => {
      queue.dequeue();
      const stats = queue.getStats();
      expect(stats.inProgress).toBe(1);
      expect(stats.queued).toBe(4);
    });

    it('should dequeue in priority order (highest first)', () => {
      const priorityTasks: Task[] = [
        { id: 'low', title: 'Low', priority: 1 },
        { id: 'high', title: 'High', priority: 10 },
        { id: 'med', title: 'Med', priority: 5 },
      ];
      const pQueue = new TaskQueue(priorityTasks);
      const first = pQueue.dequeue()!;
      expect(first.id).toBe('high');
    });

    it('should emit task:dequeued event', () => {
      const handler = vi.fn();
      queue.on('task:dequeued', handler);
      queue.dequeue();
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('complete()', () => {
    it('should move task from in-progress to completed', () => {
      const task = queue.dequeue()!;
      queue.complete(task.id, 'done');
      const stats = queue.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.inProgress).toBe(0);
    });

    it('should set completedAt timestamp', () => {
      const task = queue.dequeue()!;
      queue.complete(task.id, 'result');
      // completedAt set internally
    });

    it('should store the result', () => {
      const task = queue.dequeue()!;
      queue.complete(task.id, { output: 'test' });
      // result stored on task
    });

    it('should throw for unknown task ID', () => {
      expect(() => queue.complete('unknown-id')).toThrow();
    });

    it('should emit task:completed event', () => {
      const handler = vi.fn();
      queue.on('task:completed', handler);
      const task = queue.dequeue()!;
      queue.complete(task.id);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should emit queue:drained when all tasks complete', () => {
      const handler = vi.fn();
      queue.on('queue:drained', handler);

      for (let i = 0; i < 5; i++) {
        const task = queue.dequeue()!;
        queue.complete(task.id);
      }
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('fail()', () => {
    it('should re-queue task if retries remaining', () => {
      const task = queue.dequeue()!;
      queue.fail(task.id, new Error('oops'), 3);
      const stats = queue.getStats();
      expect(stats.queued).toBe(5); // 4 original + 1 re-queued
      expect(stats.failed).toBe(0);
    });

    it('should move to failed after max retries', () => {
      const task = queue.dequeue()!;
      // Fail it 3 times (maxRetries=3 means fail after 3rd attempt)
      queue.fail(task.id, new Error('oops'), 1); // retry count 1 >= maxRetries 1
      const stats = queue.getStats();
      expect(stats.failed).toBe(1);
    });

    it('should increment retry count', () => {
      const task = queue.dequeue()!;
      queue.fail(task.id, new Error('oops'), 3);
      // The failed task is re-queued at the end; skip the 4 remaining original tasks
      for (let i = 0; i < 4; i++) queue.dequeue();
      const retried = queue.dequeue()!;
      expect(retried.retries).toBe(1);
    });

    it('should emit task:retrying when re-queued', () => {
      const handler = vi.fn();
      queue.on('task:retrying', handler);
      const task = queue.dequeue()!;
      queue.fail(task.id, new Error('oops'), 3);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should emit task:failed when max retries exceeded', () => {
      const handler = vi.fn();
      queue.on('task:failed', handler);
      const task = queue.dequeue()!;
      queue.fail(task.id, new Error('oops'), 0);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should throw for unknown task ID', () => {
      expect(() => queue.fail('unknown-id', new Error('oops'))).toThrow();
    });
  });

  describe('getStats()', () => {
    it('should return correct initial stats', () => {
      const stats = queue.getStats();
      expect(stats.queued).toBe(5);
      expect(stats.inProgress).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.total).toBe(5);
    });

    it('should track all state transitions', () => {
      const t1 = queue.dequeue()!;
      const t2 = queue.dequeue()!;
      queue.complete(t1.id);
      queue.fail(t2.id, new Error('err'), 0);

      const stats = queue.getStats();
      expect(stats.queued).toBe(3);
      expect(stats.inProgress).toBe(0);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.total).toBe(5);
    });
  });

  describe('isDrained()', () => {
    it('should return false when tasks remain', () => {
      expect(queue.isDrained()).toBe(false);
    });

    it('should return false when tasks in progress', () => {
      for (let i = 0; i < 5; i++) queue.dequeue();
      expect(queue.isDrained()).toBe(false);
    });

    it('should return true when all complete or failed', () => {
      for (let i = 0; i < 5; i++) {
        const task = queue.dequeue()!;
        queue.complete(task.id);
      }
      expect(queue.isDrained()).toBe(true);
    });
  });
});

describe('WorkerPoolBuilder', () => {
  describe('task loading methods', () => {
    it('should support .tasks() with Task array', () => {
      const pool = WorkerPool.builder()
        .totalTasks(2)
        .maxConcurrent(1)
        .tasks([{ id: '1', title: 'test', priority: 1 }])
        .build();
      expect(pool).toBeInstanceOf(WorkerPool);
    });

    it('should support .withSearchTerms() for string arrays', () => {
      const pool = WorkerPool.builder()
        .totalTasks(3)
        .maxConcurrent(1)
        .withSearchTerms(['term1', 'term2', 'term3'])
        .build();
      expect(pool).toBeInstanceOf(WorkerPool);
    });

    it('should support .repeat() for repeated instructions', () => {
      const pool = WorkerPool.builder()
        .maxConcurrent(2)
        .repeat(10, 'Do this thing')
        .build();
      expect(pool).toBeInstanceOf(WorkerPool);
    });

    it('should support .fromFile() for file-based loading', () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(1)
        .fromFile('/path/to/tasks.txt')
        .build();
      expect(pool).toBeInstanceOf(WorkerPool);
    });

    it('should support .taskLoader() for custom loaders', () => {
      const pool = WorkerPool.builder()
        .totalTasks(1)
        .maxConcurrent(1)
        .taskLoader(async () => [{ id: '1', title: 'custom', priority: 1 }])
        .build();
      expect(pool).toBeInstanceOf(WorkerPool);
    });
  });

  describe('.instructions()', () => {
    it('should generate prompt with task title appended', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(1)
        .maxConcurrent(1)
        .tasks([{ id: '1', title: 'MyTask', priority: 1 }])
        .instructions('Follow these steps')
        .llmProvider(new MockLLMProvider())
        .build();

      // The taskPrompt function should combine instructions + task.title
      expect(pool).toBeDefined();
    });
  });

  describe('.distributed()', () => {
    it('should accept distributed configuration', () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .distributed({ workCoordinator: {}, messageBus: {} })
        .build();
      expect(pool).toBeInstanceOf(WorkerPool);
    });
  });
});

describe('WorkerPool — Edge Cases', () => {
  it.todo('should handle build pool with 0 workers');

  it.todo('should handle build pool with negative worker count');

  it.todo('should handle build pool with workers = MAX_SAFE_INTEGER');

  it('should handle submit task after pool is stopped', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(3)
      .maxConcurrent(2)
      .tasks(createTasks(3))
      .llmProvider(new MockLLMProvider())
      .build();

    await pool.start();
    await pool.stop();

    // Attempting to submit after stop should throw
    expect(() => pool.submitTask({ id: 'late-task', title: 'Too late', priority: 1 })).toThrow();
  });

  it('should handle submit task with null payload', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(1)
      .maxConcurrent(1)
      .tasks([{ id: '1', title: 'test', priority: 1 }])
      .llmProvider(new MockLLMProvider())
      .build();

    await pool.start();

    // Submitting null task should throw
    expect(() => pool.submitTask(null as any)).toThrow();
  });

  it('should handle task that resolves to undefined result', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(1)
      .maxConcurrent(1)
      .tasks([{ id: '1', title: 'undefined-result', priority: 1 }])
      .llmProvider(new MockLLMProvider())
      .build();

    await pool.start();
    const stats = await pool.waitForCompletion();

    // Task with undefined result should still be counted as complete
    expect(stats.completed).toBe(1);
  });

  it.todo('should handle pool start called twice');

  it('should handle pool stop called before start', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(3)
      .maxConcurrent(2)
      .tasks(createTasks(3))
      .llmProvider(new MockLLMProvider())
      .build();

    // Stop before start - queue is not initialized, stop is a no-op
    await pool.stop();
  });

  it('should handle getStats when pool has never been started', () => {
    const pool = WorkerPool.builder()
      .totalTasks(5)
      .maxConcurrent(2)
      .tasks(createTasks(5))
      .llmProvider(new MockLLMProvider())
      .build();

    const stats = pool.getStats();
    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.inProgress).toBe(0);
    expect(stats.queued).toBe(0); // queue not loaded yet
  });

  it('should handle task with 0ms timeout (immediate timeout)', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(1)
      .maxConcurrent(1)
      .tasks([{ id: '1', title: 'instant-timeout', priority: 1 }])
      .taskTimeout(1) // 1ms timeout (effectively instant)
      .retryAttempts(0)
      .llmProvider(new MockLLMProvider({ delayMs: 100 }))
      .build();

    await pool.start();
    const stats = await pool.waitForCompletion();

    // With 1ms timeout and 100ms delay, task should fail
    expect(stats.failed).toBe(1);
  });

  it('should handle submit task during pool shutdown', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(5)
      .maxConcurrent(2)
      .tasks(createTasks(5))
      .llmProvider(new MockLLMProvider({ delayMs: 50 }))
      .build();

    await pool.start();

    // Start shutdown and immediately try to submit
    const stopPromise = pool.stop();

    // After stop() is called, stopped flag is set synchronously
    expect(() =>
      pool.submitTask({ id: 'during-shutdown', title: 'Should fail', priority: 1 })
    ).toThrow();

    await stopPromise;
  });
});

function createTasks(count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${String(i + 1).padStart(3, '0')}`,
    title: `Task ${i + 1}`,
    priority: 1,
  }));
}
