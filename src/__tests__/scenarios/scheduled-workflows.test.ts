/**
 * Scenario: Scheduled Workflow Execution (Documentation Bot)
 *
 * Tests the iteratio framework's ability to support armament's scheduled
 * workflow system — where .arma scripts define recurring pipelines that:
 * - Spawn sub-agents per subject (one agent per architecture doc)
 * - Poll external services on intervals (Confluence hourly)
 * - React to external events (feedback comments → re-run)
 * - Handle request queues (new doc requests → generate)
 *
 * This models the real-world scenario: /schedule_workflow architecture_docs.arma
 *
 * All tests RED — TDD.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  MockToolExecutor,
  TestAgentFactory,
  TestClock,
  TestScheduler,
} from '../../__test__';

import { AgentLoop } from '../../core/AgentLoop';
import { AgentSpawner } from '../../agents/AgentSpawner';
import { AgentRegistry } from '../../distributed/AgentRegistry';
import { DynamicAgentManager } from '../../agents/DynamicAgentManager';

// These will be implemented — stubs for now
import { ScheduledWorkflowRunner } from '../../coordination/ScheduledWorkflowRunner';
import { WorkflowTriggerManager } from '../../coordination/WorkflowTriggerManager';
import { ExternalServicePoller } from '../../coordination/ExternalServicePoller';

describe('Scheduled Workflows - Documentation Bot Pipeline', () => {
  let transport: MockTransport;
  let eventBus: MockEventBus;
  let clock: TestClock;
  let scheduler: TestScheduler;
  let spawner: AgentSpawner;

  beforeEach(() => {
    transport = new MockTransport();
    eventBus = new MockEventBus();
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
    spawner = new AgentSpawner({
      eventBus,
      transport,
      defaultLLM: new MockLLMProvider(),
    });
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCHEDULED WORKFLOW RUNNER
  // ─────────────────────────────────────────────────────────────────────────

  describe('ScheduledWorkflowRunner', () => {

    it('should accept a workflow definition and begin scheduling', () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'architecture_docs',
        name: 'Architecture Documentation Bot',
        schedule: { type: 'interval', intervalMs: 3600000 },
        steps: [
          { id: 'discover', type: 'agent', task: 'Scan codebase for architecture subjects' },
          { id: 'generate', type: 'parallel-agents', dependsOn: ['discover'] },
          { id: 'publish', type: 'tool', tool: 'confluence_publish', dependsOn: ['generate'] },
        ],
      });
      expect(runner.getRegistered()).toHaveLength(1);
    });

    it('should execute workflow on interval tick', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'poll_docs',
        name: 'Poll Docs',
        schedule: { type: 'interval', intervalMs: 3600000 },
        steps: [{ id: 's1', type: 'agent', task: 'check docs' }],
      });
      runner.start();
      clock.advance(3600000); // 1 hour
      await clock.flush();
      expect(runner.getRunHistory('poll_docs')).toHaveLength(1);
    });

    it('should not execute before interval elapses', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'poll_docs',
        name: 'Poll Docs',
        schedule: { type: 'interval', intervalMs: 3600000 },
        steps: [{ id: 's1', type: 'agent', task: 'check docs' }],
      });
      runner.start();
      clock.advance(1800000); // 30 min — not enough
      await clock.flush();
      expect(runner.getRunHistory('poll_docs')).toHaveLength(0);
    });

    it('should execute multiple times across multiple intervals', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'hourly',
        name: 'Hourly',
        schedule: { type: 'interval', intervalMs: 3600000 },
        steps: [{ id: 's1', type: 'agent', task: 'run' }],
      });
      runner.start();
      clock.advance(3600000);
      await clock.flush();
      clock.advance(3600000);
      await clock.flush();
      clock.advance(3600000);
      await clock.flush();
      expect(runner.getRunHistory('hourly')).toHaveLength(3);
    });

    it('should stop executing after runner.stop()', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'stoppable',
        name: 'Stoppable',
        schedule: { type: 'interval', intervalMs: 60000 },
        steps: [{ id: 's1', type: 'agent', task: 'run' }],
      });
      runner.start();
      clock.advance(60000);
      await clock.flush();
      runner.stop();
      clock.advance(60000);
      await clock.flush();
      expect(runner.getRunHistory('stoppable')).toHaveLength(1);
    });

    it('should pause and resume a specific workflow', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'pausable',
        name: 'Pausable',
        schedule: { type: 'interval', intervalMs: 60000 },
        steps: [{ id: 's1', type: 'agent', task: 'run' }],
      });
      runner.start();
      clock.advance(60000);
      await clock.flush();
      runner.pause('pausable');
      clock.advance(60000);
      await clock.flush();
      expect(runner.getRunHistory('pausable')).toHaveLength(1); // didn't run while paused
      runner.resume('pausable');
      clock.advance(60000);
      await clock.flush();
      expect(runner.getRunHistory('pausable')).toHaveLength(2); // resumed
    });

    it('should respect maxRuns and auto-disable', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'limited',
        name: 'Limited',
        schedule: { type: 'interval', intervalMs: 1000, maxRuns: 3 },
        steps: [{ id: 's1', type: 'agent', task: 'run' }],
      });
      runner.start();
      for (let i = 0; i < 5; i++) {
        clock.advance(1000);
        await clock.flush();
      }
      expect(runner.getRunHistory('limited')).toHaveLength(3);
    });

    it('should emit events for workflow lifecycle', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'events',
        name: 'Events',
        schedule: { type: 'interval', intervalMs: 1000 },
        steps: [{ id: 's1', type: 'agent', task: 'run' }],
      });
      runner.start();
      clock.advance(1000);
      await clock.flush();
      expect(eventBus.emitted('workflow:start')).toHaveLength(1);
      expect(eventBus.emitted('workflow:complete')).toHaveLength(1);
    });

    it('should emit workflow:error when a step fails', async () => {
      const runner = new ScheduledWorkflowRunner({
        eventBus,
        spawner: new AgentSpawner({
          eventBus,
          transport,
          defaultLLM: new MockLLMProvider({ shouldFail: true }),
        }),
        clock,
      });
      runner.register({
        id: 'failing',
        name: 'Failing',
        schedule: { type: 'interval', intervalMs: 1000 },
        steps: [{ id: 's1', type: 'agent', task: 'will fail' }],
      });
      runner.start();
      clock.advance(1000);
      await clock.flush();
      expect(eventBus.emitted('workflow:error')).toHaveLength(1);
    });

    it('should unregister a workflow', () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'temp',
        name: 'Temp',
        schedule: { type: 'interval', intervalMs: 1000 },
        steps: [{ id: 's1', type: 'agent', task: 'x' }],
      });
      runner.unregister('temp');
      expect(runner.getRegistered()).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SUB-AGENT SPAWNING PER SUBJECT
  // ─────────────────────────────────────────────────────────────────────────

  describe('Sub-agent spawning per subject', () => {

    it('should spawn one agent per discovered subject', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'doc_bot',
        name: 'Doc Bot',
        schedule: { type: 'interval', intervalMs: 3600000 },
        steps: [
          {
            id: 'discover',
            type: 'agent',
            task: 'Discover architecture subjects',
            mockOutput: { subjects: ['auth-service', 'payment-gateway', 'user-management'] },
          },
          {
            id: 'generate',
            type: 'parallel-agents',
            dependsOn: ['discover'],
            forEach: '${discover.output.subjects}',
            agentConfig: { task: 'Generate architecture docs for ${item}', model: 'sonnet' },
          },
        ],
      });
      runner.start();
      clock.advance(3600000);
      await clock.flush();
      const history = runner.getRunHistory('doc_bot');
      expect(history[0].spawnedAgents).toHaveLength(3);
    });

    it('should pass subject-specific context to each spawned agent', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'ctx_pass',
        name: 'Context Pass',
        schedule: { type: 'once' },
        steps: [{
          id: 'gen',
          type: 'parallel-agents',
          forEach: ['auth', 'billing'],
          agentConfig: { task: 'Document ${item}', context: { subject: '${item}' } },
        }],
      });
      await runner.runNow('ctx_pass');
      const history = runner.getRunHistory('ctx_pass');
      const agents = history[0].spawnedAgents;
      expect(agents[0].context.subject).toBe('auth');
      expect(agents[1].context.subject).toBe('billing');
    });

    it('should wait for all parallel agents before proceeding to next step', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const stepOrder: string[] = [];
      runner.register({
        id: 'wait_all',
        name: 'Wait All',
        schedule: { type: 'once' },
        steps: [
          {
            id: 'gen',
            type: 'parallel-agents',
            forEach: ['a', 'b', 'c'],
            agentConfig: { task: 'doc ${item}' },
            onComplete: () => stepOrder.push('gen'),
          },
          {
            id: 'publish',
            type: 'tool',
            tool: 'publish',
            dependsOn: ['gen'],
            onComplete: () => stepOrder.push('publish'),
          },
        ],
      });
      await runner.runNow('wait_all');
      expect(stepOrder).toEqual(['gen', 'publish']);
    });

    it('should handle partial agent failures without aborting others', async () => {
      const failingLLM = new MockLLMProvider({
        responseMap: {
          'Document auth': MockLLMProvider.errorResponse('timeout'),
          'Document billing': MockLLMProvider.simpleResponse('done'),
          'Document users': MockLLMProvider.simpleResponse('done'),
        },
      });
      const failSpawner = new AgentSpawner({
        eventBus,
        transport,
        defaultLLM: failingLLM,
      });
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner: failSpawner, clock });
      runner.register({
        id: 'partial_fail',
        name: 'Partial Fail',
        schedule: { type: 'once' },
        steps: [{
          id: 'gen',
          type: 'parallel-agents',
          forEach: ['auth', 'billing', 'users'],
          agentConfig: { task: 'Document ${item}' },
          continueOnFailure: true,
        }],
      });
      await runner.runNow('partial_fail');
      const history = runner.getRunHistory('partial_fail');
      const agents = history[0].spawnedAgents;
      expect(agents.filter((a: any) => a.status === 'completed')).toHaveLength(2);
      expect(agents.filter((a: any) => a.status === 'failed')).toHaveLength(1);
    });

    it('should use different models per agent when configured', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'multi_model',
        name: 'Multi Model',
        schedule: { type: 'once' },
        steps: [
          { id: 'deep', type: 'agent', task: 'Deep analysis', model: 'opus', provider: 'anthropic' },
          { id: 'quick', type: 'agent', task: 'Quick scan', model: 'haiku', provider: 'anthropic' },
          { id: 'local', type: 'agent', task: 'Local check', model: 'llama3', provider: 'ollama' },
        ],
      });
      await runner.runNow('multi_model');
      const history = runner.getRunHistory('multi_model');
      const agents = history[0].spawnedAgents;
      expect(agents[0].model).toBe('opus');
      expect(agents[1].model).toBe('haiku');
      expect(agents[2].model).toBe('llama3');
    });

    it('should distribute agents across nodes', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'distributed',
        name: 'Distributed',
        schedule: { type: 'once' },
        steps: [
          { id: 'g1', type: 'agent', task: 'a', node: 'local' },
          { id: 'g2', type: 'agent', task: 'b', node: 'worker-2' },
        ],
      });
      await runner.runNow('distributed');
      const history = runner.getRunHistory('distributed');
      expect(history[0].spawnedAgents[0].node).toBe('local');
      expect(history[0].spawnedAgents[1].node).toBe('worker-2');
    });

    it('should respect per-agent budget limits', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'budgeted',
        name: 'Budgeted',
        schedule: { type: 'once' },
        agentDefaults: { budget: 2.0 },
        steps: [{
          id: 'gen',
          type: 'parallel-agents',
          forEach: ['auth', 'billing'],
          agentConfig: { task: 'Document ${item}' },
        }],
      });
      await runner.runNow('budgeted');
      const agents = runner.getRunHistory('budgeted')[0].spawnedAgents;
      expect(agents[0].budgetLimit).toBe(2.0);
      expect(agents[1].budgetLimit).toBe(2.0);
    });

    it('should aggregate outputs from parallel agents', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'aggregate',
        name: 'Aggregate',
        schedule: { type: 'once' },
        steps: [
          {
            id: 'gen',
            type: 'parallel-agents',
            forEach: ['auth', 'billing'],
            agentConfig: { task: 'Document ${item}' },
          },
          {
            id: 'combine',
            type: 'tool',
            tool: 'combine_outputs',
            dependsOn: ['gen'],
            input: '${gen.outputs}',
          },
        ],
      });
      await runner.runNow('aggregate');
      const history = runner.getRunHistory('aggregate');
      const combineStep = history[0].stepResults.find((s: any) => s.stepId === 'combine');
      expect(combineStep.input).toBeInstanceOf(Array);
      expect(combineStep.input).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EXTERNAL SERVICE POLLING (Confluence)
  // ─────────────────────────────────────────────────────────────────────────

  describe('ExternalServicePoller', () => {

    it('should poll an external service at configured intervals', async () => {
      const poller = new ExternalServicePoller({ eventBus, clock });
      const pollFn = vi.fn().mockResolvedValue([]);
      poller.register({
        id: 'confluence_comments',
        pollFn,
        intervalMs: 3600000,
      });
      poller.start();
      clock.advance(3600000);
      await clock.flush();
      expect(pollFn).toHaveBeenCalledTimes(1);
    });

    it('should emit events when poller finds new items', async () => {
      const poller = new ExternalServicePoller({ eventBus, clock });
      const pollFn = vi.fn().mockResolvedValue([
        { type: 'comment', pageId: '123', content: 'This is incorrect', author: 'reviewer' },
      ]);
      poller.register({
        id: 'confluence_comments',
        pollFn,
        intervalMs: 3600000,
        eventName: 'confluence:new-comments',
      });
      poller.start();
      clock.advance(3600000);
      await clock.flush();
      expect(eventBus.emitted('confluence:new-comments')).toHaveLength(1);
      expect(eventBus.emitted('confluence:new-comments')[0].data).toHaveLength(1);
    });

    it('should not emit events when poll returns empty', async () => {
      const poller = new ExternalServicePoller({ eventBus, clock });
      const pollFn = vi.fn().mockResolvedValue([]);
      poller.register({
        id: 'confluence_comments',
        pollFn,
        intervalMs: 3600000,
        eventName: 'confluence:new-comments',
      });
      poller.start();
      clock.advance(3600000);
      await clock.flush();
      expect(eventBus.emitted('confluence:new-comments')).toHaveLength(0);
    });

    it('should continue polling after error without crashing', async () => {
      const poller = new ExternalServicePoller({ eventBus, clock });
      let callCount = 0;
      const pollFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('network error');
        return [{ type: 'comment', content: 'new' }];
      });
      poller.register({
        id: 'resilient',
        pollFn,
        intervalMs: 1000,
        eventName: 'confluence:new-comments',
      });
      poller.start();
      clock.advance(1000); // first poll — fails
      await clock.flush();
      clock.advance(1000); // second poll — succeeds
      await clock.flush();
      expect(pollFn).toHaveBeenCalledTimes(2);
      expect(eventBus.emitted('confluence:new-comments')).toHaveLength(1);
    });

    it('should track last poll timestamp per source', async () => {
      const poller = new ExternalServicePoller({ eventBus, clock });
      poller.register({
        id: 'tracked',
        pollFn: vi.fn().mockResolvedValue([]),
        intervalMs: 60000,
      });
      poller.start();
      clock.advance(60000);
      await clock.flush();
      const status = poller.getStatus('tracked');
      expect(status.lastPolledAt).toBeDefined();
      expect(status.pollCount).toBe(1);
    });

    it('should support multiple concurrent pollers', async () => {
      const poller = new ExternalServicePoller({ eventBus, clock });
      const pollA = vi.fn().mockResolvedValue([]);
      const pollB = vi.fn().mockResolvedValue([]);
      poller.register({ id: 'comments', pollFn: pollA, intervalMs: 3600000 });
      poller.register({ id: 'requests', pollFn: pollB, intervalMs: 7200000 });
      poller.start();
      clock.advance(3600000);
      await clock.flush();
      expect(pollA).toHaveBeenCalledTimes(1);
      expect(pollB).toHaveBeenCalledTimes(0); // 2h interval not reached
      clock.advance(3600000);
      await clock.flush();
      expect(pollA).toHaveBeenCalledTimes(2);
      expect(pollB).toHaveBeenCalledTimes(1); // now at 2h
    });

    it('should stop polling when unregistered', async () => {
      const poller = new ExternalServicePoller({ eventBus, clock });
      const pollFn = vi.fn().mockResolvedValue([]);
      poller.register({ id: 'temp', pollFn, intervalMs: 1000 });
      poller.start();
      clock.advance(1000);
      await clock.flush();
      poller.unregister('temp');
      clock.advance(1000);
      await clock.flush();
      expect(pollFn).toHaveBeenCalledTimes(1);
    });

    it('should pass last-poll cursor to poll function for incremental fetching', async () => {
      const poller = new ExternalServicePoller({ eventBus, clock });
      const pollFn = vi.fn().mockImplementation(async (cursor: any) => {
        return { items: [{ id: 'new' }], cursor: cursor ? cursor + 1 : 1 };
      });
      poller.register({
        id: 'incremental',
        pollFn,
        intervalMs: 1000,
        incremental: true,
      });
      poller.start();
      clock.advance(1000);
      await clock.flush();
      clock.advance(1000);
      await clock.flush();
      expect(pollFn).toHaveBeenNthCalledWith(1, undefined);
      expect(pollFn).toHaveBeenNthCalledWith(2, 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TRIGGER MANAGER (event → workflow execution)
  // ─────────────────────────────────────────────────────────────────────────

  describe('WorkflowTriggerManager', () => {

    it('should bind an event to a workflow run', () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'on_feedback',
        name: 'On Feedback',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'fix docs' }],
      });
      triggers.bind('confluence:feedback', 'on_feedback');
      expect(triggers.getBindings()).toHaveLength(1);
    });

    it('should trigger workflow when bound event fires', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'on_feedback',
        name: 'On Feedback',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'fix docs' }],
      });
      triggers.bind('confluence:feedback', 'on_feedback');
      triggers.start();
      eventBus.emit('confluence:feedback', {
        pageId: '123',
        content: 'This section is incorrect',
        author: 'reviewer',
      });
      await clock.flush();
      expect(runner.getRunHistory('on_feedback')).toHaveLength(1);
    });

    it('should pass event data as workflow context', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'contextual',
        name: 'Contextual',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'handle event' }],
      });
      triggers.bind('confluence:feedback', 'contextual', { passEventData: true });
      triggers.start();
      eventBus.emit('confluence:feedback', {
        pageId: '456',
        content: 'Wrong diagram',
        author: 'tech-lead',
      });
      await clock.flush();
      const history = runner.getRunHistory('contextual');
      expect(history[0].context.pageId).toBe('456');
      expect(history[0].context.content).toBe('Wrong diagram');
    });

    it('should filter events before triggering', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'filtered',
        name: 'Filtered',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'fix' }],
      });
      triggers.bind('confluence:comment', 'filtered', {
        filter: (data: any) => /incorrect|wrong|outdated/i.test(data.content),
      });
      triggers.start();
      // This should NOT trigger
      eventBus.emit('confluence:comment', { content: 'Looks good!', author: 'user' });
      await clock.flush();
      // This SHOULD trigger
      eventBus.emit('confluence:comment', { content: 'This is incorrect', author: 'user' });
      await clock.flush();
      expect(runner.getRunHistory('filtered')).toHaveLength(1);
    });

    it('should exclude events from bot authors', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'no_bot',
        name: 'No Bot',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'fix' }],
      });
      triggers.bind('confluence:comment', 'no_bot', {
        filter: (data: any) => !['doc-bot', 'armament'].includes(data.author),
      });
      triggers.start();
      eventBus.emit('confluence:comment', { content: 'Updated docs', author: 'doc-bot' });
      await clock.flush();
      expect(runner.getRunHistory('no_bot')).toHaveLength(0);
      eventBus.emit('confluence:comment', { content: 'This is wrong', author: 'human' });
      await clock.flush();
      expect(runner.getRunHistory('no_bot')).toHaveLength(1);
    });

    it('should debounce rapid-fire events', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'debounced',
        name: 'Debounced',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'handle' }],
      });
      triggers.bind('confluence:comment', 'debounced', { debounceMs: 5000 });
      triggers.start();
      // Fire 10 events in rapid succession
      for (let i = 0; i < 10; i++) {
        eventBus.emit('confluence:comment', { content: `comment ${i}`, author: 'user' });
      }
      clock.advance(5000);
      await clock.flush();
      // Should only trigger once
      expect(runner.getRunHistory('debounced')).toHaveLength(1);
    });

    it('should unbind a trigger', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'unbindable',
        name: 'Unbindable',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'handle' }],
      });
      const bindingId = triggers.bind('confluence:comment', 'unbindable');
      triggers.start();
      triggers.unbind(bindingId);
      eventBus.emit('confluence:comment', { content: 'test' });
      await clock.flush();
      expect(runner.getRunHistory('unbindable')).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FEEDBACK-DRIVEN RE-RUN SCENARIO
  // ─────────────────────────────────────────────────────────────────────────

  describe('Feedback-driven re-runs', () => {

    it('should re-run documentation workflow when incorrect feedback received', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'doc_rerun',
        name: 'Documentation Re-run',
        schedule: { type: 'event' },
        steps: [
          { id: 'fetch', type: 'tool', tool: 'confluence_read_page' },
          { id: 'reanalyze', type: 'agent', task: 'Re-analyze code based on feedback: ${trigger.content}', dependsOn: ['fetch'] },
          { id: 'regenerate', type: 'agent', task: 'Regenerate corrected documentation', dependsOn: ['reanalyze'] },
          { id: 'publish', type: 'tool', tool: 'confluence_update_page', dependsOn: ['regenerate'] },
        ],
      });
      triggers.bind('confluence:feedback', 'doc_rerun', {
        passEventData: true,
        filter: (d: any) => /incorrect|wrong|outdated/i.test(d.content),
      });
      triggers.start();
      eventBus.emit('confluence:feedback', {
        pageId: '12345',
        pageTitle: 'Auth Service Architecture',
        content: 'This is incorrect — the token refresh flow changed in v3',
        author: 'senior-dev',
        spaceKey: 'ARCH',
      });
      await clock.flush();
      const history = runner.getRunHistory('doc_rerun');
      expect(history).toHaveLength(1);
      expect(history[0].context.content).toContain('token refresh');
      expect(history[0].context.pageId).toBe('12345');
    });

    it('should not re-trigger on its own published updates', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'no_loop',
        name: 'No Loop',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'fix' }],
      });
      triggers.bind('confluence:feedback', 'no_loop', {
        filter: (d: any) => d.author !== 'armament-bot' && /incorrect/i.test(d.content),
      });
      triggers.start();
      // Bot's own update — should NOT trigger
      eventBus.emit('confluence:feedback', {
        content: 'Updated: incorrect flow diagram fixed',
        author: 'armament-bot',
      });
      await clock.flush();
      expect(runner.getRunHistory('no_loop')).toHaveLength(0);
    });

    it('should include page subject in re-run context for targeted regeneration', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      runner.register({
        id: 'targeted',
        name: 'Targeted Regen',
        schedule: { type: 'event' },
        steps: [
          { id: 'regen', type: 'agent', task: 'Regenerate docs for ${trigger.subject}' },
        ],
      });
      triggers.bind('confluence:feedback', 'targeted', {
        passEventData: true,
        transform: (data: any) => ({
          ...data,
          subject: data.pageTitle?.replace(' Architecture', '').toLowerCase().replace(/\s+/g, '-'),
        }),
      });
      triggers.start();
      eventBus.emit('confluence:feedback', {
        pageId: '789',
        pageTitle: 'Payment Gateway Architecture',
        content: 'This is incorrect',
        author: 'reviewer',
      });
      await clock.flush();
      const history = runner.getRunHistory('targeted');
      expect(history[0].context.subject).toBe('payment-gateway');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // REQUEST PAGE MONITORING
  // ─────────────────────────────────────────────────────────────────────────

  describe('Request page monitoring', () => {

    it('should trigger new doc generation when request comment detected', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      const poller = new ExternalServicePoller({ eventBus, clock });

      runner.register({
        id: 'new_request',
        name: 'New Architecture Request',
        schedule: { type: 'event' },
        steps: [
          { id: 'parse', type: 'tool', tool: 'parse_request_comment' },
          { id: 'discover', type: 'agent', task: 'Analyze ${parse.output.subject}', dependsOn: ['parse'] },
          { id: 'generate', type: 'agent', task: 'Generate architecture docs for ${parse.output.subject}', dependsOn: ['discover'] },
          { id: 'publish', type: 'tool', tool: 'confluence_create_page', dependsOn: ['generate'] },
          { id: 'reply', type: 'tool', tool: 'confluence_reply', dependsOn: ['publish'] },
        ],
      });

      triggers.bind('confluence:new-request', 'new_request', {
        passEventData: true,
        filter: (d: any) => /^request:/i.test(d.content),
      });

      poller.register({
        id: 'request_page',
        pollFn: vi.fn().mockResolvedValue([
          { type: 'comment', content: 'Request: notification-service — need architecture docs', author: 'eng-lead' },
        ]),
        intervalMs: 3600000,
        eventName: 'confluence:new-request',
      });

      triggers.start();
      poller.start();
      clock.advance(3600000);
      await clock.flush();
      expect(runner.getRunHistory('new_request')).toHaveLength(1);
    });

    it('should handle multiple requests from single poll', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      const poller = new ExternalServicePoller({ eventBus, clock });

      runner.register({
        id: 'multi_request',
        name: 'Multi Request',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'generate for ${trigger.subject}' }],
      });
      triggers.bind('confluence:new-request', 'multi_request', {
        passEventData: true,
        perItem: true, // trigger once per item in array
      });

      poller.register({
        id: 'requests',
        pollFn: vi.fn().mockResolvedValue([
          { content: 'Request: auth-service', author: 'eng1' },
          { content: 'Request: billing-service', author: 'eng2' },
          { content: 'Request: notification-service', author: 'eng3' },
        ]),
        intervalMs: 3600000,
        eventName: 'confluence:new-request',
      });

      triggers.start();
      poller.start();
      clock.advance(3600000);
      await clock.flush();
      // Should trigger 3 separate workflow runs
      expect(runner.getRunHistory('multi_request')).toHaveLength(3);
    });

    it('should not re-trigger for already-processed requests', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      const poller = new ExternalServicePoller({ eventBus, clock });

      const sameRequest = { content: 'Request: auth-service', author: 'eng', id: 'comment-123' };
      runner.register({
        id: 'deduped',
        name: 'Deduped',
        schedule: { type: 'event' },
        steps: [{ id: 's1', type: 'agent', task: 'generate' }],
      });
      triggers.bind('confluence:new-request', 'deduped', {
        deduplicateBy: 'id',
      });

      poller.register({
        id: 'requests',
        pollFn: vi.fn().mockResolvedValue([sameRequest]),
        intervalMs: 3600000,
        eventName: 'confluence:new-request',
      });

      triggers.start();
      poller.start();
      clock.advance(3600000);
      await clock.flush();
      clock.advance(3600000); // second poll returns same request
      await clock.flush();
      expect(runner.getRunHistory('deduped')).toHaveLength(1); // only once
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FULL END-TO-END: /schedule_workflow architecture_docs.arma
  // ─────────────────────────────────────────────────────────────────────────

  describe('End-to-end: /schedule_workflow architecture_docs.arma', () => {

    it('should orchestrate complete documentation bot lifecycle', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      const triggers = new WorkflowTriggerManager({ eventBus, runner });
      const poller = new ExternalServicePoller({ eventBus, clock });

      // Register the main workflow (as if loaded from .arma file)
      runner.register({
        id: 'architecture_docs',
        name: 'Architecture Documentation Bot',
        schedule: { type: 'interval', intervalMs: 3600000 },
        steps: [
          { id: 'discover', type: 'agent', task: 'Scan codebase and identify architecture subjects' },
          {
            id: 'generate',
            type: 'parallel-agents',
            dependsOn: ['discover'],
            forEach: '${discover.output.subjects}',
            agentConfig: { task: 'Generate architecture documentation for ${item}', model: 'sonnet' },
          },
          { id: 'organize', type: 'tool', tool: 'organize_docs', dependsOn: ['generate'] },
          { id: 'validate', type: 'agent', task: 'Validate all generated documentation', dependsOn: ['organize'] },
          { id: 'publish', type: 'tool', tool: 'confluence_publish', dependsOn: ['validate'] },
        ],
      });

      // Register feedback re-run workflow
      runner.register({
        id: 'doc_feedback_rerun',
        name: 'Documentation Feedback Handler',
        schedule: { type: 'event' },
        steps: [
          { id: 'read', type: 'tool', tool: 'confluence_read_page' },
          { id: 'fix', type: 'agent', task: 'Fix documentation based on: ${trigger.content}', dependsOn: ['read'] },
          { id: 'update', type: 'tool', tool: 'confluence_update_page', dependsOn: ['fix'] },
        ],
      });

      // Register request handler workflow
      runner.register({
        id: 'doc_new_request',
        name: 'New Doc Request Handler',
        schedule: { type: 'event' },
        steps: [
          { id: 'analyze', type: 'agent', task: 'Analyze ${trigger.subject} codebase' },
          { id: 'generate', type: 'agent', task: 'Generate docs for ${trigger.subject}', dependsOn: ['analyze'] },
          { id: 'publish', type: 'tool', tool: 'confluence_create_page', dependsOn: ['generate'] },
        ],
      });

      // Set up triggers
      triggers.bind('confluence:feedback', 'doc_feedback_rerun', {
        passEventData: true,
        filter: (d: any) => d.author !== 'armament-bot' && /incorrect|wrong|outdated/i.test(d.content),
      });
      triggers.bind('confluence:new-request', 'doc_new_request', {
        passEventData: true,
        filter: (d: any) => /^request:/i.test(d.content),
      });

      // Set up pollers
      poller.register({
        id: 'feedback_poller',
        pollFn: vi.fn().mockResolvedValue([]),
        intervalMs: 3600000,
        eventName: 'confluence:feedback',
      });
      poller.register({
        id: 'request_poller',
        pollFn: vi.fn().mockResolvedValue([]),
        intervalMs: 3600000,
        eventName: 'confluence:new-request',
      });

      // Start everything
      runner.start();
      triggers.start();
      poller.start();

      // --- Hour 1: scheduled run ---
      clock.advance(3600000);
      await clock.flush();
      expect(runner.getRunHistory('architecture_docs')).toHaveLength(1);

      // --- Hour 2: feedback arrives ---
      clock.advance(3600000);
      await clock.flush();
      eventBus.emit('confluence:feedback', {
        pageId: '123',
        content: 'This is incorrect — auth flow changed',
        author: 'reviewer',
      });
      await clock.flush();
      expect(runner.getRunHistory('doc_feedback_rerun')).toHaveLength(1);

      // --- Hour 3: new request arrives ---
      clock.advance(3600000);
      await clock.flush();
      eventBus.emit('confluence:new-request', {
        content: 'Request: caching-layer — need architecture docs',
        author: 'team-lead',
        subject: 'caching-layer',
      });
      await clock.flush();
      expect(runner.getRunHistory('doc_new_request')).toHaveLength(1);

      // Verify total scheduled runs
      expect(runner.getRunHistory('architecture_docs')).toHaveLength(3); // 3 hours
    });

    it('should correctly report workflow status via events', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'observable',
        name: 'Observable',
        schedule: { type: 'once' },
        steps: [
          { id: 's1', type: 'agent', task: 'analyze' },
          { id: 's2', type: 'agent', task: 'generate', dependsOn: ['s1'] },
        ],
      });
      await runner.runNow('observable');
      // Check that all lifecycle events were emitted
      expect(eventBus.emitted('workflow:start')).toHaveLength(1);
      expect(eventBus.emitted('step:start')).toHaveLength(2);
      expect(eventBus.emitted('step:complete')).toHaveLength(2);
      expect(eventBus.emitted('agent:spawned')).toHaveLength(2);
      expect(eventBus.emitted('workflow:complete')).toHaveLength(1);
    });

    it('should respect overall budget across all sub-agents', async () => {
      const runner = new ScheduledWorkflowRunner({ eventBus, spawner, clock });
      runner.register({
        id: 'budgeted_pipeline',
        name: 'Budgeted',
        schedule: { type: 'once' },
        budget: { total: 5.0, perAgent: 1.5, warnAt: 0.8 },
        steps: [{
          id: 'gen',
          type: 'parallel-agents',
          forEach: ['a', 'b', 'c', 'd'],
          agentConfig: { task: 'generate ${item}' },
        }],
      });
      await runner.runNow('budgeted_pipeline');
      const history = runner.getRunHistory('budgeted_pipeline');
      // With $5 total and $1.5 per agent, should cap or warn
      expect(history[0].budgetUsed).toBeDefined();
      expect(history[0].budgetUsed).toBeLessThanOrEqual(5.0);
    });
  });
});
