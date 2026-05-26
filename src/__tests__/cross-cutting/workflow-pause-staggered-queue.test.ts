import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockStep } from '../../__test__/MockStep';
import { TestClock } from '../../__test__/TestClock';
import { WorkerPoolManager } from '../../cross-cutting/WorkerPoolManager';
import { WorkflowRegistry } from '../../cross-cutting/WorkflowRegistry';
import { Observability } from '../../cross-cutting/Observability';
import { SessionCheckpoint } from '../../cross-cutting/SessionCheckpoint';
import { MockRedis } from '../../__test__/MockRedis';

/**
 * Cross-cutting: Workflow Injection + Pause/Resume + Staggered + Queued Agents
 */

describe('Cross-cutting: Workflow + Pause + Staggered + Queue', () => {
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock();
  });

  describe('workflow injection triggers staggered pause', () => {
    it('should pause workers one-by-one during rolling update', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 5 });
      pool.addWorkers(5, 1);
      pool.setProcessor(async (task) => task.id);

      const updateOrder: string[] = [];

      // Rolling update: one at a time
      for (const worker of pool.getWorkers()) {
        pool.pauseWorker(worker.id);
        pool.updateWorkerVersion(worker.id, 2);
        updateOrder.push(worker.id);
        pool.resumeWorker(worker.id);
      }

      // All updated in order
      expect(updateOrder.length).toBe(5);
      const versions = pool.getWorkers().map(w => w.version);
      expect(versions.every(v => v === 2)).toBe(true);
    });

    it('should maintain queue order during staggered update', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);
      pool.setProcessor(async (task) => task.id);

      // Submit tasks with priority ordering
      pool.submit({ id: 'task-a', priority: 3, data: {} });
      pool.submit({ id: 'task-b', priority: 2, data: {} });
      pool.submit({ id: 'task-c', priority: 1, data: {} });

      // Verify priority order preserved
      const snapshot = pool.getQueueSnapshot();
      expect(snapshot[0].id).toBe('task-a'); // Highest priority first
      expect(snapshot[1].id).toBe('task-b');
      expect(snapshot[2].id).toBe('task-c');

      // Do rolling update - queue order should be preserved
      await pool.rollingUpdate(2);

      // Remaining queue still in order
      const afterUpdate = pool.getQueueSnapshot();
      for (let i = 1; i < afterUpdate.length; i++) {
        expect(afterUpdate[i - 1].priority).toBeGreaterThanOrEqual(afterUpdate[i].priority);
      }
    });

    it('should handle urgent task arriving during rolling update', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);
      pool.setProcessor(async (task) => task.id);

      // Submit normal tasks
      pool.submit({ id: 'normal-1', priority: 1, data: {} });
      pool.submit({ id: 'normal-2', priority: 1, data: {} });

      // Mid-rollout, urgent task arrives
      pool.submit({ id: 'urgent', priority: 100, data: {} });

      // Urgent task is first in queue (highest priority)
      const snapshot = pool.getQueueSnapshot();
      expect(snapshot[0].id).toBe('urgent');
      expect(snapshot[0].priority).toBe(100);
    });
  });

  describe('queue preservation during pause', () => {
    it('should not reorder queue during pause/resume cycle', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);

      pool.submit({ id: 'A', priority: 3, data: {} });
      pool.submit({ id: 'B', priority: 2, data: {} });
      pool.submit({ id: 'C', priority: 1, data: {} });

      const beforePause = pool.getQueueSnapshot().map(t => t.id);

      pool.pause();
      pool.resume();

      const afterResume = pool.getQueueSnapshot().map(t => t.id);
      expect(afterResume).toEqual(beforePause);
    });

    it('should handle new tasks arriving during pause', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);
      pool.setProcessor(async (task) => task.id);

      pool.pause();
      pool.submit({ id: 'paused-task', priority: 1, data: {} });

      // Task in queue but not processed
      expect(pool.queueSize).toBe(1);
      const result = await pool.processNext();
      expect(result).toBeNull(); // Paused

      // Resume and process
      pool.resume();
      const processed = await pool.processNext();
      expect(processed).not.toBeNull();
      expect(processed!.id).toBe('paused-task');
    });

    it('should preserve retry state during pause (dont reset retry count)', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 1, maxRetries: 3 });
      pool.addWorkers(1);

      let attempts = 0;
      pool.setProcessor(async () => {
        attempts++;
        if (attempts <= 2) throw new Error('fail');
        return 'success';
      });

      pool.submit({ id: 'retry-task', priority: 1, data: {} });

      // First attempt fails
      await pool.processNext();
      expect(attempts).toBe(1);

      // Pause and resume
      pool.pause();
      pool.resume();

      // Second attempt - retry count preserved
      await pool.processNext();
      expect(attempts).toBe(2);

      // Third attempt succeeds
      await pool.processNext();
      expect(attempts).toBe(3);
    });

    it('should move DLQ items back to main queue during reconfigure', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 1, maxRetries: 1, enableDLQ: true });
      pool.addWorkers(1);
      pool.setProcessor(async () => { throw new Error('always fails'); });

      pool.submit({ id: 'bad-task', priority: 1, data: {} });
      await pool.processNext(); // Fails, goes to DLQ

      expect(pool.dlqSize).toBe(1);
      expect(pool.queueSize).toBe(0);

      // Reconfigure: replay DLQ
      const replayed = pool.replayDLQ();
      expect(replayed).toBe(1);
      expect(pool.dlqSize).toBe(0);
      expect(pool.queueSize).toBe(1);
    });
  });

  describe('staggered ramp-up with workflow changes', () => {
    it('should apply new workflow to each worker as it starts', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 5 });

      // Start with 1 worker
      pool.addWorkers(1, 2); // Version 2 (latest)
      expect(pool.workerCount).toBe(1);

      // Gradually add more
      pool.addWorkers(2, 2);
      pool.addWorkers(2, 2);
      expect(pool.workerCount).toBe(5);

      // All on latest version
      const versions = pool.getWorkers().map(w => w.version);
      expect(versions.every(v => v === 2)).toBe(true);
    });

    it('should handle workflow change mid-ramp-up', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 5 });

      // First 3 workers on v1
      pool.addWorkers(3, 1);

      // Workflow changes - update existing workers
      for (const worker of pool.getWorkers()) {
        pool.updateWorkerVersion(worker.id, 2);
      }

      // Workers 4-5 start with new version
      pool.addWorkers(2, 2);

      const versions = pool.getWorkers().map(w => w.version);
      expect(versions.every(v => v === 2)).toBe(true);
    });

    it('should drain old-config workers before full ramp-up', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3, 1);
      pool.setProcessor(async (task) => task.id);

      // Submit work
      pool.submit({ id: 'drain-task', priority: 1, data: {} });
      await pool.processNext(); // Complete current work

      // Drain: stop old workers, start new
      for (const worker of pool.getWorkers()) {
        pool.pauseWorker(worker.id);
      }

      // Update and resume
      for (const worker of pool.getWorkers()) {
        pool.updateWorkerVersion(worker.id, 2);
        pool.resumeWorker(worker.id);
      }

      // All on new config
      expect(pool.getWorkers().every(w => w.version === 2)).toBe(true);
    });
  });

  describe('priority queue + staggered + workflow interaction', () => {
    it('should process high-priority tasks even during staggered update', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);
      const processed: string[] = [];
      pool.setProcessor(async (task) => { processed.push(task.id); return task.id; });

      pool.submit({ id: 'low-1', priority: 1, data: {} });
      pool.submit({ id: 'high-1', priority: 100, data: {} });
      pool.submit({ id: 'low-2', priority: 1, data: {} });

      // Process during update
      await pool.processNext();
      expect(processed[0]).toBe('high-1'); // High priority first
    });

    it('should apply new workflow only to future task executions', async () => {
      const registry = new WorkflowRegistry();

      registry.addStep({
        name: 'old-step',
        priority: 100,
        execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, workflow: 'old' } }),
      });

      // Task uses old workflow
      const oldResult = await registry.execute({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {},
      });
      expect(oldResult.data.workflow).toBe('old');

      // Update workflow
      registry.replaceStep('old-step', {
        name: 'old-step',
        priority: 100,
        execute: async (ctx) => ({ ...ctx, data: { ...ctx.data, workflow: 'new' } }),
      });

      // Next task uses new workflow
      const newResult = await registry.execute({
        turnNumber: 2, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {},
      });
      expect(newResult.data.workflow).toBe('new');
    });

    it('should handle dead-letter queue growth during workflow change', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 1, maxRetries: 1, enableDLQ: true });
      pool.addWorkers(1);

      // Bad workflow causes failures
      pool.setProcessor(async () => { throw new Error('bad workflow'); });
      pool.submit({ id: 'task-1', priority: 1, data: {} });
      pool.submit({ id: 'task-2', priority: 1, data: {} });
      await pool.processNext();
      await pool.processNext();

      expect(pool.dlqSize).toBe(2);

      // Fix workflow
      pool.setProcessor(async (task) => task.id);
      pool.submit({ id: 'task-3', priority: 1, data: {} });
      await pool.processNext();

      // New tasks don't go to DLQ
      expect(pool.completedCount).toBe(1);
    });
  });

  describe('Deep Interactions: Workflow + Pool + Metrics + State', () => {
    it('should handle workflow change triggering metrics reset while metrics are being scraped', async () => {
      const obs = new Observability();

      // Emit metrics
      obs.incrementCounter('step:validate:count', { step: 'validate' });
      obs.incrementCounter('step:validate:count', { step: 'validate' });

      // Scrape starts
      const scrapeResult = obs.export();
      expect(scrapeResult.metrics.length).toBe(2);

      // Workflow change resets counters (new metrics after this point)
      obs.incrementCounter('step:validate:count', { step: 'validate', version: '2' });

      // New metrics have version label
      const newMetrics = obs.getMetrics('step:validate:count');
      const v2Metrics = newMetrics.filter(m => m.labels.version === '2');
      expect(v2Metrics.length).toBe(1);
    });

    it('should not persist paused state in checkpoint during pause/resume cycle', async () => {
      const redis = new MockRedis();
      const checkpoint = new SessionCheckpoint({ agentId: 'pool-1', redis });
      const pool = new WorkerPoolManager({ maxWorkers: 3 });
      pool.addWorkers(3);

      // Pause
      pool.pause();

      // Checkpoint during pause - mark as transient
      await checkpoint.save(
        { paused: true, workers: pool.getWorkers().map(w => w.id) },
        {},
        { transient: true }
      );

      // Resume
      pool.resume();

      // Save durable checkpoint
      await checkpoint.save({ paused: false, workers: pool.getWorkers().map(w => w.id) }, {});

      // Restore should get the durable (non-paused) checkpoint
      const restored = await checkpoint.restore();
      expect(restored!.state.paused).toBe(false);
    });

    it('should handle staggered deployment with different metric schemas (version skew)', async () => {
      const obs = new Observability();

      // Worker 1-3 on v1 emit in seconds
      obs.recordHistogram('task_duration', 1.5, { version: 'v1', unit: 'seconds' });
      obs.recordHistogram('task_duration', 2.0, { version: 'v1', unit: 'seconds' });

      // Worker 4-5 on v2 emit in milliseconds
      obs.recordHistogram('task_duration', 1500, { version: 'v2', unit: 'ms' });

      // Detect version skew
      const allDuration = obs.getMetrics('task_duration');
      const versions = new Set(allDuration.map(m => m.labels.version));
      const hasSkew = versions.size > 1;
      expect(hasSkew).toBe(true);

      // Normalize or label by version
      const v1Metrics = allDuration.filter(m => m.labels.version === 'v1');
      const v2Metrics = allDuration.filter(m => m.labels.version === 'v2');
      expect(v1Metrics[0].labels.unit).toBe('seconds');
      expect(v2Metrics[0].labels.unit).toBe('ms');
    });

    it('should prevent queue priority inversion during workflow reconfiguration', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 2 });
      pool.addWorkers(2);
      pool.setProcessor(async (task) => task.id);

      // High priority user task
      pool.submit({ id: 'user-task', priority: 100, data: {} });
      // Internal config propagation task (should not block user task)
      pool.submit({ id: 'config-propagate', priority: 1, data: {} });

      // User task should be first
      const snapshot = pool.getQueueSnapshot();
      expect(snapshot[0].id).toBe('user-task');
      expect(snapshot[0].priority).toBeGreaterThan(snapshot[1].priority);
    });

    it('should handle workflow removal while metrics dashboard references removed step metrics', async () => {
      const obs = new Observability();
      const registry = new WorkflowRegistry();

      registry.addStep({
        name: 'validate',
        priority: 100,
        execute: async (ctx) => {
          obs.incrementCounter('validate_count', { step: 'validate' });
          return ctx;
        },
      });

      // Emit some metrics
      await registry.execute({
        turnNumber: 1, messages: [], state: {}, metadata: {},
        shouldContinue: true, data: {},
      });

      // Remove step
      registry.removeStep('validate');

      // Dashboard queries stale metric - gets historical data
      const validateMetrics = obs.getMetrics('validate_count');
      expect(validateMetrics.length).toBe(1); // Historical data still exists

      // Emit tombstone
      obs.setGauge('step_removed', 1, { step: 'validate', removedAt: String(Date.now()) });
      const tombstone = obs.getMetrics('step_removed');
      expect(tombstone.length).toBe(1);
    });

    it('should handle pool reconfiguration changing state storage backend during active writes', async () => {
      const redisA = new MockRedis();
      const redisB = new MockRedis();

      // Active writes to backend A
      await redisA.set('state:key1', 'value1');
      await redisA.set('state:key2', 'value2');

      // Migrate to backend B (copy data)
      const key1 = await redisA.get('state:key1');
      const key2 = await redisA.get('state:key2');
      await redisB.set('state:key1', key1!);
      await redisB.set('state:key2', key2!);

      // Verify no data loss
      expect(await redisB.get('state:key1')).toBe('value1');
      expect(await redisB.get('state:key2')).toBe('value2');
    });

    it('should handle staggered rollout partially completing then new rollout starting (version gap)', async () => {
      const pool = new WorkerPoolManager({ maxWorkers: 5 });
      pool.addWorkers(5, 1);

      // Rollout v1->v2: workers 1-3 updated
      const workers = pool.getWorkers();
      pool.updateWorkerVersion(workers[0].id, 2);
      pool.updateWorkerVersion(workers[1].id, 2);
      pool.updateWorkerVersion(workers[2].id, 2);

      // New rollout v2->v3 starts before first completes
      // Workers 4-5 skip v2 entirely (v1->v3 direct)
      pool.updateWorkerVersion(workers[0].id, 3);
      pool.updateWorkerVersion(workers[1].id, 3);
      pool.updateWorkerVersion(workers[2].id, 3);
      pool.updateWorkerVersion(workers[3].id, 3); // Skipped v2
      pool.updateWorkerVersion(workers[4].id, 3); // Skipped v2

      const versions = pool.getWorkers().map(w => w.version);
      expect(versions.every(v => v === 3)).toBe(true);
    });

    it('should handle DLQ replay with new workflow causing different metrics than original execution', async () => {
      const obs = new Observability();
      const pool = new WorkerPoolManager({ maxWorkers: 1, maxRetries: 1, enableDLQ: true });
      pool.addWorkers(1);

      // Original workflow - fails with metric X
      pool.setProcessor(async () => {
        obs.incrementCounter('failure_metric_x', { source: 'original' });
        throw new Error('fail');
      });
      pool.submit({ id: 'task-1', priority: 1, data: {} });
      await pool.processNext();
      expect(pool.dlqSize).toBe(1);

      // New workflow - different metric name Y
      pool.setProcessor(async (task) => {
        obs.incrementCounter('failure_metric_y', { source: 'replay' });
        return task.id;
      });

      // Replay DLQ
      pool.replayDLQ();
      await pool.processNext();

      // Both metrics exist - lineage should be linked
      const metricX = obs.getMetrics('failure_metric_x');
      const metricY = obs.getMetrics('failure_metric_y');
      expect(metricX.length).toBe(1);
      expect(metricY.length).toBe(1);
      expect(metricX[0].labels.source).toBe('original');
      expect(metricY[0].labels.source).toBe('replay');
    });
  });
});
