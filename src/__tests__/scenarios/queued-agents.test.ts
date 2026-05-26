import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockRedis,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 18: Priority Queue with Dead Letter Queue ---
// Tests priority ordering, DLQ routing, retry backoff, poison pill detection,
// queue inspection, reordering, DLQ replay, and depth alerting.

describe('E2E Scenario 18: Priority Queue with DLQ', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let redis: MockRedis;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    redis = new MockRedis();
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
    redis.reset();
  });

  describe('Priority Queue', () => {
    it('should process high-priority tasks before low-priority ones', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      const processed: string[] = [];

      queue.on('task:processed', (t: any) => processed.push(t.id));

      queue.enqueue({ id: 'low', data: 'x', priority: 1 });
      queue.enqueue({ id: 'medium', data: 'x', priority: 5 });
      queue.enqueue({ id: 'high', data: 'x', priority: 10 });

      await queue.processNext();
      await queue.processNext();
      await queue.processNext();

      expect(processed).toEqual(['high', 'medium', 'low']);
    });

    it('should respect FIFO within same priority level', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      const processed: string[] = [];

      queue.on('task:processed', (t: any) => processed.push(t.id));

      queue.enqueue({ id: 'a', data: 'x', priority: 5 });
      queue.enqueue({ id: 'b', data: 'x', priority: 5 });
      queue.enqueue({ id: 'c', data: 'x', priority: 5 });

      await queue.processAll();

      expect(processed).toEqual(['a', 'b', 'c']);
    });

    it('should handle priority 0 (lowest) tasks last', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      const processed: string[] = [];

      queue.on('task:processed', (t: any) => processed.push(t.id));

      queue.enqueue({ id: 'zero', data: 'x', priority: 0 });
      queue.enqueue({ id: 'one', data: 'x', priority: 1 });

      await queue.processAll();

      expect(processed[0]).toBe('one');
      expect(processed[1]).toBe('zero');
    });
  });

  describe('Dead Letter Queue', () => {
    it('should move failed task to DLQ after max retries', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(3);
      queue.setHandler(async () => { throw new Error('always fails'); });

      queue.enqueue({ id: 'doomed', data: 'x', priority: 5 });

      // Process with retries (should fail 3 times then go to DLQ)
      for (let i = 0; i < 4; i++) {
        await queue.processNext().catch(() => {});
      }

      const dlq = queue.getDeadLetterQueue();
      expect(dlq.some((t: any) => t.id === 'doomed')).toBe(true);
    });

    it('should include failure reason in DLQ entry', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(1);
      queue.setHandler(async () => { throw new Error('specific failure'); });

      queue.enqueue({ id: 'failed-task', data: 'x', priority: 5 });
      await queue.processNext().catch(() => {});
      await queue.processNext().catch(() => {});

      const dlqEntry = queue.getDeadLetterQueue().find((t: any) => t.id === 'failed-task');
      expect(dlqEntry.lastError).toContain('specific failure');
      expect(dlqEntry.attempts).toBe(2);
    });

    it('should emit event when task moves to DLQ', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(1);
      queue.setHandler(async () => { throw new Error('fail'); });

      queue.enqueue({ id: 'dlq-task', data: 'x', priority: 5 });
      await queue.processNext().catch(() => {});
      await queue.processNext().catch(() => {});

      expect(eventBus.emitted('task:deadLettered')).toBe(true);
    });
  });

  describe('Retry Backoff', () => {
    it('should wait 1s, 2s, 4s, 8s between retries (exponential backoff)', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(4);
      queue.setBackoff('exponential');

      const retryTimestamps: number[] = [];
      queue.on('task:retry', () => retryTimestamps.push(clock.now));
      queue.setHandler(async () => { throw new Error('retry me'); });

      queue.enqueue({ id: 'backoff-task', data: 'x', priority: 5 });

      // First attempt (immediate)
      await queue.processNext().catch(() => {});

      // Advance through retries
      clock.advance(1000); // 1s delay
      await queue.processRetries();
      clock.advance(2000); // 2s delay
      await queue.processRetries();
      clock.advance(4000); // 4s delay
      await queue.processRetries();
      clock.advance(8000); // 8s delay
      await queue.processRetries();

      // Verify exponential backoff timing
      const delays = retryTimestamps.map((t, i) => i === 0 ? t : t - retryTimestamps[i - 1]);
      expect(delays[1]).toBeGreaterThanOrEqual(1000);
      expect(delays[2]).toBeGreaterThanOrEqual(2000);
      expect(delays[3]).toBeGreaterThanOrEqual(4000);
    });

    it('should reset retry count on successful processing', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(3);
      let failCount = 0;
      queue.setHandler(async () => {
        failCount++;
        if (failCount <= 2) throw new Error('transient');
        return 'success';
      });

      queue.enqueue({ id: 'eventually-succeeds', data: 'x', priority: 5 });

      // Fails twice, then succeeds
      await queue.processNext().catch(() => {});
      await queue.processNext().catch(() => {});
      await queue.processNext();

      const dlq = queue.getDeadLetterQueue();
      expect(dlq.some((t: any) => t.id === 'eventually-succeeds')).toBe(false);
    });
  });

  describe('Poison Pill Detection', () => {
    it('should quarantine task that always fails with same error', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(5);
      queue.setPoisonPillDetection(true);
      queue.setHandler(async (task: any) => {
        if (task.id === 'poison') throw new Error('deterministic failure');
        return 'ok';
      });

      queue.enqueue({ id: 'poison', data: 'x', priority: 5 });

      // After detecting consistent failure pattern, quarantine early
      for (let i = 0; i < 3; i++) {
        await queue.processNext().catch(() => {});
      }

      expect(queue.isQuarantined('poison')).toBe(true);
      expect(eventBus.emitted('task:quarantined')).toBe(true);
    });

    it('should not quarantine tasks with varying failure reasons', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(5);
      queue.setPoisonPillDetection(true);
      let attempt = 0;
      queue.setHandler(async () => {
        attempt++;
        throw new Error(`transient error ${attempt}`);
      });

      queue.enqueue({ id: 'varied-failures', data: 'x', priority: 5 });

      for (let i = 0; i < 3; i++) {
        await queue.processNext().catch(() => {});
      }

      // Different errors each time → not a poison pill
      expect(queue.isQuarantined('varied-failures')).toBe(false);
    });
  });

  describe('Queue Inspection', () => {
    it('should peek at next task without dequeuing', async () => {
      const queue = stateManager.get<any>('priorityQueue');

      queue.enqueue({ id: 'first', data: 'x', priority: 10 });
      queue.enqueue({ id: 'second', data: 'x', priority: 5 });

      const peeked = queue.peek();
      expect(peeked.id).toBe('first');

      // Still in queue
      expect(queue.size).toBe(2);
    });

    it('should inspect queue contents by priority', async () => {
      const queue = stateManager.get<any>('priorityQueue');

      queue.enqueue({ id: 'a', data: 'x', priority: 1 });
      queue.enqueue({ id: 'b', data: 'x', priority: 5 });
      queue.enqueue({ id: 'c', data: 'x', priority: 10 });

      const byPriority = queue.inspectByPriority();
      expect(byPriority[10]).toContainEqual(expect.objectContaining({ id: 'c' }));
      expect(byPriority[5]).toContainEqual(expect.objectContaining({ id: 'b' }));
    });
  });

  describe('Queue Reordering', () => {
    it('should change priority of an in-queue task', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      const processed: string[] = [];
      queue.on('task:processed', (t: any) => processed.push(t.id));

      queue.enqueue({ id: 'originally-low', data: 'x', priority: 1 });
      queue.enqueue({ id: 'stays-medium', data: 'x', priority: 5 });

      // Boost priority of originally-low task
      queue.reprioritize('originally-low', 100);

      await queue.processAll();

      expect(processed[0]).toBe('originally-low');
    });

    it('should handle reprioritization of non-existent task gracefully', async () => {
      const queue = stateManager.get<any>('priorityQueue');

      expect(() => queue.reprioritize('non-existent', 100)).not.toThrow();
      // Or it should return false
      const result = queue.reprioritize('non-existent', 100);
      expect(result).toBe(false);
    });
  });

  describe('DLQ Replay', () => {
    it('should move task from DLQ back to main queue', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(1);
      queue.setHandler(async () => { throw new Error('fail'); });

      queue.enqueue({ id: 'replay-me', data: 'x', priority: 5 });
      await queue.processNext().catch(() => {});
      await queue.processNext().catch(() => {});

      // Now in DLQ
      expect(queue.getDeadLetterQueue().length).toBe(1);

      // Replay
      queue.replayFromDLQ('replay-me');

      expect(queue.getDeadLetterQueue().length).toBe(0);
      expect(queue.size).toBe(1);
    });

    it('should reset retry count when replaying from DLQ', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setMaxRetries(2);
      let callCount = 0;
      queue.setHandler(async () => {
        callCount++;
        if (callCount <= 2) throw new Error('fail');
        return 'ok';
      });

      queue.enqueue({ id: 'retry-reset', data: 'x', priority: 5 });
      // Exhaust retries
      await queue.processNext().catch(() => {});
      await queue.processNext().catch(() => {});
      await queue.processNext().catch(() => {});

      // Replay from DLQ (retry count reset)
      queue.replayFromDLQ('retry-reset');
      await queue.processNext();

      // Should succeed now (callCount > 2)
      expect(queue.getDeadLetterQueue().length).toBe(0);
    });
  });

  describe('Queue Depth Alerting', () => {
    it('should emit alert event when queue depth exceeds threshold', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setDepthAlertThreshold(10);

      for (let i = 0; i < 11; i++) {
        queue.enqueue({ id: `task-${i}`, data: 'x', priority: 1 });
      }

      expect(eventBus.emitted('queue:depthAlert')).toBe(true);
    });

    it('should emit recovery event when queue depth drops below threshold', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setDepthAlertThreshold(5);
      queue.setHandler(async () => 'done');

      // Exceed threshold
      for (let i = 0; i < 6; i++) {
        queue.enqueue({ id: `task-${i}`, data: 'x', priority: 1 });
      }

      // Process until below threshold
      await queue.processNext();
      await queue.processNext();

      expect(eventBus.emitted('queue:depthRecovered')).toBe(true);
    });

    it('should include queue depth in alert event data', async () => {
      const queue = stateManager.get<any>('priorityQueue');
      queue.setDepthAlertThreshold(5);

      for (let i = 0; i < 6; i++) {
        queue.enqueue({ id: `task-${i}`, data: 'x', priority: 1 });
      }

      const alertData = eventBus.lastEmitted<any>('queue:depthAlert');
      expect(alertData.depth).toBe(6);
      expect(alertData.threshold).toBe(5);
    });
  });
});
