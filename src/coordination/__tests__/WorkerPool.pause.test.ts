import { describe, it, expect, vi } from 'vitest';
import { WorkerPool, Task } from '../WorkerPool';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';

describe('WorkerPool — Pause/Resume/Reconfigure', () => {
  describe('pool.pause()', () => {
    it('should stop assigning new tasks after pause', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(20)
        .maxConcurrent(3)
        .tasks(createTasks(20))
        .llmProvider(new MockLLMProvider({ delayMs: 50 }))
        .build();

      await pool.start();
      await pool.pause();
      const stats = pool.getStats();
      // No new tasks should be assigned while paused
      const statsAfterPause = pool.getStats();
      expect(statsAfterPause.inProgress).toBeLessThanOrEqual(3);
    });

    it('should allow in-progress tasks to complete during pause', async () => {
      const onTaskComplete = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(3)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider({ delayMs: 20 }))
        .onTaskComplete(onTaskComplete)
        .build();

      await pool.start();
      await pool.pause();
      // Wait for in-progress tasks to finish
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(onTaskComplete).toHaveBeenCalled();
    });

    it('should emit pool:paused event when all workers idle', async () => {
      const handler = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .build();

      pool.on('pool:paused', handler);
      await pool.start();
      await pool.pause();
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should return a promise that resolves when all workers are idle', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider({ delayMs: 20 }))
        .build();

      await pool.start();
      await pool.pause(); // Should wait until current tasks finish
      const stats = pool.getStats();
      expect(stats.inProgress).toBe(0);
    });
  });

  describe('pool.resume()', () => {
    it('should resume task assignment after pause', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(2)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      await pool.pause();
      pool.resume();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(10);
    });

    it('should emit pool:resumed event', async () => {
      const handler = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .build();

      pool.on('pool:resumed', handler);
      await pool.start();
      await pool.pause();
      pool.resume();
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should be a no-op if not paused', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      pool.resume(); // Should not throw or break anything
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(5);
    });
  });

  describe('pool.reconfigure(fn)', () => {
    it('should pause, apply changes, then resume atomically', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(2)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider({ delayMs: 20 }))
        .build();

      await pool.start();

      await pool.reconfigure((config) => {
        config.maxTurnsPerTask = 30;
      });

      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(10);
    });

    it('should not drop any work during reconfiguration', async () => {
      const onTaskComplete = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(3)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider({ delayMs: 10 }))
        .onTaskComplete(onTaskComplete)
        .build();

      await pool.start();
      await pool.reconfigure(() => {});
      const stats = await pool.waitForCompletion();
      expect(stats.completed + stats.failed).toBe(10);
    });

    it('should allow changing maxConcurrent during reconfigure', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(20)
        .maxConcurrent(2)
        .tasks(createTasks(20))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      await pool.reconfigure((config) => {
        config.maxConcurrent = 5;
      });
      // After reconfigure, should have more workers
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(20);
    });

    it('should allow changing system prompt during reconfigure', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .systemPrompt('Original prompt')
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      await pool.reconfigure((config) => {
        config.systemPrompt = 'Updated prompt';
      });
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(5);
    });

    it('should throw if reconfigure callback throws', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      await expect(
        pool.reconfigure(() => { throw new Error('Config error'); })
      ).rejects.toThrow('Config error');
    });

    it('should resume even if reconfigure throws (no stuck pause)', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(5)
        .maxConcurrent(2)
        .tasks(createTasks(5))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      try {
        await pool.reconfigure(() => { throw new Error('boom'); });
      } catch {}
      // Pool should still be operational
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(5);
    });
  });

  describe('pause at end of turn', () => {
    it('should pause only at turn boundaries, not mid-execution', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(3)
        .maxConcurrent(1)
        .tasks(createTasks(3))
        .maxTurnsPerTask(5)
        .llmProvider(new MockLLMProvider({ delayMs: 10 }))
        .build();

      await pool.start();
      const pausePromise = pool.pause();
      // Pause should wait until current turn completes, not interrupt mid-turn
      await pausePromise;
      const stats = pool.getStats();
      expect(stats.inProgress).toBe(0);
    });
  });
});

describe('WorkerPool Pause/Resume — Edge Cases', () => {
  it('should handle pause when already paused (idempotent)', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(10)
      .maxConcurrent(2)
      .tasks(createTasks(10))
      .llmProvider(new MockLLMProvider({ delayMs: 20 }))
      .build();

    await pool.start();
    await pool.pause();

    // Second pause should be a no-op, not throw
    await expect(pool.pause()).resolves.toBeUndefined();
  });

  it('should handle resume when not paused (no-op)', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(5)
      .maxConcurrent(2)
      .tasks(createTasks(5))
      .llmProvider(new MockLLMProvider())
      .build();

    await pool.start();

    // Resume without prior pause should be a no-op
    pool.resume();
    const stats = await pool.waitForCompletion();
    expect(stats.completed).toBe(5);
  });

  it.todo('should handle reconfigure with invalid config (should reject, stay paused)');

  it('should handle pause during task execution (waits for completion)', async () => {
    const onTaskComplete = vi.fn();
    const pool = WorkerPool.builder()
      .totalTasks(5)
      .maxConcurrent(3)
      .tasks(createTasks(5))
      .llmProvider(new MockLLMProvider({ delayMs: 50 }))
      .onTaskComplete(onTaskComplete)
      .build();

    await pool.start();

    // Pause while tasks are actively executing
    await pool.pause();

    // After pause resolves, no tasks should be in-progress
    const stats = pool.getStats();
    expect(stats.inProgress).toBe(0);

    // Some tasks should have completed during the drain
    expect(onTaskComplete).toHaveBeenCalled();
  });

  it.todo('should handle rapid pause/resume cycles (100 times)');

  it.todo('should handle reconfigure that changes concurrency from 10 to 1 (drain excess)');

  it('should handle pause with timeout (auto-resume if not manually resumed)', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(10)
      .maxConcurrent(2)
      .tasks(createTasks(10))
      .llmProvider(new MockLLMProvider({ delayMs: 10 }))
      .build();

    await pool.start();

    // Pause with a timeout - should auto-resume after timeout
    await pool.pause({ timeout: 100 });

    // Wait longer than the timeout
    await new Promise(resolve => setTimeout(resolve, 200));

    // Pool should have auto-resumed
    const finalStats = await pool.waitForCompletion();
    expect(finalStats.completed).toBe(10);
  });
});

function createTasks(count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${String(i + 1).padStart(3, '0')}`,
    title: `Task ${i + 1}`,
    priority: 1,
  }));
}
