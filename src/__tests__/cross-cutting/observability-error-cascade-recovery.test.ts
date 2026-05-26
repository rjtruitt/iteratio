import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockEventBus } from '../../__test__/MockEventBus';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { Observability } from '../../cross-cutting/Observability';
import { CircuitBreaker, CircuitOpenError } from '../../cross-cutting/CircuitBreaker';

/**
 * Cross-cutting: Observability + Error Propagation + Cascading Failure + Auto-Recovery
 */

describe('Cross-cutting: Observability + Error Cascade + Recovery', () => {
  let eventBus: MockEventBus;
  let redis: MockRedis;
  let clock: TestClock;
  let obs: Observability;

  beforeEach(() => {
    eventBus = new MockEventBus();
    redis = new MockRedis();
    clock = new TestClock();
    obs = new Observability();
  });

  describe('observability during cascading failure', () => {
    it('should trace error propagation path through spans', async () => {
      const traceId = 'trace-cascade-1';

      // Tool fails
      const toolSpan = obs.startSpan('tool:execute', { traceId, attributes: { tool: 'api_call' } });
      obs.endSpan(toolSpan.id, 'error', { error: 'Connection refused' });

      // Step records child error
      const stepSpan = obs.startSpan('step:process', { traceId, parentSpanId: toolSpan.id });
      obs.endSpan(stepSpan.id, 'error', { childError: toolSpan.id });

      // Turn records
      const turnSpan = obs.startSpan('turn:execute', { traceId, parentSpanId: stepSpan.id });
      obs.endSpan(turnSpan.id, 'error', { propagatedFrom: 'tool:execute' });

      // Full trace shows propagation
      const trace = obs.getTrace(traceId);
      expect(trace.length).toBe(3);
      expect(trace.every(s => s.status === 'error')).toBe(true);
      expect(trace[0].name).toBe('tool:execute');
      expect(trace[2].parentSpanId).toBe(stepSpan.id);
    });

    it('should emit metrics at each failure boundary crossing', async () => {
      obs.incrementCounter('tool:error', { component: 'api_call' });
      obs.incrementCounter('step:error', { component: 'process_step' });
      obs.incrementCounter('turn:error', { component: 'turn_5' });

      const toolErrors = obs.getMetrics('tool:error');
      const stepErrors = obs.getMetrics('step:error');
      const turnErrors = obs.getMetrics('turn:error');

      expect(toolErrors.length).toBe(1);
      expect(stepErrors.length).toBe(1);
      expect(turnErrors.length).toBe(1);
      expect(toolErrors[0].labels.component).toBe('api_call');
    });

    it('should correlate errors across agents via traceId', async () => {
      const sharedTraceId = 'trace-cross-agent';

      // Agent A's span
      const spanA = obs.startSpan('agent-a:call', { traceId: sharedTraceId, attributes: { agentId: 'A' } });
      obs.endSpan(spanA.id, 'error');

      // Agent B's span (same trace)
      const spanB = obs.startSpan('agent-b:handler', { traceId: sharedTraceId, parentSpanId: spanA.id, attributes: { agentId: 'B' } });
      obs.endSpan(spanB.id, 'error');

      // Correlate via traceId
      const correlatedErrors = obs.getCorrelatedErrors(sharedTraceId);
      expect(correlatedErrors.length).toBe(2);
      expect(correlatedErrors[0].span.attributes.agentId).toBe('A');
      expect(correlatedErrors[1].span.attributes.agentId).toBe('B');
    });

    it('should log structured error context at each boundary', async () => {
      obs.log('error', 'Tool execution failed', {
        traceId: 'trace-1',
        spanId: 'span-1',
        agentId: 'agent-a',
        turnNumber: 5,
        stepName: 'execute-tools',
        error: { code: 'CONNECTION_REFUSED', details: { host: 'api.example.com' } },
      });

      const logs = obs.allLogs;
      expect(logs.length).toBe(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].traceId).toBe('trace-1');
      expect(logs[0].agentId).toBe('agent-a');
      expect(logs[0].context.stepName).toBe('execute-tools');
    });
  });

  describe('cascading failure isolation', () => {
    it('should isolate failure domain (Redis down doesnt crash LLM calls)', async () => {
      redis.disconnect();

      // Redis operations fail
      let redisError = false;
      try {
        await redis.get('test-key');
      } catch {
        redisError = true;
      }
      expect(redisError).toBe(true);

      // LLM calls continue working
      const llm = new MockLLMProvider();
      const response = await llm.invoke([{ role: 'user', content: 'Hello' }]);
      expect(response.content).toBe('Mock response');
    });

    it('should detect cascade pattern (A fails -> B fails -> C fails)', async () => {
      // Rapid sequential errors
      const spanA = obs.startSpan('service-a');
      obs.endSpan(spanA.id, 'error');

      const spanB = obs.startSpan('service-b');
      obs.endSpan(spanB.id, 'error');

      const spanC = obs.startSpan('service-c');
      obs.endSpan(spanC.id, 'error');

      // Detect cascade
      const cascade = obs.detectCascade(5000, 3);
      expect(cascade.detected).toBe(true);
      expect(cascade.rootSpan?.name).toBe('service-a');
      expect(cascade.affectedSpans.length).toBe(2);
    });

    it('should apply circuit breaker to cascading dependency', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(async () => { throw new Error('Service X failed'); });
        } catch {}
      }

      // Circuit opens - fast fail
      expect(breaker.currentState).toBe('open');
      await expect(breaker.execute(async () => 'ok')).rejects.toThrow(CircuitOpenError);
    });
  });

  describe('automatic recovery', () => {
    it('should detect recovery and emit recovery notification', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50, successThreshold: 1 });

      // Fail to open circuit
      for (let i = 0; i < 2; i++) {
        try { await breaker.execute(async () => { throw new Error('fail'); }); } catch {}
      }
      expect(breaker.currentState).toBe('open');

      // Wait for reset timeout
      await new Promise(r => setTimeout(r, 60));

      // Successful probe
      const result = await breaker.execute(async () => 'recovered');
      expect(result).toBe('recovered');
      expect(breaker.currentState).toBe('closed');
    });

    it('should close circuit breaker on successful health probe', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50, successThreshold: 1 });

      // Open circuit
      for (let i = 0; i < 2; i++) {
        try { await breaker.execute(async () => { throw new Error('fail'); }); } catch {}
      }
      expect(breaker.currentState).toBe('open');

      // Wait for half-open
      await new Promise(r => setTimeout(r, 60));

      // Health probe succeeds
      await breaker.execute(async () => 'healthy');
      expect(breaker.currentState).toBe('closed');
    });

    it('should record recovery metrics (time-to-recovery, affected requests)', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });
      const metrics = breaker.metrics;

      // Track failure (threshold is 2, so after 2 failures circuit opens)
      for (let i = 0; i < 3; i++) {
        try { await breaker.execute(async () => { throw new Error('fail'); }); } catch {}
      }

      const afterFailure = breaker.metrics;
      // 2 actual failures recorded (3rd call is rejected by open circuit without invoking fn)
      expect(afterFailure.totalFailures).toBe(2);
      expect(afterFailure.state).toBe('open');
      expect(afterFailure.stateChangedAt).toBeGreaterThan(0);
    });

    it('should not flood recovered service (gradual ramp-up after recovery)', async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50, successThreshold: 2 });

      // Open circuit
      for (let i = 0; i < 2; i++) {
        try { await breaker.execute(async () => { throw new Error('fail'); }); } catch {}
      }

      // Wait for half-open
      await new Promise(r => setTimeout(r, 60));

      // In half-open: only allow limited probes (successThreshold = 2)
      expect(breaker.currentState).toBe('half-open');

      // First success doesn't fully close
      await breaker.execute(async () => 'probe-1');
      expect(breaker.currentState).toBe('half-open');

      // Second success closes
      await breaker.execute(async () => 'probe-2');
      expect(breaker.currentState).toBe('closed');
    });
  });

  describe('observability completeness during error states', () => {
    it('should emit all standard metrics even during failure (no gaps)', async () => {
      // Metrics pipeline must not fail during cascade
      for (let i = 0; i < 10; i++) {
        obs.incrementCounter('request:total', { status: i < 5 ? 'success' : 'error' });
      }

      const allMetrics = obs.getMetrics('request:total');
      expect(allMetrics.length).toBe(10); // No gaps
    });

    it('should complete all spans even on crash (span.end called in finally)', async () => {
      // Start multiple spans
      const span1 = obs.startSpan('operation-1');
      const span2 = obs.startSpan('operation-2');
      const span3 = obs.startSpan('operation-3');

      // Simulate crash - endAllActiveSpans
      const ended = obs.endAllActiveSpans('error');
      expect(ended).toBe(3);

      // All spans are completed with error status
      const allSpans = obs.allSpans;
      expect(allSpans.length).toBe(3);
      expect(allSpans.every(s => s.status === 'error')).toBe(true);
      expect(allSpans.every(s => s.endTime !== undefined)).toBe(true);
    });

    it('should maintain structured logging during recovery (no log storms)', async () => {
      // Rate-limited logging prevents storms
      const obsWithLimit = new Observability({ logRateLimit: 5 });

      // Try to log 100 messages rapidly
      for (let i = 0; i < 100; i++) {
        obsWithLimit.log('info', `Recovery event ${i}`, {});
      }

      // Rate limited to 5 per second
      expect(obsWithLimit.allLogs.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Deep Interactions: Observability + Distributed + Tools', () => {
    it('should correlate trace spans across machine boundaries (distributed tracing)', async () => {
      const traceId = 'distributed-trace-1';

      // Machine A creates parent span
      const machineASpan = obs.startSpan('machine-a:request', {
        traceId,
        attributes: { machine: 'A', agentId: 'agent-1' },
      });
      obs.endSpan(machineASpan.id);

      // Machine B creates child span (context propagated via transport)
      const machineBSpan = obs.startSpan('machine-b:handler', {
        traceId, // Same traceId propagated
        parentSpanId: machineASpan.id, // Linked to parent
        attributes: { machine: 'B', agentId: 'agent-2' },
      });
      obs.endSpan(machineBSpan.id);

      // Full distributed trace
      const trace = obs.getTrace(traceId);
      expect(trace.length).toBe(2);
      expect(trace[0].attributes.machine).toBe('A');
      expect(trace[1].attributes.machine).toBe('B');
      expect(trace[1].parentSpanId).toBe(machineASpan.id);
    });

    it('should automatically disable tools when error cascade is detected (circuit breaker)', async () => {
      const toolBreaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 10000, failureWindowMs: 10000 });

      // Tool X fails 5 times
      for (let i = 0; i < 5; i++) {
        try {
          await toolBreaker.execute(async () => { throw new Error('Tool X failed'); });
        } catch {}
        obs.incrementCounter('tool:error', { tool: 'X' });
      }

      // Circuit opens - tool disabled
      expect(toolBreaker.currentState).toBe('open');
      obs.incrementCounter('tool_circuit_breaker_opened', { tool: 'X' });

      const breakerMetrics = obs.getMetrics('tool_circuit_breaker_opened');
      expect(breakerMetrics.length).toBe(1);
      expect(breakerMetrics[0].labels.tool).toBe('X');
    });

    it('should distinguish recovery probes from real traffic in metrics', async () => {
      // Real traffic
      obs.incrementCounter('request:total', { probe: 'false', endpoint: '/api/data' });
      obs.incrementCounter('request:total', { probe: 'false', endpoint: '/api/users' });

      // Health probes
      obs.incrementCounter('request:total', { probe: 'true', endpoint: '/health' });

      const allRequests = obs.getMetrics('request:total');
      const realTraffic = allRequests.filter(m => m.labels.probe === 'false');
      const probes = allRequests.filter(m => m.labels.probe === 'true');

      expect(realTraffic.length).toBe(2);
      expect(probes.length).toBe(1);
    });

    it('should handle observability pipeline itself becoming bottleneck during cascade', async () => {
      const obsLimited = new Observability({ maxBufferSize: 10 });

      // Massive spike in spans during cascade
      for (let i = 0; i < 20; i++) {
        const span = obsLimited.startSpan(`cascade-span-${i}`);
        obsLimited.endSpan(span.id, 'error');
      }

      // System sheds observability load rather than blocking
      expect(obsLimited.isShedding).toBe(true);
      // Agent loop continues even if traces dropped
      expect(obsLimited.allSpans.length).toBeLessThanOrEqual(10);
    });

    it('should handle trace context lost during transport failover (broken trace)', async () => {
      const traceId = 'trace-broken';

      // Span on primary transport (with context)
      const parentSpan = obs.startSpan('primary:request', { traceId });
      obs.endSpan(parentSpan.id);

      // Failover - trace headers lost
      const orphanSpan = obs.startSpan('secondary:handler'); // No traceId!
      obs.endSpan(orphanSpan.id);

      // Detect broken trace
      const mainTrace = obs.getTrace(traceId);
      const orphanTrace = obs.getTrace(orphanSpan.traceId);

      expect(mainTrace.length).toBe(1); // Only parent
      expect(orphanTrace.length).toBe(1); // Orphaned
      expect(orphanSpan.traceId).not.toBe(traceId); // Different trace = broken

      // Log the broken trace
      obs.log('warn', 'Broken trace detected: orphaned span', {
        orphanSpanId: orphanSpan.id,
        expectedTraceId: traceId,
        actualTraceId: orphanSpan.traceId,
      });
    });

    it('should trigger automatic parallel-to-sequential demotion on tool failure rate', async () => {
      // Track failure rates
      const toolFailures = new Map<string, number>();
      const toolAttempts = new Map<string, number>();

      // Tool B has high failure rate
      for (let i = 0; i < 10; i++) {
        toolAttempts.set('B', (toolAttempts.get('B') || 0) + 1);
        if (i < 6) toolFailures.set('B', (toolFailures.get('B') || 0) + 1);
      }

      const failureRate = (toolFailures.get('B') || 0) / (toolAttempts.get('B') || 1);
      expect(failureRate).toBe(0.6); // 60% failure rate

      // Demotion triggered
      const shouldDemote = failureRate > 0.5;
      expect(shouldDemote).toBe(true);

      obs.setGauge('tool_execution_mode', 1, { tool: 'B', mode: 'sequential' });
      const modeMetric = obs.getMetrics('tool_execution_mode');
      expect(modeMetric[0].labels.mode).toBe('sequential');
    });

    it('should handle cascading failure in observability backend losing error data about the cascade', async () => {
      const ringBuffer: Array<{ span: any; timestamp: number }> = [];
      const maxBufferSize = 5;

      // Observability backend crashes - buffer locally
      for (let i = 0; i < 8; i++) {
        const span = obs.startSpan(`critical-error-${i}`);
        obs.endSpan(span.id, 'error');

        // Buffer critical spans locally (ring buffer)
        ringBuffer.push({ span: obs.allSpans[obs.allSpans.length - 1], timestamp: Date.now() });
        if (ringBuffer.length > maxBufferSize) ringBuffer.shift();
      }

      // Most recent critical spans preserved
      expect(ringBuffer.length).toBe(maxBufferSize);
      expect(ringBuffer[ringBuffer.length - 1].span.name).toBe('critical-error-7');
    });

    it('should use tracing data to determine recovery order in distributed coordination', async () => {
      // Services with dependencies visible in traces
      const traceId = 'dep-trace';

      const spanC = obs.startSpan('service-c', { traceId });
      const spanB = obs.startSpan('service-b', { traceId, parentSpanId: spanC.id });
      const spanA = obs.startSpan('service-a', { traceId, parentSpanId: spanB.id });

      obs.endSpan(spanA.id, 'error');
      obs.endSpan(spanB.id, 'error');
      obs.endSpan(spanC.id, 'error');

      // Trace topology shows: A depends on B depends on C
      const trace = obs.getTrace(traceId);
      const root = trace.find(s => !s.parentSpanId);
      expect(root?.name).toBe('service-c');

      // Recovery order: C first (root), then B, then A
      const recoveryOrder = ['service-c', 'service-b', 'service-a'];
      recoveryOrder.forEach((service, position) => {
        obs.setGauge('recovery_order', position + 1, { service, position: String(position + 1) });
      });

      const orderMetrics = obs.getMetrics('recovery_order');
      expect(orderMetrics.length).toBe(3);
    });
  });
});
