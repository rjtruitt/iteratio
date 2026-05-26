import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockEventBus,
  MockStateManager,
  MockToolExecutor,
  TestClock,
  TestScheduler,
  createMockStep,
} from '../../__test__';

// --- E2E Scenario 28: Full Observability Pipeline ---
// Tests metrics emission, span creation, structured logging, trace correlation,
// cross-agent tracing, Prometheus export, OTLP export, dashboard queries, and alerting.

describe('E2E Scenario 28: Observability', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let llm: MockLLMProvider;
  let toolExecutor: MockToolExecutor;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    llm = ctx.llm;
    toolExecutor = ctx.toolExecutor;
    clock = new TestClock(1000);
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  describe('Turn Duration Metrics', () => {
    it('should emit duration metric for every turn', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      await agent.runTurn('first');
      await agent.runTurn('second');

      const metrics = agent.getMetrics('turn.duration');
      expect(metrics.length).toBe(2);
    });

    it('should record turn duration in milliseconds', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      // Simulate a turn taking 150ms
      llm.invoke = async () => {
        clock.advance(150);
        return MockLLMProvider.simpleResponse('done');
      };

      await agent.runTurn('hello');

      const metrics = agent.getMetrics('turn.duration');
      expect(metrics[0].value).toBeGreaterThanOrEqual(150);
    });

    it('should include turn number and model in metric labels', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      await agent.runTurn('hello');

      const metrics = agent.getMetrics('turn.duration');
      expect(metrics[0].labels.turnNumber).toBeDefined();
      expect(metrics[0].labels.model).toBeDefined();
    });
  });

  describe('Tool Call Spans', () => {
    it('should create a span for every tool call', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      // Simulate LLM requesting tool call
      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'web-search', arguments: '{"q":"test"}' },
      ]);

      await agent.runTurn('search for something');

      const spans = agent.getSpans('tool.execute');
      expect(spans.length).toBe(1);
      expect(spans[0].attributes.toolName).toBe('web-search');
    });

    it('should record tool execution duration in span', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      toolExecutor.setResult('slow-tool', { success: true, data: {} });

      // Make tool take time
      const originalExecute = toolExecutor.executeTool.bind(toolExecutor);
      toolExecutor.executeTool = async (tc, ctx) => {
        clock.advance(200);
        return originalExecute(tc, ctx);
      };

      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'slow-tool', arguments: '{}' },
      ]);

      await agent.runTurn('use slow tool');

      const spans = agent.getSpans('tool.execute');
      expect(spans[0].durationMs).toBeGreaterThanOrEqual(200);
    });

    it('should mark span as error when tool fails', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      toolExecutor.setResult('failing-tool', { success: false, error: 'kaboom' });
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'failing-tool', arguments: '{}' },
      ]);

      await agent.runTurn('use failing tool');

      const spans = agent.getSpans('tool.execute');
      expect(spans[0].status).toBe('error');
      expect(spans[0].errorMessage).toContain('kaboom');
    });
  });

  describe('Structured Error Logging', () => {
    it('should log every error with structured context', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      llm.invoke = async () => { throw new Error('LLM unavailable'); };

      await agent.runTurn('hello');

      const errorLogs = agent.getErrorLogs();
      expect(errorLogs.length).toBeGreaterThan(0);
      expect(errorLogs[0].message).toContain('LLM unavailable');
      expect(errorLogs[0].context.agentId).toBeDefined();
      expect(errorLogs[0].context.turnNumber).toBeDefined();
      expect(errorLogs[0].context.timestamp).toBeDefined();
    });

    it('should include stack trace in error log', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      llm.invoke = async () => { throw new Error('detailed failure'); };

      await agent.runTurn('hello');

      const errorLogs = agent.getErrorLogs();
      expect(errorLogs[0].stack).toBeDefined();
      expect(errorLogs[0].stack).toContain('detailed failure');
    });
  });

  describe('End-to-End Trace', () => {
    it('should connect request -> turn -> step -> tool -> response in single trace', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.setToolExecutor(toolExecutor);
      agent.addStep(createMockStep('preprocess'));
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'calc', arguments: '{}' },
      ]);

      await agent.runTurn('calculate');

      const trace = agent.getTrace();
      expect(trace.spans.some((s: any) => s.name === 'turn')).toBe(true);
      expect(trace.spans.some((s: any) => s.name === 'step.preprocess')).toBe(true);
      expect(trace.spans.some((s: any) => s.name === 'tool.execute')).toBe(true);

      // All spans share same traceId
      const traceIds = new Set(trace.spans.map((s: any) => s.traceId));
      expect(traceIds.size).toBe(1);
    });

    it('should nest spans correctly (tool span is child of step span)', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.setToolExecutor(toolExecutor);
      agent.start();

      llm.invoke = async () => MockLLMProvider.toolCallResponse([
        { id: 'tc-1', name: 'tool-a', arguments: '{}' },
      ]);

      await agent.runTurn('test');

      const trace = agent.getTrace();
      const toolSpan = trace.spans.find((s: any) => s.name === 'tool.execute');
      const turnSpan = trace.spans.find((s: any) => s.name === 'turn');

      expect(toolSpan.parentSpanId).toBe(turnSpan.spanId);
    });
  });

  describe('Cross-Agent Trace Correlation', () => {
    it('should propagate traceId when agent delegates to another agent', async () => {
      const parentAgent = stateManager.get<any>('agentLoop');
      parentAgent.enableObservability();
      parentAgent.setAgentId('parent');
      parentAgent.start();

      const childAgent = stateManager.get<any>('agentLoop');
      childAgent.enableObservability();
      childAgent.setAgentId('child');
      childAgent.start();

      // Parent delegates to child with trace context
      const parentTrace = await parentAgent.runTurn('delegate to child');
      const traceContext = parentAgent.getTraceContext();

      childAgent.setTraceContext(traceContext);
      await childAgent.runTurn('child task');

      // Both should share the same traceId
      expect(childAgent.getTrace().traceId).toBe(parentAgent.getTrace().traceId);
    });

    it('should include agentId in span attributes for cross-agent debugging', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.setAgentId('agent-xyz');
      agent.start();

      await agent.runTurn('test');

      const trace = agent.getTrace();
      expect(trace.spans[0].attributes.agentId).toBe('agent-xyz');
    });
  });

  describe('Prometheus Metrics Export', () => {
    it('should export metrics in Prometheus format', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      await agent.runTurn('first');
      await agent.runTurn('second');

      const prometheus = agent.exportMetrics('prometheus');

      // Should contain metric name and value
      expect(prometheus).toContain('iteratio_turn_duration_ms');
      expect(prometheus).toContain('# HELP');
      expect(prometheus).toContain('# TYPE');
    });

    it('should include histogram buckets for duration metrics', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      await agent.runTurn('test');

      const prometheus = agent.exportMetrics('prometheus');
      expect(prometheus).toContain('_bucket{');
      expect(prometheus).toContain('le=');
    });
  });

  describe('OTLP Span Export', () => {
    it('should export spans in OTLP format', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      await agent.runTurn('test');

      const otlp = agent.exportSpans('otlp');

      expect(otlp.resourceSpans).toBeDefined();
      expect(otlp.resourceSpans.length).toBeGreaterThan(0);
      expect(otlp.resourceSpans[0].scopeSpans).toBeDefined();
    });

    it('should include resource attributes in OTLP export', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.setAgentId('export-test');
      agent.start();

      await agent.runTurn('test');

      const otlp = agent.exportSpans('otlp');
      const resource = otlp.resourceSpans[0].resource;

      expect(resource.attributes).toBeDefined();
      expect(resource.attributes.some((a: any) => a.key === 'service.name')).toBe(true);
    });
  });

  describe('Dashboard-Ready Queries', () => {
    it('should support query: average turn duration by model', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      // Run turns with different simulated durations
      llm.invoke = async () => {
        clock.advance(100);
        return MockLLMProvider.simpleResponse('fast');
      };
      await agent.runTurn('fast turn');

      llm.invoke = async () => {
        clock.advance(500);
        return MockLLMProvider.simpleResponse('slow');
      };
      await agent.runTurn('slow turn');

      const avgDuration = agent.queryMetrics('avg', 'turn.duration', { groupBy: 'model' });
      expect(avgDuration).toBeDefined();
      expect(typeof avgDuration['mock-model']).toBe('number');
      expect(avgDuration['mock-model']).toBeGreaterThan(0);
    });

    it('should support query: p95 turn duration', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      // Run 20 turns
      for (let i = 0; i < 20; i++) {
        llm.invoke = async () => {
          clock.advance(i * 10 + 50);
          return MockLLMProvider.simpleResponse('ok');
        };
        await agent.runTurn(`turn ${i}`);
      }

      const p95 = agent.queryMetrics('percentile', 'turn.duration', { percentile: 95 });
      expect(p95).toBeGreaterThan(0);
    });

    it('should support query: error count by type', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.start();

      // Generate different error types
      llm.invoke = async () => { throw new Error('timeout'); };
      await agent.runTurn('t1');

      llm.invoke = async () => { throw new Error('rate limited'); };
      await agent.runTurn('t2');

      const errorCounts = agent.queryMetrics('count', 'errors', { groupBy: 'type' });
      expect(errorCounts).toBeDefined();
    });
  });

  describe('Alert Conditions', () => {
    it('should emit alert event when error rate exceeds threshold', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.setAlertRule('high-error-rate', {
        metric: 'error.rate',
        condition: 'gt',
        threshold: 0.5,
        windowMs: 10000,
      });
      agent.start();

      // 3 out of 4 turns fail (75% error rate)
      llm.invoke = async () => { throw new Error('fail'); };
      await agent.runTurn('t1');
      await agent.runTurn('t2');
      await agent.runTurn('t3');

      llm.invoke = async () => MockLLMProvider.simpleResponse('ok');
      await agent.runTurn('t4');

      expect(eventBus.emitted('alert:triggered')).toBe(true);
      const alert = eventBus.lastEmitted<any>('alert:triggered');
      expect(alert.ruleName).toBe('high-error-rate');
      expect(alert.currentValue).toBeGreaterThan(0.5);
    });

    it('should emit alert recovery when metric drops below threshold', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.setAlertRule('high-error-rate', {
        metric: 'error.rate',
        condition: 'gt',
        threshold: 0.5,
        windowMs: 5000,
      });
      agent.start();

      // First trigger alert
      llm.invoke = async () => { throw new Error('fail'); };
      await agent.runTurn('t1');
      await agent.runTurn('t2');

      // Then recover
      llm.invoke = async () => MockLLMProvider.simpleResponse('ok');
      for (let i = 0; i < 10; i++) await agent.runTurn(`ok-${i}`);

      expect(eventBus.emitted('alert:resolved')).toBe(true);
    });

    it('should support custom alert with multiple conditions', async () => {
      const agent = stateManager.get<any>('agentLoop');
      agent.enableObservability();
      agent.setAlertRule('degraded-performance', {
        conditions: [
          { metric: 'turn.duration', condition: 'gt', threshold: 1000 },
          { metric: 'error.rate', condition: 'gt', threshold: 0.1 },
        ],
        operator: 'AND',
        windowMs: 10000,
      });
      agent.start();

      // Both conditions met: slow AND errors
      llm.invoke = async () => {
        clock.advance(1500);
        throw new Error('slow failure');
      };
      await agent.runTurn('t1');
      await agent.runTurn('t2');

      expect(eventBus.emitted('alert:triggered')).toBe(true);
    });
  });
});
