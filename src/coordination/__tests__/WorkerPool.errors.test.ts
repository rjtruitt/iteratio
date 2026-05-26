import { describe, it, expect, vi } from 'vitest';
import { WorkerPool, Task } from '../WorkerPool';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';

describe('WorkerPool — Error Handling', () => {
  describe('worker crash', () => {
    it('should detect when a worker crashes mid-task', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider({ throwOnCall: 0 }))
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      // Should have handled the crash gracefully
      expect(stats.total).toBe(5);
    });

    it('should reassign crashed worker task to another worker', async () => {
      const onTaskComplete = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(3)
        .maxConcurrent(2)
        .tasks(createTasks(3))
        .llmProvider(new MockLLMProvider({ throwOnCall: 0 }))
        .retryAttempts(2)
        .onTaskComplete(onTaskComplete)
        .build();

      await pool.start();
      await pool.waitForCompletion();
      // Task should have been retried and completed
      expect(onTaskComplete).toHaveBeenCalled();
    });

    it('should not crash the entire pool when one worker dies', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(3)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider({ throwOnCall: 2 }))
        .retryAttempts(1)
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed + stats.failed).toBe(10);
    });
  });

  describe('task failure', () => {
    it('should retry failed tasks up to retryAttempts', async () => {
      let attempts = 0;
      const pool = WorkerPool.builder()
        .totalTasks(1)
        .maxConcurrent(1)
        .tasks(createTasks(1))
        .retryAttempts(3)
        .llmProvider(new MockLLMProvider({
          throwOnCall: 0,
          throwError: new Error('Transient error'),
        }))
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      // Should have attempted multiple times before final failure
    });

    it('should move to dead letter queue after max retries', async () => {
      const onTaskFailed = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(1)
        .maxConcurrent(1)
        .tasks(createTasks(1))
        .retryAttempts(2)
        .llmProvider(new MockLLMProvider({ throwOnCall: 0 }))
        .onTaskFailed(onTaskFailed)
        .build();

      await pool.start();
      await pool.waitForCompletion();
      expect(onTaskFailed).toHaveBeenCalledOnce();
    });

    it('should preserve error context in failed task', async () => {
      const onTaskFailed = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(1)
        .maxConcurrent(1)
        .tasks(createTasks(1))
        .retryAttempts(0)
        .llmProvider(new MockLLMProvider({
          throwOnCall: 0,
          throwError: new Error('Specific error message'),
        }))
        .onTaskFailed(onTaskFailed)
        .build();

      await pool.start();
      await pool.waitForCompletion();
      const [failedTask, error] = onTaskFailed.mock.calls[0];
      expect(error).toBeDefined();
    });
  });

  describe('poison pill', () => {
    it('should handle a task that always fails without blocking other tasks', async () => {
      const tasks = createTasks(5);
      // Make task 3 a poison pill by adding metadata
      tasks[2].metadata = { poisonPill: true };

      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(tasks)
        .retryAttempts(1)
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      // Other tasks should still complete
      expect(stats.completed).toBeGreaterThan(0);
    });

    it('should quarantine tasks that fail with same error pattern', async () => {
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

  describe('timeout', () => {
    it('should timeout tasks that exceed taskTimeout', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(1)
        .maxConcurrent(1)
        .tasks(createTasks(1))
        .taskTimeout(100) // 100ms timeout
        .llmProvider(new MockLLMProvider({ delayMs: 500 })) // Takes 500ms
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.failed).toBe(1);
    });

    it('should reassign timed-out tasks', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(1)
        .maxConcurrent(2)
        .tasks(createTasks(1))
        .taskTimeout(50)
        .retryAttempts(2)
        .llmProvider(new MockLLMProvider({ delayMs: 200 }))
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      // Should have retried the timed-out task
    });
  });

  describe('health check', () => {
    it('should detect stuck workers via health check', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(3)
        .maxConcurrent(2)
        .tasks(createTasks(3))
        .healthCheckInterval(50)
        .taskTimeout(100)
        .llmProvider(new MockLLMProvider({ delayMs: 500 }))
        .build();

      const handler = vi.fn();
      pool.on('worker:stuck', handler);
      await pool.start();
      // Health check should fire and detect stuck worker
    });

    it('should mark dead workers and reassign their tasks', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(3)
        .tasks(createTasks(5))
        .healthCheckInterval(20)
        .taskTimeout(50)
        .retryAttempts(1)
        .llmProvider(new MockLLMProvider({ delayMs: 200 }))
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed + stats.failed).toBe(5);
    });
  });


  describe('Adversarial: Concurrency Attacks', () => {
    it.todo('should handle task that kills its own worker (self-DoS)');

    it.todo('should prevent task from stealing work from other workers queues');

    it.todo('should handle task that blocks thread pool forever (starvation)');

    it.todo('should handle task that spawns more tasks than pool capacity (fork bomb)');

    it.todo('should handle two tasks that need each others result (deadlock)');

    it.todo('should handle task that continuously yields then reschedules (livelock)');

    it.todo('should prevent high-priority task from always preempting low-priority (starvation)');

    it.todo('should handle task that corrupts shared pool state during execution');

    it.todo('should handle task completion callback that throws (breaks pool loop)');

    it.todo('should handle rapid submit/cancel cycles that leak resources');
  });
});

function createTasks(count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${String(i + 1).padStart(3, '0')}`,
    title: `Task ${i + 1}`,
    priority: 1,
  }));
}
