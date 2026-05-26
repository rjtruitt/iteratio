import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockToolExecutor,
  MockRedis,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 25: Error Propagation Across System Boundaries ---
// Tests error handling in tools, LLM, transport, cascading failures,
// cross-machine errors, error categorization, circuit breaker, and recovery.

describe('E2E Scenario 25: Error Propagation', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let transport: MockTransport;
  let llm: MockLLMProvider;
  let toolExecutor: MockToolExecutor;
  let redis: MockRedis;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    transport = ctx.transport;
    llm = ctx.llm;
    toolExecutor = ctx.toolExecutor;
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

  describe('Tool Error Handling', () => {
    it('should catch tool error in step and report in turn result', async () => {
      const agent = stateManager.get<any>('agentLoop');
      toolExecutor.setResult('file-read', { success: false, error: 'ENOENT: file not found' });

      agent.setToolExecutor(toolExecutor);
      agent.start();

      const result = await agent.runTurn('read the file');

      expect(result.toolErrors).toBeDefined();
      expect(result.toolErrors[0].toolName).toBe('file-read');
      expect(result.toolErrors[0].error).toContain('ENOENT');
    });

    it('should include tool error in context for subsequent steps', async () => {
      const agent = stateManager.get<any>('agentLoop');
      let contextAfterError: any;

      toolExecutor.setResult('failing-tool', { success: false, error: 'tool broke' });

      const captureStep = { name: 'capture', execute: async (ctx: any) => { contextAfterError = ctx; return ctx; } };
      agent.addStep(captureStep);
      agent.setToolExecutor(toolExecutor);
      agent.start();

      await agent.runTurn('use failing-tool');

      expect(contextAfterError.errors).toBeDefined();
      expect(contextAfterError.errors.some((e: any) => e.source === 'tool')).toBe(true);
    });

    it('should not abort the turn when a non-critical tool fails', async () => {
      const agent = stateManager.get<any>('agentLoop');
      toolExecutor.setResult('optional-tool', { success: false, error: 'timeout' });

      agent.setToolExecutor(toolExecutor);
      agent.start();

      // Turn should complete (not throw)
      const result = await agent.runTurn('use optional-tool');
      expect(result).toBeDefined();
      expect(result.completed).toBe(true);
    });
  });

  describe('LLM Error Handling', () => {
    it('should retry LLM call with backoff on transient error', async () => {
      const llmWithRetry = new MockLLMProvider({
        throwOnCall: 0,
        throwError: new Error('Service temporarily unavailable'),
        responses: [
          undefined as any, // first call throws
          MockLLMProvider.simpleResponse('success after retry'),
        ],
      });

      const agent = stateManager.get<any>('agentLoop');
      agent.setLLMProvider(llmWithRetry);
      agent.setRetryPolicy({ maxRetries: 3, backoffMs: [100, 200, 400] });
      agent.start();

      const result = await agent.runTurn('hello');

      expect(llmWithRetry.callCount).toBe(2); // 1 failed + 1 success
      expect(result.content).toContain('success after retry');
    });

    it('should surface error if all LLM retries fail', async () => {
      const alwaysFails = new MockLLMProvider({
        throwOnCall: 0,
        throwError: new Error('Model overloaded'),
      });
      // Override to always throw
      alwaysFails.invoke = async () => { throw new Error('Model overloaded'); };

      const agent = stateManager.get<any>('agentLoop');
      agent.setLLMProvider(alwaysFails);
      agent.setRetryPolicy({ maxRetries: 3, backoffMs: [100, 200, 400] });
      agent.start();

      const result = await agent.runTurn('hello');

      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Model overloaded');
      expect(result.error.retriesExhausted).toBe(true);
    });

    it('should emit llm:error event with retry info', async () => {
      const failingLLM = new MockLLMProvider();
      failingLLM.invoke = async () => { throw new Error('API error'); };

      const agent = stateManager.get<any>('agentLoop');
      agent.setLLMProvider(failingLLM);
      agent.setRetryPolicy({ maxRetries: 2, backoffMs: [100, 200] });
      agent.start();

      await agent.runTurn('hello');

      expect(eventBus.emitted('llm:error')).toBe(true);
      const errorEvent = eventBus.lastEmitted<any>('llm:error');
      expect(errorEvent.attempt).toBeDefined();
    });
  });

  describe('Transport Error Handling', () => {
    it('should buffer messages when transport errors occur', async () => {
      const manager = stateManager.get<any>('transportManager');
      manager.setPrimary(transport);

      await transport.connect({ backend: 'memory' });
      await transport.disconnect(); // simulate failure

      // Should buffer instead of throwing
      await manager.publish('topic', { data: 'buffered' });

      expect(manager.bufferedCount).toBe(1);
    });

    it('should retry delivery on transport reconnect', async () => {
      const manager = stateManager.get<any>('transportManager');
      manager.setPrimary(transport);

      await transport.connect({ backend: 'memory' });
      await transport.disconnect();

      await manager.publish('topic', { data: 'retry-me' });

      // Reconnect
      await transport.connect({ backend: 'memory' });
      await manager.flush();

      expect(transport.publishedMessages).toHaveLength(1);
      expect(transport.publishedMessages[0].message).toEqual({ data: 'retry-me' });
    });

    it('should emit transport:error event with context', async () => {
      const manager = stateManager.get<any>('transportManager');
      manager.setPrimary(transport);

      await transport.connect({ backend: 'memory' });
      await transport.disconnect();

      await manager.publish('topic', { data: 1 });

      expect(eventBus.emitted('transport:error')).toBe(true);
    });
  });

  describe('Cascading Failure', () => {
    it('should handle Redis down causing distributed lock failure', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.setDistributedLock(redis);
      agent.start();

      // Redis goes down
      redis.disconnect();

      // Agent should fallback to local processing
      const result = await agent.runTurn('process with lock');

      expect(result.fallback).toBe(true);
      expect(result.lockAcquired).toBe(false);
      expect(eventBus.emitted('lock:fallbackToLocal')).toBe(true);
    });

    it('should propagate cascading error with full context chain', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.setDistributedLock(redis);
      agent.start();

      redis.disconnect();

      const result = await agent.runTurn('cascading failure test');

      expect(result.errorChain).toBeDefined();
      expect(result.errorChain[0].layer).toBe('redis');
      expect(result.errorChain[1].layer).toBe('distributed-lock');
      expect(result.errorChain[2].layer).toBe('agent');
    });

    it('should not crash agent when downstream dependency fails', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.setDistributedLock(redis);
      agent.start();

      redis.disconnect();

      // Should not throw
      const result = await agent.runTurn('keep going');
      expect(result).toBeDefined();
      expect(agent.isRunning()).toBe(true);
    });
  });

  describe('Cross-Machine Error', () => {
    it('should notify local agent when remote agent fails', async () => {
      const localAgent = stateManager.get<any>('agentLoop');
      localAgent.start();

      // Simulate remote agent failure notification via transport
      await transport.connect({ backend: 'memory' });
      await transport.publish('agent:error', {
        sourceAgent: 'remote-agent-1',
        error: 'out of memory',
        timestamp: Date.now(),
      });

      expect(eventBus.emitted('remoteAgent:error')).toBe(true);
    });

    it('should include remote agent ID and error type in notification', async () => {
      const localAgent = stateManager.get<any>('agentLoop');
      localAgent.start();

      await transport.connect({ backend: 'memory' });
      await transport.publish('agent:error', {
        sourceAgent: 'remote-agent-2',
        error: 'LLM timeout',
        errorType: 'retryable',
      });

      const notification = eventBus.lastEmitted<any>('remoteAgent:error');
      expect(notification.sourceAgent).toBe('remote-agent-2');
      expect(notification.errorType).toBe('retryable');
    });
  });

  describe('Error Categorization', () => {
    it('should categorize errors as retryable vs fatal', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      const retryableError = new Error('Service unavailable');
      (retryableError as any).statusCode = 503;

      const fatalError = new Error('Invalid API key');
      (fatalError as any).statusCode = 401;

      expect(agent.categorizeError(retryableError)).toBe('retryable');
      expect(agent.categorizeError(fatalError)).toBe('fatal');
    });

    it('should not retry fatal errors', async () => {
      const fatalLLM = new MockLLMProvider();
      fatalLLM.invoke = async () => {
        const err = new Error('Invalid API key') as any;
        err.statusCode = 401;
        err.category = 'fatal';
        throw err;
      };

      const agent = stateManager.get<any>('agentLoop');
      agent.setLLMProvider(fatalLLM);
      agent.setRetryPolicy({ maxRetries: 3, backoffMs: [100, 200, 400] });
      agent.start();

      const result = await agent.runTurn('hello');

      // Should NOT retry (only 1 attempt)
      expect(fatalLLM.callCount).toBe(1);
      expect(result.error.category).toBe('fatal');
    });

    it('should timeout handling: categorize timeout as retryable', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      const timeoutError = new Error('Request timed out');
      (timeoutError as any).code = 'ETIMEDOUT';

      expect(agent.categorizeError(timeoutError)).toBe('retryable');
    });
  });

  describe('Circuit Breaker', () => {
    it('should trip circuit breaker after repeated failures', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const circuitBreaker = agent.getCircuitBreaker('llm');
      circuitBreaker.configure({ failureThreshold: 3, resetTimeoutMs: 5000 });

      // 3 failures
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      expect(circuitBreaker.state).toBe('open');
    });

    it('should reject requests immediately when circuit is open', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const circuitBreaker = agent.getCircuitBreaker('llm');
      circuitBreaker.configure({ failureThreshold: 2, resetTimeoutMs: 5000 });

      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      const result = circuitBreaker.allowRequest();
      expect(result).toBe(false);
    });

    it('should transition to half-open after reset timeout', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const circuitBreaker = agent.getCircuitBreaker('llm');
      circuitBreaker.configure({ failureThreshold: 2, resetTimeoutMs: 5000 });

      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.state).toBe('open');

      clock.advance(5000);

      expect(circuitBreaker.state).toBe('half-open');
    });

    it('should close circuit after successful request in half-open state', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const circuitBreaker = agent.getCircuitBreaker('llm');
      circuitBreaker.configure({ failureThreshold: 2, resetTimeoutMs: 5000 });

      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      clock.advance(5000);

      // Half-open: allow one request
      circuitBreaker.recordSuccess();

      expect(circuitBreaker.state).toBe('closed');
    });

    it('should emit circuit breaker state change events', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const circuitBreaker = agent.getCircuitBreaker('llm');
      circuitBreaker.configure({ failureThreshold: 2, resetTimeoutMs: 5000 });

      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      expect(eventBus.emitted('circuitBreaker:opened')).toBe(true);
    });
  });

  describe('Error Recovery Notification', () => {
    it('should emit recovery event when service is restored', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const circuitBreaker = agent.getCircuitBreaker('llm');
      circuitBreaker.configure({ failureThreshold: 2, resetTimeoutMs: 5000 });

      // Trip breaker
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // Wait and recover
      clock.advance(5000);
      circuitBreaker.recordSuccess();

      expect(eventBus.emitted('service:recovered')).toBe(true);
    });

    it('should include downtime duration in recovery event', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const circuitBreaker = agent.getCircuitBreaker('llm');
      circuitBreaker.configure({ failureThreshold: 2, resetTimeoutMs: 5000 });

      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      clock.advance(7000);
      circuitBreaker.recordSuccess();

      const recovery = eventBus.lastEmitted<any>('service:recovered');
      expect(recovery.downtimeMs).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('Structured Error Context', () => {
    it('should include traceId, agentId, operation, and timestamps in errors', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.setAgentId('agent-xyz');
      agent.start();

      const failingLLM = new MockLLMProvider();
      failingLLM.invoke = async () => { throw new Error('fail'); };
      agent.setLLMProvider(failingLLM);

      const result = await agent.runTurn('test');

      expect(result.error.context.traceId).toBeDefined();
      expect(result.error.context.agentId).toBe('agent-xyz');
      expect(result.error.context.operation).toBeDefined();
      expect(result.error.context.timestamp).toBeDefined();
    });

    it('should correlate errors with parent trace across agent boundaries', async () => {
      const parentTraceId = 'trace-parent-123';
      const agent = stateManager.get<any>('agentLoop');
      agent.setTraceContext({ traceId: parentTraceId });
      agent.start();

      const failingLLM = new MockLLMProvider();
      failingLLM.invoke = async () => { throw new Error('fail'); };
      agent.setLLMProvider(failingLLM);

      const result = await agent.runTurn('test');

      expect(result.error.context.traceId).toBe(parentTraceId);
    });
  });

  describe('Edge Cases', () => {
    it('should handle error with no message (empty Error)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const emptyErrorLLM = new MockLLMProvider();
      emptyErrorLLM.invoke = async () => { throw new Error(''); };
      agent.setLLMProvider(emptyErrorLLM);
      agent.start();

      const result = await agent.runTurn('trigger empty error');

      expect(result.error).toBeDefined();
      expect(result.error.message).toBe('');
      // Should still have structured context even without message
      expect(result.error.context).toBeDefined();
    });

    it('should handle error with extremely long message (100KB)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const longMessage = 'x'.repeat(100 * 1024); // 100KB error message
      const longErrorLLM = new MockLLMProvider();
      longErrorLLM.invoke = async () => { throw new Error(longMessage); };
      agent.setLLMProvider(longErrorLLM);
      agent.start();

      const result = await agent.runTurn('trigger long error');

      expect(result.error).toBeDefined();
      // Should handle without crashing or OOM
      expect(result.error.message.length).toBeGreaterThan(0);
    });

    it('should handle error with non-serializable properties (functions, symbols)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const weirdErrorLLM = new MockLLMProvider();
      weirdErrorLLM.invoke = async () => {
        const err = new Error('weird error') as any;
        err.fn = () => 'cannot serialize this';
        err.sym = Symbol('secret');
        err.circular = err; // Circular reference
        throw err;
      };
      agent.setLLMProvider(weirdErrorLLM);
      agent.start();

      const result = await agent.runTurn('trigger weird error');

      // Should serialize error without crashing (strip non-serializable parts)
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('weird error');
    });

    it('should handle error chain 10 levels deep (A->B->C->D->...->J)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const deepErrorLLM = new MockLLMProvider();
      deepErrorLLM.invoke = async () => {
        let err: any = new Error('Level J (root cause)');
        for (const level of ['I', 'H', 'G', 'F', 'E', 'D', 'C', 'B', 'A']) {
          const wrapper = new Error(`Level ${level}`);
          (wrapper as any).cause = err;
          err = wrapper;
        }
        throw err;
      };
      agent.setLLMProvider(deepErrorLLM);
      agent.start();

      const result = await agent.runTurn('trigger deep error');

      expect(result.error).toBeDefined();
      expect(result.errorChain.length).toBeGreaterThanOrEqual(10);
      expect(result.errorChain[result.errorChain.length - 1].message).toContain('root cause');
    });

    it('should handle error during error handler (meta-error)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      const failingLLM = new MockLLMProvider();
      failingLLM.invoke = async () => { throw new Error('original error'); };
      agent.setLLMProvider(failingLLM);

      // Error handler itself throws
      agent.setErrorHandler(async () => {
        throw new Error('error handler also failed');
      });
      agent.start();

      const result = await agent.runTurn('double fault');

      // Should not infinite loop; should surface both errors
      expect(result.error).toBeDefined();
      expect(result.metaError).toBeDefined();
      expect(result.metaError.message).toContain('error handler also failed');
    });

    it('should handle async rejection with non-Error value (string, number, null)', async () => {
      const agent = stateManager.get<any>('agentLoop');

      // Rejection with a string
      const stringRejectLLM = new MockLLMProvider();
      stringRejectLLM.invoke = async () => { throw 'just a string'; };
      agent.setLLMProvider(stringRejectLLM);
      agent.start();

      const result1 = await agent.runTurn('string rejection');
      expect(result1.error).toBeDefined();

      // Rejection with null
      const nullRejectLLM = new MockLLMProvider();
      nullRejectLLM.invoke = async () => { throw null; };
      agent.setLLMProvider(nullRejectLLM);

      const result2 = await agent.runTurn('null rejection');
      expect(result2.error).toBeDefined();

      // Rejection with a number
      const numRejectLLM = new MockLLMProvider();
      numRejectLLM.invoke = async () => { throw 42; };
      agent.setLLMProvider(numRejectLLM);

      const result3 = await agent.runTurn('number rejection');
      expect(result3.error).toBeDefined();
    });

    it('should handle error boundary receiving error from already-dead child', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      // Simulate child agent dying, then its error arriving after parent moved on
      const childError = {
        sourceAgent: 'dead-child',
        error: new Error('child crashed'),
        timestamp: Date.now() - 10000, // Error from 10s ago
      };

      await transport.connect({ backend: 'memory' });
      await transport.publish('agent:error', childError);

      // Parent should handle stale error gracefully
      const errors = eventBus.allEmitted('remoteAgent:error');
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle timeout error vs cancellation error (different recovery paths)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.start();

      // Timeout error
      const timeoutErr = new Error('Request timed out') as any;
      timeoutErr.code = 'ETIMEDOUT';

      // Cancellation error
      const cancelErr = new Error('Operation cancelled') as any;
      cancelErr.code = 'ECANCELLED';

      const timeoutCategory = agent.categorizeError(timeoutErr);
      const cancelCategory = agent.categorizeError(cancelErr);

      // Should have different categories leading to different recovery strategies
      expect(timeoutCategory).toBe('retryable');
      expect(cancelCategory).toBe('cancelled');
      expect(timeoutCategory).not.toBe(cancelCategory);
    });
  });
});
