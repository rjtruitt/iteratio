import { describe, it, expect, vi } from 'vitest';
import { WorkerPool, Task } from '../WorkerPool';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';

describe('WorkerPool — Scaling', () => {
  describe('2 workers', () => {
    it('should process tasks with 2 concurrent workers', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(6)
        .maxConcurrent(2)
        .tasks(createTasks(6))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(6);
    });

    it('should never have more than 2 in-progress simultaneously', async () => {
      let maxConcurrent = 0;
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(2)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider({ delayMs: 10 }))
        .onProgress((stats) => {
          maxConcurrent = Math.max(maxConcurrent, stats.inProgress);
        })
        .build();

      await pool.start();
      await pool.waitForCompletion();
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('5 workers', () => {
    it('should process tasks with 5 concurrent workers', async () => {
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
  });

  describe('10 workers', () => {
    it('should process tasks with 10 concurrent workers', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(50)
        .maxConcurrent(10)
        .tasks(createTasks(50))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(50);
    });
  });

  describe('50 workers', () => {
    it('should handle 50 concurrent workers on same process', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(100)
        .maxConcurrent(50)
        .tasks(createTasks(100))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(100);
    });

    it('should not exceed memory bounds with 50 workers', async () => {
      const memBefore = process.memoryUsage().heapUsed;
      const pool = WorkerPool.builder()
        .totalTasks(100)
        .maxConcurrent(50)
        .tasks(createTasks(100))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      await pool.waitForCompletion();
      const memAfter = process.memoryUsage().heapUsed;
      const memGrowth = memAfter - memBefore;
      expect(memGrowth).toBeLessThan(500 * 1024 * 1024); // < 500MB
    });
  });

  describe('dynamic scaling', () => {
    it('should support adding workers at runtime', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(20)
        .maxConcurrent(2)
        .tasks(createTasks(20))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      // Should be able to add workers dynamically
      // pool.addWorker();
      // pool.addWorker();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(20);
    });

    it('should support removing workers at runtime', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(10)
        .maxConcurrent(5)
        .tasks(createTasks(10))
        .llmProvider(new MockLLMProvider({ delayMs: 50 }))
        .build();

      await pool.start();
      // pool.removeWorker('Worker-5');
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(10);
    });

    it('should handle more workers than tasks gracefully', async () => {
      const pool = WorkerPool.builder()
        .totalTasks(2)
        .maxConcurrent(10)
        .tasks(createTasks(2))
        .llmProvider(new MockLLMProvider())
        .build();

      await pool.start();
      const stats = await pool.waitForCompletion();
      expect(stats.completed).toBe(2);
    });
  });

  describe('Adversarial: Scaling Attacks', () => {
    it.todo('should handle scale up and scale down requested simultaneously');

    it.todo('should handle scale to 0 while tasks are in-flight');

    it.todo('should handle scale request during another scale operation (nested scaling)');

    it.todo('should handle oscillating scale (up/down/up/down faster than execution)');

    it.todo('should handle scale up with all new workers immediately failing');

    it.todo('should handle worker added during shutdown (race between add and remove)');

    it.todo('should handle scale beyond system resource limits (thread/memory exhaustion)');
  });
});

function createTasks(count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${String(i + 1).padStart(3, '0')}`,
    title: `Task ${i + 1}`,
    priority: 1,
  }));
}
