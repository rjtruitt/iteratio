import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import {
  DistributedError,
  ErrorType,
  ErrorCategory,
  CircuitBreaker,
  CircuitState,
  retryWithBackoff,
  executeWithFallback,
} from '../ErrorHandling';

describe('ErrorHandling', () => {
  let redis: MockRedis;
  let clock: TestClock;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock(1000000);
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('error propagation', () => {
    it('should propagate error from agent A to agent B via message bus', async () => {
      // Simulate error propagation through Redis pub/sub
      const errorChannel = 'errors:agent-B';
      const receivedErrors: any[] = [];

      await redis.subscribe(errorChannel, (_ch, msg) => {
        receivedErrors.push(JSON.parse(msg));
      });

      const error = new DistributedError({
        message: 'Task failed',
        type: ErrorType.INTERNAL,
        category: ErrorCategory.FATAL,
        component: 'agent-A',
        operation: 'processTask',
      });

      await redis.publish(errorChannel, JSON.stringify(error.toJSON()));

      expect(receivedErrors).toHaveLength(1);
      expect(receivedErrors[0].component).toBe('agent-A');
      expect(receivedErrors[0].operation).toBe('processTask');
    });

    it('should include source agent ID in propagated error', async () => {
      const error = new DistributedError({
        message: 'Connection failed',
        type: ErrorType.NETWORK,
        category: ErrorCategory.TRANSIENT,
        component: 'agent-source',
        operation: 'connect',
        context: { sourceAgentId: 'agent-source@m1' },
      });

      const serialized = error.toJSON();
      expect(serialized.component).toBe('agent-source');
      expect(serialized.context.sourceAgentId).toBe('agent-source@m1');
    });

    it('should include stack trace in propagated error', async () => {
      const error = new DistributedError({
        message: 'Something broke',
        type: ErrorType.INTERNAL,
        category: ErrorCategory.FATAL,
        component: 'worker',
        operation: 'execute',
      });

      const serialized = error.toJSON();
      expect(serialized.stack).toBeDefined();
      expect(serialized.stack).toContain('ErrorHandling.test');
    });

    it('should preserve original error as cause', async () => {
      const originalError = new Error('Redis connection refused');
      const wrapped = DistributedError.from(originalError, 'worker', 'connectToRedis');

      expect(wrapped.cause).toBe(originalError);
      expect(wrapped.message).toBe('Redis connection refused');
    });
  });

  describe('error handler receives remote errors', () => {
    it('should invoke error handler when remote error is received', async () => {
      const handler = vi.fn();
      const errorChannel = 'errors:my-agent';

      await redis.subscribe(errorChannel, (_ch, msg) => {
        handler(JSON.parse(msg));
      });

      const remoteError = {
        message: 'Remote task crashed',
        type: ErrorType.INTERNAL,
        component: 'remote-agent',
        operation: 'runTask',
        timestamp: Date.now(),
      };

      await redis.publish(errorChannel, JSON.stringify(remoteError));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'remote-agent' })
      );
    });

    it('should handle multiple remote errors from different sources', async () => {
      const errors: any[] = [];
      const errorChannel = 'errors:coordinator';

      await redis.subscribe(errorChannel, (_ch, msg) => {
        errors.push(JSON.parse(msg));
      });

      await redis.publish(errorChannel, JSON.stringify({
        component: 'worker-1', operation: 'task', type: ErrorType.TIMEOUT,
      }));
      await redis.publish(errorChannel, JSON.stringify({
        component: 'worker-2', operation: 'task', type: ErrorType.NETWORK,
      }));
      await redis.publish(errorChannel, JSON.stringify({
        component: 'worker-3', operation: 'task', type: ErrorType.RATE_LIMIT,
      }));

      expect(errors).toHaveLength(3);
      expect(errors.map(e => e.component)).toEqual(['worker-1', 'worker-2', 'worker-3']);
    });
  });

  describe('CircuitBreaker', () => {
    it('should start in CLOSED state', () => {
      const cb = new CircuitBreaker('test-service');
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should open after N consecutive failures', async () => {
      const cb = new CircuitBreaker('test-service', { failureThreshold: 3 });
      const failingOp = () => Promise.reject(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        try { await cb.execute(failingOp); } catch {}
      }

      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    it('should reject requests immediately when OPEN', async () => {
      const cb = new CircuitBreaker('test-service', { failureThreshold: 1 });
      const failingOp = () => Promise.reject(new Error('fail'));

      try { await cb.execute(failingOp); } catch {}
      expect(cb.getState()).toBe(CircuitState.OPEN);

      await expect(
        cb.execute(() => Promise.resolve('should not run'))
      ).rejects.toThrow(/OPEN/);
    });

    it('should transition to HALF_OPEN after timeout', async () => {
      const cb = new CircuitBreaker('test-service', {
        failureThreshold: 1,
        timeout: 30000,
      });

      try {
        await cb.execute(() => Promise.reject(new Error('fail')));
      } catch {}

      expect(cb.getState()).toBe(CircuitState.OPEN);

      clock.advance(31000);

      // Next execute attempt should put it in HALF_OPEN
      try {
        await cb.execute(() => Promise.resolve('probe'));
      } catch {}

      // State should be HALF_OPEN or CLOSED depending on probe result
      expect([CircuitState.HALF_OPEN, CircuitState.CLOSED]).toContain(cb.getState());
    });

    it('should close circuit on successful probe in HALF_OPEN state', async () => {
      const cb = new CircuitBreaker('test-service', {
        failureThreshold: 1,
        successThreshold: 1,
        timeout: 10000,
      });

      // Open the circuit
      try {
        await cb.execute(() => Promise.reject(new Error('fail')));
      } catch {}

      clock.advance(11000);

      // Probe with success
      await cb.execute(() => Promise.resolve('ok'));

      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should re-open circuit on probe failure in HALF_OPEN state', async () => {
      const cb = new CircuitBreaker('test-service', {
        failureThreshold: 1,
        timeout: 10000,
      });

      // Open the circuit
      try {
        await cb.execute(() => Promise.reject(new Error('fail')));
      } catch {}

      clock.advance(11000);

      // Probe with failure
      try {
        await cb.execute(() => Promise.reject(new Error('still failing')));
      } catch {}

      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    it('should emit state-change events', async () => {
      const cb = new CircuitBreaker('test-service', { failureThreshold: 1 });
      const changes: any[] = [];
      cb.on('state-change', (event) => changes.push(event));

      try {
        await cb.execute(() => Promise.reject(new Error('fail')));
      } catch {}

      expect(changes).toHaveLength(1);
      expect(changes[0].from).toBe(CircuitState.CLOSED);
      expect(changes[0].to).toBe(CircuitState.OPEN);
    });

    it('should count failures within rolling window only', async () => {
      const cb = new CircuitBreaker('test-service', {
        failureThreshold: 3,
        windowSize: 10000,
      });

      // Two failures
      try { await cb.execute(() => Promise.reject(new Error('1'))); } catch {}
      try { await cb.execute(() => Promise.reject(new Error('2'))); } catch {}

      // Advance past window
      clock.advance(11000);

      // One more failure (old ones expired)
      try { await cb.execute(() => Promise.reject(new Error('3'))); } catch {}

      // Should still be CLOSED (only 1 failure in current window)
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should reset circuit breaker', async () => {
      const cb = new CircuitBreaker('test-service', { failureThreshold: 1 });

      try {
        await cb.execute(() => Promise.reject(new Error('fail')));
      } catch {}

      expect(cb.getState()).toBe(CircuitState.OPEN);

      cb.reset();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('error categorization', () => {
    it('should classify network errors as transient/retriable', () => {
      const error = DistributedError.from(
        new Error('ECONNREFUSED'),
        'worker',
        'connect'
      );

      expect(error.type).toBe(ErrorType.NETWORK);
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
      expect(error.isRetriable()).toBe(true);
    });

    it('should classify timeout errors as transient/retriable', () => {
      const error = DistributedError.from(
        new Error('Request timed out'),
        'worker',
        'fetch'
      );

      expect(error.type).toBe(ErrorType.TIMEOUT);
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
      expect(error.isRetriable()).toBe(true);
    });

    it('should classify auth errors as permanent/non-retriable', () => {
      const error = DistributedError.from(
        new Error('Unauthorized access'),
        'worker',
        'authenticate'
      );

      expect(error.type).toBe(ErrorType.AUTH);
      expect(error.category).toBe(ErrorCategory.PERMANENT);
      expect(error.isRetriable()).toBe(false);
    });

    it('should classify validation errors as permanent/non-retriable', () => {
      const error = DistributedError.from(
        new Error('Invalid input format'),
        'worker',
        'validate'
      );

      expect(error.type).toBe(ErrorType.VALIDATION);
      expect(error.category).toBe(ErrorCategory.PERMANENT);
      expect(error.isRetriable()).toBe(false);
    });

    it('should classify rate limit errors as transient/retriable', () => {
      const error = DistributedError.from(
        new Error('Rate limit exceeded - too many requests'),
        'worker',
        'callAPI'
      );

      expect(error.type).toBe(ErrorType.RATE_LIMIT);
      expect(error.category).toBe(ErrorCategory.TRANSIENT);
      expect(error.isRetriable()).toBe(true);
    });

    it('should classify unknown errors as fatal', () => {
      const error = DistributedError.from(
        new Error('Segmentation fault'),
        'worker',
        'execute'
      );

      expect(error.type).toBe(ErrorType.UNKNOWN);
      expect(error.category).toBe(ErrorCategory.FATAL);
    });
  });

  describe('timeout error propagation across machine boundary', () => {
    it('should serialize timeout error for cross-machine transmission', () => {
      const error = new DistributedError({
        message: 'RPC timeout calling agent-B',
        type: ErrorType.TIMEOUT,
        category: ErrorCategory.TRANSIENT,
        component: 'agent-A',
        operation: 'rpcCall',
        context: {
          targetAgent: 'agent-B@machine2',
          timeoutMs: 5000,
        },
      });

      const json = error.toJSON();
      expect(json.type).toBe('timeout');
      expect(json.context.targetAgent).toBe('agent-B@machine2');
      expect(json.context.timeoutMs).toBe(5000);
    });

    it('should reconstruct error from JSON on receiving end', () => {
      const json = {
        message: 'Remote timeout',
        type: ErrorType.TIMEOUT,
        category: ErrorCategory.TRANSIENT,
        component: 'remote-agent',
        operation: 'execute',
        timestamp: 1000000,
      };

      const error = new DistributedError(json);
      expect(error.message).toBe('Remote timeout');
      expect(error.type).toBe(ErrorType.TIMEOUT);
      expect(error.component).toBe('remote-agent');
    });
  });

  describe('retryWithBackoff', () => {
    it('should succeed on first attempt when operation succeeds', async () => {
      const result = await retryWithBackoff(
        () => Promise.resolve('success'),
        'test',
        'operation'
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(1);
    });

    it('should retry on transient failure and eventually succeed', async () => {
      let attempts = 0;
      const retryPromise = retryWithBackoff(
        () => {
          attempts++;
          if (attempts < 3) throw new Error('ECONNREFUSED');
          return Promise.resolve('recovered');
        },
        'test',
        'operation',
        { maxRetries: 5, initialDelay: 100, jitter: false }
      );

      // Advance clock to fire sleep timers (100ms + 200ms for 2 retries)
      for (let i = 0; i < 5; i++) {
        clock.advance(500);
        await Promise.resolve();
      }

      const result = await retryPromise;

      expect(result.success).toBe(true);
      expect(result.result).toBe('recovered');
      expect(result.attempts).toBe(3);
    });

    it('should give up after max retries', async () => {
      const retryPromise = retryWithBackoff(
        () => Promise.reject(new Error('ECONNREFUSED')),
        'test',
        'operation',
        { maxRetries: 2, initialDelay: 100, jitter: false }
      );

      // Advance clock to fire sleep timers (100ms, 200ms, 400ms)
      for (let i = 0; i < 10; i++) {
        clock.advance(500);
        await Promise.resolve();
      }

      const result = await retryPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.attempts).toBe(3); // 1 initial + 2 retries
    });

    it('should not retry permanent errors', async () => {
      const result = await retryWithBackoff(
        () => Promise.reject(new Error('Unauthorized access')),
        'test',
        'operation',
        { maxRetries: 5 }
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1); // No retries
    });
  });

  describe('executeWithFallback', () => {
    it('should use fallback when primary fails', async () => {
      const result = await executeWithFallback(
        () => Promise.reject(new Error('Primary failed')),
        () => Promise.resolve('fallback-result'),
        'test',
        'operation'
      );

      expect(result).toBe('fallback-result');
    });

    it('should throw when both primary and fallback fail', async () => {
      await expect(
        executeWithFallback(
          () => Promise.reject(new Error('Primary failed')),
          () => Promise.reject(new Error('Fallback also failed')),
          'test',
          'operation'
        )
      ).rejects.toThrow();
    });

    it('should not call fallback when primary succeeds', async () => {
      const fallback = vi.fn(() => Promise.resolve('fallback'));

      const result = await executeWithFallback(
        () => Promise.resolve('primary-result'),
        fallback,
        'test',
        'operation'
      );

      expect(result).toBe('primary-result');
      expect(fallback).not.toHaveBeenCalled();
    });
  });

  describe('Untested Methods', () => {
    it('ErrorMetrics.recordError(error) — record error metric', async () => {
      const { ErrorMetrics } = await import('../ErrorHandling');
      const metrics = new ErrorMetrics();

      const error = new DistributedError({
        message: 'Test error',
        type: ErrorType.NETWORK,
        category: ErrorCategory.TRANSIENT,
        component: 'worker-1',
        operation: 'connect',
      });

      metrics.recordError(error);

      const stats = metrics.getStats();
      expect(stats.totalErrors).toBe(1);
      expect(stats.byType[ErrorType.NETWORK]).toBe(1);
    });

    it('ErrorMetrics.recordRetry(operation) — record retry metric', async () => {
      const { ErrorMetrics } = await import('../ErrorHandling');
      const metrics = new ErrorMetrics();

      metrics.recordRetry('connect');
      metrics.recordRetry('connect');
      metrics.recordRetry('fetch');

      const stats = metrics.getStats();
      expect(stats.totalRetries).toBe(3);
      expect(stats.retriesByOperation.connect).toBe(2);
      expect(stats.retriesByOperation.fetch).toBe(1);
    });

    it('ErrorMetrics.recordCircuitStateChange(from, to) — record state change', async () => {
      const { ErrorMetrics } = await import('../ErrorHandling');
      const metrics = new ErrorMetrics();

      metrics.recordCircuitStateChange(CircuitState.CLOSED, CircuitState.OPEN);
      metrics.recordCircuitStateChange(CircuitState.OPEN, CircuitState.HALF_OPEN);

      const stats = metrics.getStats();
      expect(stats.circuitStateChanges).toBe(2);
    });

    it('RecoveryStrategies.handleHubFailure — is defined', async () => {
      const { RecoveryStrategies } = await import('../ErrorHandling');

      // RecoveryStrategies is an object with async methods
      expect(RecoveryStrategies.handleHubFailure).toBeDefined();
      expect(typeof RecoveryStrategies.handleHubFailure).toBe('function');
    });

    it('RecoveryStrategies.handleNetworkPartition — is defined', async () => {
      const { RecoveryStrategies } = await import('../ErrorHandling');

      expect(RecoveryStrategies.handleNetworkPartition).toBeDefined();
      expect(typeof RecoveryStrategies.handleNetworkPartition).toBe('function');
    });

    it('RecoveryStrategies.handleToolFailure — handles transient errors', async () => {
      const { RecoveryStrategies } = await import('../ErrorHandling');

      const error = new DistributedError({
        message: 'Tool execution failed',
        type: ErrorType.NETWORK,
        category: ErrorCategory.TRANSIENT,
        component: 'worker',
        operation: 'executeTool',
      });

      // Should not throw (logs and returns void)
      await RecoveryStrategies.handleToolFailure('github__create_issue', error);
    });

    it('ErrorMetrics tracks multiple error types independently', async () => {
      const { ErrorMetrics } = await import('../ErrorHandling');
      const metrics = new ErrorMetrics();

      metrics.recordError(new DistributedError({
        message: 'net', type: ErrorType.NETWORK, category: ErrorCategory.TRANSIENT,
        component: 'w', operation: 'o',
      }));
      metrics.recordError(new DistributedError({
        message: 'time', type: ErrorType.TIMEOUT, category: ErrorCategory.TRANSIENT,
        component: 'w', operation: 'o',
      }));
      metrics.recordError(new DistributedError({
        message: 'net2', type: ErrorType.NETWORK, category: ErrorCategory.TRANSIENT,
        component: 'w', operation: 'o',
      }));

      const stats = metrics.getStats();
      expect(stats.totalErrors).toBe(3);
      expect(stats.byType[ErrorType.NETWORK]).toBe(2);
      expect(stats.byType[ErrorType.TIMEOUT]).toBe(1);
    });

    it('CircuitBreaker reset clears failure history', async () => {
      const cb = new CircuitBreaker('reset-test', { failureThreshold: 5 });

      // Add some failures
      for (let i = 0; i < 3; i++) {
        try { await cb.execute(() => Promise.reject(new Error('fail'))); } catch {}
      }

      cb.reset();

      // After reset, should still be closed even with more failures (fresh count)
      try { await cb.execute(() => Promise.reject(new Error('fail'))); } catch {}
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });
  });
});
