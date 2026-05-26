/**
 * Scenario Family 5: Multi-Agent, Multi-Machine, Multi-Provider
 * Tests the combined scenario of agents spanning different machines and
 * using different LLM providers with state transfer across boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockRedis,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  MockToolExecutor,
  MockFlightController,
  TestAgentFactory,
  TestClock,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { WorkCoordinator } from '../../distributed/WorkCoordinator';
import { AgentRegistry } from '../../distributed/AgentRegistry';
import { AgentMessageBus } from '../../distributed/AgentMessageBus';
import { ModelRouter } from '../../hub/ModelRouter';
import { ArtifactTransfer } from '../../hub/ArtifactTransfer';
import { ContextConverter } from '../../hub/ContextConverter';

describe('Multi-Everything - E2E', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let claude: MockLLMProvider;
  let gpt: MockLLMProvider;
  let transportMachine1: MockTransport;
  let transportMachine2: MockTransport;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock();
    clock.install();
    claude = new MockLLMProvider({
      defaultResponse: MockLLMProvider.simpleResponse('Claude analysis: data shows trend'),
    });
    gpt = new MockLLMProvider({
      defaultResponse: MockLLMProvider.simpleResponse('GPT summary: trend confirmed in report'),
    });
    transportMachine1 = new MockTransport();
    transportMachine2 = new MockTransport();
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('cross-machine handoff with different providers', () => {
    it('should hand off from Agent A (machine 1, Claude) to Agent B (machine 2, GPT)', async () => {
      const registry = new AgentRegistry({ redis });
      const messageBus = new AgentMessageBus({ redis });

      // Register agents on different machines
      await registry.register({ id: 'agent-a', machine: 'machine-1', provider: 'claude' });
      await registry.register({ id: 'agent-b', machine: 'machine-2', provider: 'gpt' });

      // Agent A completes its work
      const agentA = new AgentLoop({
        id: 'agent-a',
        llm: claude,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
        transport: transportMachine1,
      });

      const resultA = await agentA.runTurn('Analyze the dataset');

      // Hand off to Agent B via message bus
      await messageBus.send('agent-b', {
        type: 'handoff',
        from: 'agent-a',
        context: resultA.content,
        task: 'Summarize the analysis',
      });

      // Agent B receives and processes
      const message = await messageBus.receive('agent-b');
      expect(message.type).toBe('handoff');
      expect(message.context).toContain('Claude analysis');

      const agentB = new AgentLoop({
        id: 'agent-b',
        llm: gpt,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus: new MockEventBus(),
        transport: transportMachine2,
      });

      const resultB = await agentB.runTurn(`${message.task}: ${message.context}`);
      expect(resultB.content).toContain('GPT summary');
    });

    it('should preserve conversation context across the handoff', async () => {
      const messageBus = new AgentMessageBus({ redis });
      const stateA = new MockStateManager();
      const messagesA = new MockMessageManager();

      // Agent A has multi-turn history
      messagesA.addMessage({ role: 'user', content: 'First question' });
      messagesA.addMessage({ role: 'assistant', content: 'First answer' });
      messagesA.addMessage({ role: 'user', content: 'Follow-up' });
      messagesA.addMessage({ role: 'assistant', content: 'Follow-up answer' });

      stateA.set('task_progress', 0.5);
      stateA.set('findings', ['finding-1', 'finding-2']);

      // Transfer full context
      await messageBus.send('agent-b', {
        type: 'handoff',
        context: {
          messages: messagesA.getMessages(),
          state: stateA.toObject(),
        },
      });

      const received = await messageBus.receive('agent-b');
      expect(received.context.messages).toHaveLength(4);
      expect(received.context.state.findings).toEqual(['finding-1', 'finding-2']);
    });
  });

  describe('state transfer across machine boundary', () => {
    it('should serialize and transfer agent state via Redis', async () => {
      const stateA = new MockStateManager();
      stateA.set('analysis_results', { score: 0.95, categories: ['A', 'B'] });
      stateA.set('iteration', 3);

      // Serialize state to Redis (simulating cross-machine transfer)
      const serialized = JSON.stringify(stateA.toObject());
      await redis.set('transfer:agent-a:state', serialized);

      // Agent B on machine 2 picks it up
      const rawState = await redis.get('transfer:agent-a:state');
      const stateB = new MockStateManager();
      stateB.fromObject(JSON.parse(rawState!));

      expect(stateB.get('analysis_results')).toEqual({ score: 0.95, categories: ['A', 'B'] });
      expect(stateB.get('iteration')).toBe(3);
    });

    it('should handle large state transfers without corruption', async () => {
      const stateA = new MockStateManager();
      // Create a large state object
      const largeData = Array.from({ length: 1000 }, (_, i) => ({
        id: `item-${i}`,
        value: `data-${i}`.repeat(10),
        nested: { a: i, b: i * 2 },
      }));
      stateA.set('large_dataset', largeData);

      const serialized = JSON.stringify(stateA.toObject());
      await redis.set('transfer:large', serialized);

      const raw = await redis.get('transfer:large');
      const stateB = new MockStateManager();
      stateB.fromObject(JSON.parse(raw!));

      const restored = stateB.get<typeof largeData>('large_dataset');
      expect(restored).toHaveLength(1000);
      expect(restored![500].id).toBe('item-500');
    });

    it('should handle transfer failure gracefully', async () => {
      const stateA = new MockStateManager();
      stateA.set('important', 'data');

      redis.setThrowOnNext(new Error('Network error'));

      const transfer = new ArtifactTransfer({ redis });
      const result = await transfer.sendState('agent-a', 'agent-b', stateA.toObject());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });
  });

  describe('cross-provider context conversion', () => {
    it('should convert Claude message format to GPT format', async () => {
      const converter = new ContextConverter();

      const claudeMessages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there', model: 'claude-sonnet-4-20250514' },
        { role: 'user' as const, content: [{ type: 'text', text: 'Multimodal' }] },
      ];

      const gptMessages = converter.claudeToGpt(claudeMessages);
      expect(gptMessages).toHaveLength(3);
      expect(gptMessages[1].role).toBe('assistant');
      // GPT format should not have model field in message
      expect(gptMessages[1]).not.toHaveProperty('model');
    });

    it('should convert GPT tool_calls format to Claude format', async () => {
      const converter = new ContextConverter();

      const gptResponse = {
        content: null,
        tool_calls: [{
          id: 'call_123',
          type: 'function',
          function: { name: 'search', arguments: '{"q": "test"}' },
        }],
      };

      const claudeFormat = converter.gptToolCallToClaude(gptResponse);
      expect(claudeFormat.tool_calls![0].name).toBe('search');
      expect(claudeFormat.tool_calls![0].arguments).toBe('{"q": "test"}');
    });

    it('should preserve semantic meaning during conversion', async () => {
      const converter = new ContextConverter();

      const original = [
        { role: 'system' as const, content: 'You are a helpful assistant' },
        { role: 'user' as const, content: 'Explain quantum computing' },
        { role: 'assistant' as const, content: 'Quantum computing uses qubits...' },
      ];

      // Round-trip: Claude → GPT → Claude
      const gptFormat = converter.claudeToGpt(original);
      const roundTripped = converter.gptToClaude(gptFormat);

      expect(roundTripped[0].content).toBe('You are a helpful assistant');
      expect(roundTripped[1].content).toBe('Explain quantum computing');
      expect(roundTripped[2].content).toBe('Quantum computing uses qubits...');
    });
  });

  describe('mixed model conversation', () => {
    it('should start with Claude and continue with GPT seamlessly', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude },
          { id: 'gpt', provider: gpt },
        ],
      });

      // First turn with Claude
      const r1 = await router.route({
        preferredModel: 'claude',
        messages: [{ role: 'user', content: 'Start analysis' }],
      });
      expect(r1.content).toContain('Claude');

      // Second turn with GPT, including Claude's response as context
      const r2 = await router.route({
        preferredModel: 'gpt',
        messages: [
          { role: 'user', content: 'Start analysis' },
          { role: 'assistant', content: r1.content },
          { role: 'user', content: 'Now summarize' },
        ],
      });
      expect(r2.content).toContain('GPT');
      expect(gpt.calls[0].messages).toHaveLength(3);
    });

    it('should track which model produced each response in the conversation', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude },
          { id: 'gpt', provider: gpt },
        ],
        trackModelPerTurn: true,
      });

      await router.route({ preferredModel: 'claude', messages: [{ role: 'user', content: 'A' }] });
      await router.route({ preferredModel: 'gpt', messages: [{ role: 'user', content: 'B' }] });
      await router.route({ preferredModel: 'claude', messages: [{ role: 'user', content: 'C' }] });

      const history = router.getModelHistory();
      expect(history).toEqual(['claude', 'gpt', 'claude']);
    });
  });

  describe('artifact transfer between agents on different machines', () => {
    it('should transfer a file artifact from machine 1 agent to machine 2 agent', async () => {
      const transfer = new ArtifactTransfer({ redis });

      const artifact = {
        id: 'artifact-1',
        type: 'file',
        name: 'report.md',
        content: '# Report\n\nAnalysis results...',
        metadata: { size: 1024, created: Date.now() },
      };

      await transfer.send('agent-a', 'agent-b', artifact);
      const received = await transfer.receive('agent-b');

      expect(received.id).toBe('artifact-1');
      expect(received.content).toContain('# Report');
      expect(received.metadata.size).toBe(1024);
    });

    it('should handle multiple artifacts queued for transfer', async () => {
      const transfer = new ArtifactTransfer({ redis });

      await transfer.send('agent-a', 'agent-b', { id: 'a1', type: 'file', content: 'file1' });
      await transfer.send('agent-a', 'agent-b', { id: 'a2', type: 'data', content: '{"x":1}' });
      await transfer.send('agent-a', 'agent-b', { id: 'a3', type: 'file', content: 'file3' });

      const all = await transfer.receiveAll('agent-b');
      expect(all).toHaveLength(3);
      expect(all.map(a => a.id)).toEqual(['a1', 'a2', 'a3']);
    });

    it('should expire artifacts after TTL', async () => {
      const transfer = new ArtifactTransfer({ redis, artifactTTL: 5000 });

      await transfer.send('agent-a', 'agent-b', { id: 'a1', content: 'temp' });

      clock.advance(6000);
      const received = await transfer.receive('agent-b');
      expect(received).toBeNull();
    });

    it('should support large binary artifacts via chunked transfer', async () => {
      const transfer = new ArtifactTransfer({ redis, chunkSize: 1024 });

      // 5KB artifact
      const largeContent = 'x'.repeat(5120);
      await transfer.send('agent-a', 'agent-b', { id: 'big', type: 'binary', content: largeContent });

      const received = await transfer.receive('agent-b');
      expect(received.content).toHaveLength(5120);
    });
  });

  describe('coordinated task completion', () => {
    it('should coordinate completion of a multi-step task across providers and machines', async () => {
      const coordinator = new WorkCoordinator({ redis, namespace: 'multi' });
      const registry = new AgentRegistry({ redis });
      const messageBus = new AgentMessageBus({ redis });

      // Setup: 3 agents on 2 machines with 2 providers
      await registry.register({ id: 'analyzer', machine: 'machine-1', provider: 'claude' });
      await registry.register({ id: 'writer', machine: 'machine-2', provider: 'gpt' });
      await registry.register({ id: 'reviewer', machine: 'machine-1', provider: 'claude' });

      // Phase 1: Analyzer works
      const analyzerResult = await claude.invoke([{ role: 'user', content: 'Analyze data' }]);
      await messageBus.send('writer', { type: 'task', data: analyzerResult.content });
      await coordinator.markStepComplete('task-1', 'analyze');

      // Phase 2: Writer works
      const writerResult = await gpt.invoke([{ role: 'user', content: 'Write report' }]);
      await messageBus.send('reviewer', { type: 'task', data: writerResult.content });
      await coordinator.markStepComplete('task-1', 'write');

      // Phase 3: Reviewer works
      await claude.invoke([{ role: 'user', content: 'Review report' }]);
      await coordinator.markStepComplete('task-1', 'review');

      // Verify full task completion
      const status = await coordinator.getTaskProgress('task-1');
      expect(status.completedSteps).toEqual(['analyze', 'write', 'review']);
      expect(status.isComplete).toBe(true);
    });

    it('should handle partial failure in coordinated task', async () => {
      const coordinator = new WorkCoordinator({ redis, namespace: 'multi' });

      await coordinator.markStepComplete('task-1', 'analyze');

      // Writer fails
      const failingGpt = new MockLLMProvider({ throwOnCall: 0 });
      try {
        await failingGpt.invoke([{ role: 'user', content: 'Write' }]);
      } catch {
        await coordinator.markStepFailed('task-1', 'write', 'Provider error');
      }

      const status = await coordinator.getTaskProgress('task-1');
      expect(status.completedSteps).toEqual(['analyze']);
      expect(status.failedSteps).toEqual([{ step: 'write', reason: 'Provider error' }]);
      expect(status.isComplete).toBe(false);
    });

    it('should retry failed step with alternative provider', async () => {
      const coordinator = new WorkCoordinator({ redis, namespace: 'multi' });
      const router = new ModelRouter({
        models: [
          { id: 'gpt', provider: new MockLLMProvider({ throwOnCall: 0 }) },
          { id: 'claude', provider: claude },
        ],
        fallbackChain: ['gpt', 'claude'],
      });

      // First attempt with GPT fails
      try {
        await router.route({ preferredModel: 'gpt', messages: [{ role: 'user', content: 'Write' }] });
      } catch { /* expected */ }

      // Retry with fallback
      const result = await router.route({
        messages: [{ role: 'user', content: 'Write' }],
      });

      expect(result.content).toContain('Claude');
      expect(result.model).toBe('claude');
    });
  });
});
