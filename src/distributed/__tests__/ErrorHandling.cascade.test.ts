import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { TestScheduler } from '../../__test__/TestScheduler';
import {
  DistributedError,
  ErrorType,
  ErrorCategory,
  CircuitBreaker,
  CircuitState,
  retryWithBackoff,
} from '../ErrorHandling';

describe('ErrorHandling — Cascading Failure Scenarios', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock(1000000);
    clock.install();
    scheduler = new TestScheduler();
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
    scheduler.reset();
  });

  describe('cascading failure isolation', () => {
    it('should isolate error in agent A from taking down agent B', async () => {
      const cbA = new CircuitBreaker('service-A', { failureThreshold: 3 });
      const cbB = new CircuitBreaker('service-B', { failureThreshold: 3 });

      // Service A fails repeatedly
      for (let i = 0; i < 5; i++) {
        try {
          await cbA.execute(() => Promise.reject(new Error('A is down')));
        } catch {}
      }

      // Service A circuit is open
      expect(cbA.getState()).toBe(CircuitState.OPEN);

      // Service B should still be operational
      expect(cbB.getState()).toBe(CircuitState.CLOSED);
      const resultB = await cbB.execute(() => Promise.resolve('B works'));
      expect(resultB).toBe('B works');
    });

    it('should prevent error propagation from overwhelming downstream services', async () => {
      const cbDownstream = new CircuitBreaker('downstream', { failureThreshold: 5 });
      let downstreamCalls = 0;

      // Upstream sends many requests due to its own retry logic
      for (let i = 0; i < 20; i++) {
        try {
          await cbDownstream.execute(() => {
            downstreamCalls++;
            return Promise.reject(new Error('Downstream overwhelmed'));
          });
        } catch {}
      }

      // Circuit breaker should have limited actual calls to downstream
      // After 5 failures, circuit opens and rejects immediately
      expect(downstreamCalls).toBeLessThanOrEqual(5);
      expect(cbDownstream.getState()).toBe(CircuitState.OPEN);
    });

    it('should allow independent failure domains to fail independently', async () => {
      const domains = {
        payments: new CircuitBreaker('payments', { failureThreshold: 2 }),
        notifications: new CircuitBreaker('notifications', { failureThreshold: 2 }),
        analytics: new CircuitBreaker('analytics', { failureThreshold: 2 }),
      };

      // Analytics fails
      try { await domains.analytics.execute(() => Promise.reject(new Error('fail'))); } catch {}
      try { await domains.analytics.execute(() => Promise.reject(new Error('fail'))); } catch {}

      expect(domains.analytics.getState()).toBe(CircuitState.OPEN);
      expect(domains.payments.getState()).toBe(CircuitState.CLOSED);
      expect(domains.notifications.getState()).toBe(CircuitState.CLOSED);

      // Payments and notifications still work
      const payResult = await domains.payments.execute(() => Promise.resolve('paid'));
      expect(payResult).toBe('paid');
    });
  });

  describe('bulkhead pattern', () => {
    it('should limit concurrent operations to prevent resource exhaustion', async () => {
      const maxConcurrent = 3;
      let activeCount = 0;
      let maxActive = 0;

      const bulkheadedOp = async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);

        if (activeCount > maxConcurrent) {
          activeCount--;
          throw new DistributedError({
            message: 'Bulkhead limit reached',
            type: ErrorType.UNAVAILABLE,
            category: ErrorCategory.TRANSIENT,
            component: 'bulkhead',
            operation: 'execute',
          });
        }

        // Simulate work
        await new Promise(resolve => setTimeout(resolve, 100));
        activeCount--;
        return 'done';
      };

      // Launch many concurrent operations
      const ops = Array.from({ length: 10 }, () =>
        bulkheadedOp().catch(() => 'rejected')
      );

      // Advance clock to let the setTimeout(resolve, 100) fire
      clock.advance(200);
      for (let i = 0; i < 20; i++) await Promise.resolve();

      const results = await Promise.all(ops);

      // Max concurrent should be limited
      expect(maxActive).toBeLessThanOrEqual(maxConcurrent + 1); // +1 for check timing
      // Some should succeed, some should be rejected
      expect(results.filter(r => r === 'done').length).toBeGreaterThan(0);
      expect(results.filter(r => r === 'rejected').length).toBeGreaterThan(0);
    });

    it('should isolate failure in one bulkhead from affecting another', async () => {
      let domainAActive = 0;
      let domainBActive = 0;

      const opA = async () => {
        domainAActive++;
        throw new Error('Domain A is failing');
      };

      const opB = async () => {
        domainBActive++;
        return 'B succeeded';
      };

      // Domain A fails
      try { await opA(); } catch {}
      try { await opA(); } catch {}
      try { await opA(); } catch {}

      // Domain B should still work perfectly
      const result = await opB();
      expect(result).toBe('B succeeded');
      expect(domainBActive).toBe(1);
    });
  });

  describe('error propagation chain (A -> B -> C)', () => {
    it('should propagate error from C through B to A', async () => {
      const errorLog: Array<{ from: string; to: string; error: string }> = [];

      // Simulate service call chain: A calls B calls C
      const callC = async () => {
        throw new DistributedError({
          message: 'C crashed',
          type: ErrorType.INTERNAL,
          category: ErrorCategory.FATAL,
          component: 'service-C',
          operation: 'process',
        });
      };

      const callB = async () => {
        try {
          await callC();
        } catch (e: any) {
          errorLog.push({ from: 'C', to: 'B', error: e.message });
          throw new DistributedError({
            message: `B failed because: ${e.message}`,
            type: ErrorType.UNAVAILABLE,
            category: ErrorCategory.TRANSIENT,
            component: 'service-B',
            operation: 'delegate',
            cause: e,
          });
        }
      };

      const callA = async () => {
        try {
          await callB();
        } catch (e: any) {
          errorLog.push({ from: 'B', to: 'A', error: e.message });
          throw e;
        }
      };

      await expect(callA()).rejects.toThrow(/B failed because: C crashed/);

      expect(errorLog).toHaveLength(2);
      expect(errorLog[0]).toEqual({ from: 'C', to: 'B', error: 'C crashed' });
      expect(errorLog[1]).toEqual({
        from: 'B',
        to: 'A',
        error: 'B failed because: C crashed',
      });
    });

    it('should preserve original cause through the chain', async () => {
      const rootCause = new Error('Disk full');

      const errorC = new DistributedError({
        message: 'Write failed',
        type: ErrorType.INTERNAL,
        category: ErrorCategory.FATAL,
        component: 'service-C',
        operation: 'writeToDisk',
        cause: rootCause,
      });

      const errorB = new DistributedError({
        message: 'Storage operation failed',
        type: ErrorType.UNAVAILABLE,
        category: ErrorCategory.TRANSIENT,
        component: 'service-B',
        operation: 'storeData',
        cause: errorC,
      });

      // Walk up the cause chain
      expect(errorB.cause).toBe(errorC);
      expect((errorB.cause as DistributedError).cause).toBe(rootCause);
    });
  });

  describe('recovery propagation', () => {
    it('should detect recovery and propagate recovery notification', async () => {
      const cb = new CircuitBreaker('recovering-service', {
        failureThreshold: 2,
        successThreshold: 2,
        timeout: 10000,
      });

      const stateChanges: any[] = [];
      cb.on('state-change', (event) => stateChanges.push(event));

      // Fail to open circuit
      try { await cb.execute(() => Promise.reject(new Error('fail'))); } catch {}
      try { await cb.execute(() => Promise.reject(new Error('fail'))); } catch {}

      expect(cb.getState()).toBe(CircuitState.OPEN);

      // Wait for half-open
      clock.advance(11000);

      // Successful probes
      await cb.execute(() => Promise.resolve('ok'));
      await cb.execute(() => Promise.resolve('ok'));

      expect(cb.getState()).toBe(CircuitState.CLOSED);

      // Verify state change events trace the recovery
      const transitions = stateChanges.map(e => `${e.from}->${e.to}`);
      expect(transitions).toContain(`${CircuitState.CLOSED}->${CircuitState.OPEN}`);
      expect(transitions).toContain(`${CircuitState.OPEN}->${CircuitState.HALF_OPEN}`);
      expect(transitions).toContain(`${CircuitState.HALF_OPEN}->${CircuitState.CLOSED}`);
    });

    it('should notify upstream when downstream recovers', async () => {
      const notifications: string[] = [];

      const cb = new CircuitBreaker('downstream', {
        failureThreshold: 1,
        successThreshold: 1,
        timeout: 5000,
      });

      cb.on('state-change', (event) => {
        if (event.to === CircuitState.CLOSED && event.from === CircuitState.HALF_OPEN) {
          notifications.push('downstream-recovered');
        }
      });

      // Trip the circuit
      try { await cb.execute(() => Promise.reject(new Error('down'))); } catch {}

      clock.advance(6000);

      // Recovery probe succeeds
      await cb.execute(() => Promise.resolve('back up'));

      expect(notifications).toContain('downstream-recovered');
    });
  });

  describe('multiple simultaneous errors', () => {
    it('should handle errors from different sources concurrently', async () => {
      const errorChannel = 'errors:coordinator';
      const receivedErrors: any[] = [];

      await redis.subscribe(errorChannel, (_ch, msg) => {
        receivedErrors.push(JSON.parse(msg));
      });

      // Simulate multiple agents failing simultaneously
      const errors = [
        { component: 'worker-1', message: 'OOM', type: ErrorType.INTERNAL },
        { component: 'worker-2', message: 'Timeout', type: ErrorType.TIMEOUT },
        { component: 'worker-3', message: 'Network', type: ErrorType.NETWORK },
        { component: 'worker-4', message: 'Rate limit', type: ErrorType.RATE_LIMIT },
        { component: 'worker-5', message: 'Unavailable', type: ErrorType.UNAVAILABLE },
      ];

      await Promise.all(
        errors.map(e => redis.publish(errorChannel, JSON.stringify(e)))
      );

      expect(receivedErrors).toHaveLength(5);
      expect(new Set(receivedErrors.map(e => e.component)).size).toBe(5);
    });

    it('should not let one error handler crash affect others', async () => {
      const results: string[] = [];

      // Three error handlers — second one throws
      const handlers = [
        (err: any) => { results.push(`handler1:${err.component}`); },
        (_err: any) => { throw new Error('Handler 2 crashed'); },
        (err: any) => { results.push(`handler3:${err.component}`); },
      ];

      const errorChannel = 'errors:safe-coordinator';

      await redis.subscribe(errorChannel, (_ch, msg) => {
        const parsed = JSON.parse(msg);
        for (const handler of handlers) {
          try {
            handler(parsed);
          } catch {
            // Isolated failure
          }
        }
      });

      await redis.publish(errorChannel, JSON.stringify({ component: 'worker-1' }));

      // Handler 1 and 3 should still work despite handler 2 crashing
      expect(results).toContain('handler1:worker-1');
      expect(results).toContain('handler3:worker-1');
    });

    it('should categorize simultaneous errors correctly', () => {
      const errors = [
        DistributedError.from(new Error('ECONNREFUSED'), 'w1', 'op'),
        DistributedError.from(new Error('Request timed out'), 'w2', 'op'),
        DistributedError.from(new Error('Unauthorized'), 'w3', 'op'),
        DistributedError.from(new Error('Rate limit exceeded'), 'w4', 'op'),
        DistributedError.from(new Error('Segfault'), 'w5', 'op'),
      ];

      const retriable = errors.filter(e => e.isRetriable());
      const nonRetriable = errors.filter(e => !e.isRetriable());

      // ECONNREFUSED, timeout, rate limit are retriable
      expect(retriable).toHaveLength(3);
      // Unauthorized, Segfault (unknown) are not retriable
      expect(nonRetriable).toHaveLength(2);
    });
  });

  describe('circuit breaker with retry integration', () => {
    it('should retry within circuit breaker limits', async () => {
      const cb = new CircuitBreaker('flaky-service', { failureThreshold: 5 });
      let attempts = 0;

      const retryPromise = retryWithBackoff(
        () => cb.execute(async () => {
          attempts++;
          if (attempts < 3) throw new Error('ECONNREFUSED');
          return 'success';
        }),
        'test',
        'flaky-call',
        { maxRetries: 4, initialDelay: 100, jitter: false }
      );

      // Advance clock to fire retry sleep timers
      for (let i = 0; i < 10; i++) {
        clock.advance(500);
        await Promise.resolve();
      }

      const result = await retryPromise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      // Circuit should still be closed (fewer than 5 failures)
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should stop retrying when circuit opens', async () => {
      const cb = new CircuitBreaker('broken-service', { failureThreshold: 2 });
      let attempts = 0;

      const retryPromise = retryWithBackoff(
        () => cb.execute(async () => {
          attempts++;
          throw new Error('ECONNREFUSED');
        }),
        'test',
        'broken-call',
        { maxRetries: 10, initialDelay: 100, jitter: false }
      );

      // Advance clock to fire retry sleep timers
      for (let i = 0; i < 15; i++) {
        clock.advance(500);
        await Promise.resolve();
      }

      const result = await retryPromise;

      // Should stop before max retries because circuit opens
      expect(result.success).toBe(false);
      expect(attempts).toBeLessThanOrEqual(3); // 2 real + maybe 1 rejected
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });
  });
});
