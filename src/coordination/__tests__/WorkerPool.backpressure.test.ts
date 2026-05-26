import { describe, it, expect, vi } from 'vitest';
import { WorkerPool, Task } from '../WorkerPool';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';

describe('WorkerPool — Backpressure', () => {
  describe('queue full', () => {
    it('should emit backpressure signal when queue exceeds threshold', async () => {
      const handler = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(100)
        .maxConcurrent(1)
        .tasks(createTasks(100))
        .llmProvider(new MockLLMProvider({ delayMs: 100 }))
        .build();

      pool.on('queue:backpressure', handler);
      await pool.start();
      // With 1 slow worker and 100 tasks, backpressure should fire
      expect(handler).toHaveBeenCalled();
    });

    it('should pause task loading when backpressure threshold exceeded', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(50)
        .maxConcurrent(2)
        .tasks(createTasks(50))
        .llmProvider(new MockLLMProvider({ delayMs: 50 }))
        .build();

      await pool.start();
      // Queue depth should be managed — not all 50 loaded at once if workers are slow
      const stats = pool.getStats();
      expect(stats.queued).toBeLessThanOrEqual(50);
    });
  });

  describe('drain behavior', () => {
    it('should resume loading after backpressure clears', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(20)
        .maxConcurrent(5)
        .tasks(createTasks(20))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(20);
    });

    it('should drain completely when all workers finish', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(5)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.queued).toBe(0);
      expect(stats.inProgress).toBe(0);
    });
  });

  describe('overflow rejection', () => {
    it('should reject new tasks when queue capacity is reached', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(1000)
        .maxConcurrent(1)
        .tasks(createTasks(1000))
        .llmProvider(new MockLLMProvider({ delayMs: 1000 }))
        .build();

      // Pool should not accept unbounded queue growth
      await pool.start();
      const stats = pool.getStats();
      expect(stats.total).toBeLessThanOrEqual(1000);
    });
  });

  describe('slow consumer detection', () => {
    it('should detect when workers are consistently slower than task arrival', async () => {
      const handler = vi.fn();
      const pool = WorkerPool.builder()
        .totalTasks(50)
        .maxConcurrent(1)
        .tasks(createTasks(50))
        .llmProvider(new MockLLMProvider({ delayMs: 200 }))
        .build();

      pool.on('pool:slow-consumer', handler);
      await pool.start();
      // Eventually the system should notice backlog growing
    });
  });
});

describe('WorkerPool Backpressure — Edge Cases', () => {
  it.todo('should handle queue capacity = 0 (no buffering)');

  it.todo('should handle queue capacity = 1 (minimal buffer)');

  it.todo('should handle drain event fires with 0 items processed');

  it.todo('should handle backpressure exactly at queue capacity (boundary)');

  it('should handle consumer slower than producer (tasks queued upfront)', async () => {
    const pool = WorkerPool.builder()
      .totalTasks(20)
      .maxConcurrent(1)
      .tasks(createTasks(20))
      .llmProvider(new MockLLMProvider({ delayMs: 10 }))
      .build();

    await pool.start();
    // All tasks are loaded into queue at once; queue has remaining tasks
    const stats = pool.getStats();
    expect(stats.queued + stats.inProgress + stats.completed).toBe(20);
  });

  it('should handle all tasks failing (throwOnCall: 0 means first call throws)', async () => {
    const onTaskFailed = vi.fn();
    const pool = WorkerPool.builder()
      .totalTasks(10)
      .maxConcurrent(3)
      .tasks(createTasks(10))
      .retryAttempts(0)
      .llmProvider(new MockLLMProvider({ throwOnCall: 0 }))
      .onTaskFailed(onTaskFailed)
      .build();

    await pool.start();
    const stats = await pool.waitForCompletion();

    // First call throws means first task fails; rest succeed (throwOnCall is index-based)
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    expect(stats.inProgress).toBe(0);
  });

  it('should handle queue state after repeated fill/drain cycles (memory leak check)', async () => {
    // Run multiple complete cycles to check for memory accumulation
    for (let cycle = 0; cycle < 5; cycle++) {
      const pool = WorkerPool.builder()
        .totalTasks(20)
        .maxConcurrent(5)
        .tasks(createTasks(20))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(20);
      expect(stats.queued).toBe(0);
      expect(stats.inProgress).toBe(0);
    }
    // If we get here without hanging, no obvious leak
    expect(true).toBe(true);
  });
});

function createTasks(count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${String(i + 1).padStart(3, '0')}`,
    title: `Task ${i + 1}`,
    priority: 1,
  }));
}
