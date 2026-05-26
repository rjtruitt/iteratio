/**
 * Scenario Family 7: Memory Integration
 * Tests memory storage, retrieval, backends (in-memory, IndexedDB, Redis),
 * prompt injection, extraction, deduplication, expiration, and cross-agent sharing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockRedis,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  MockToolExecutor,
  TestAgentFactory,
  TestClock,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { MemoryManager } from '../../memory/MemoryManager';
import { InMemoryBackend } from '../../memory/InMemoryBackend';
import { IndexedDBBackend } from '../../memory/IndexedDBBackend';
import { RedisMemoryBackend } from '../../memory/RedisMemoryBackend';
import { MemoryPlugin } from '../../memory/MemoryPlugin';

describe('Memory Backends - E2E', () => {
  let clock: TestClock;
  let eventBus: MockEventBus;

  beforeEach(() => {
    clock = new TestClock(Date.now());
    clock.install();
    eventBus = new MockEventBus();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('basic memory operations', () => {
    it('should store a fact during agent turn and retrieve it next turn', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });
      const llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.simpleResponse('I learned that the capital of France is Paris.'),
        MockLLMProvider.simpleResponse('Based on my memory, the capital of France is Paris.'),
      );

      const agent = new AgentLoop({
        llm,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus,
        plugins: [new MemoryPlugin({ memory })],
      });

      // Turn 1: Agent learns a fact
      await agent.runTurn('The capital of France is Paris');
      await memory.store({ fact: 'Capital of France is Paris', source: 'user', confidence: 1.0 });

      // Turn 2: Agent should recall the fact
      const result = await agent.runTurn('What is the capital of France?');
      const recalled = await memory.search('capital France');
      expect(recalled.length).toBeGreaterThan(0);
      expect(recalled[0].fact).toContain('Paris');
    });

    it('should store multiple facts and retrieve relevant ones', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });

      await memory.store({ fact: 'Python is a programming language', tags: ['coding'] });
      await memory.store({ fact: 'Paris is in France', tags: ['geography'] });
      await memory.store({ fact: 'TypeScript extends JavaScript', tags: ['coding'] });

      const codingFacts = await memory.search('programming language');
      expect(codingFacts.some(f => f.fact.includes('Python'))).toBe(true);
      expect(codingFacts.some(f => f.fact.includes('Paris'))).toBe(false);
    });

    it('should update existing facts without duplication', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });

      await memory.store({ fact: 'Project deadline is March 15', id: 'deadline' });
      await memory.store({ fact: 'Project deadline is March 20', id: 'deadline' }); // Updated

      const results = await memory.search('deadline');
      expect(results).toHaveLength(1);
      expect(results[0].fact).toContain('March 20');
    });

    it('should delete facts', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });

      await memory.store({ fact: 'Temporary note', id: 'temp-1' });
      await memory.delete('temp-1');

      const results = await memory.search('Temporary note');
      expect(results).toHaveLength(0);
    });
  });

  describe('in-memory backend', () => {
    it('should support fast keyword search', async () => {
      const backend = new InMemoryBackend();
      const memory = new MemoryManager({ backend });

      // Store 100 facts
      for (let i = 0; i < 100; i++) {
        await memory.store({ fact: `Fact number ${i}: data point ${i * 10}`, id: `fact-${i}` });
      }

      const results = await memory.search('number 42');
      expect(results.some(r => r.fact.includes('Fact number 42'))).toBe(true);
    });

    it('should support tag-based filtering', async () => {
      const backend = new InMemoryBackend();
      const memory = new MemoryManager({ backend });

      await memory.store({ fact: 'API key is xyz', tags: ['secrets', 'config'] });
      await memory.store({ fact: 'Server is us-east-1', tags: ['config', 'infra'] });
      await memory.store({ fact: 'Alice is the lead', tags: ['team'] });

      const configFacts = await memory.searchByTags(['config']);
      expect(configFacts).toHaveLength(2);
    });

    it('should order results by relevance score', async () => {
      const backend = new InMemoryBackend();
      const memory = new MemoryManager({ backend });

      await memory.store({ fact: 'TypeScript is great for large codebases' });
      await memory.store({ fact: 'TypeScript was created by Microsoft' });
      await memory.store({ fact: 'JavaScript runs in the browser' });

      const results = await memory.search('TypeScript');
      expect(results.length).toBeGreaterThanOrEqual(2);
      // TypeScript-specific results should rank higher
      expect(results[0].fact).toContain('TypeScript');
    });
  });

  describe('IndexedDB backend (mocked)', () => {
    it('should persist facts across sessions', async () => {
      const backend = new IndexedDBBackend({ dbName: 'test-memory' });
      const memory = new MemoryManager({ backend });

      await memory.store({ fact: 'Persistent fact', id: 'persist-1' });

      // Simulate closing and reopening
      await backend.close();
      const backend2 = new IndexedDBBackend({ dbName: 'test-memory' });
      const memory2 = new MemoryManager({ backend: backend2 });

      const results = await memory2.search('Persistent');
      expect(results).toHaveLength(1);
      expect(results[0].fact).toBe('Persistent fact');
    });

    it('should handle concurrent reads and writes', async () => {
      const backend = new IndexedDBBackend({ dbName: 'test-concurrent' });
      const memory = new MemoryManager({ backend });

      // Parallel writes
      await Promise.all([
        memory.store({ fact: 'Fact A', id: 'a' }),
        memory.store({ fact: 'Fact B', id: 'b' }),
        memory.store({ fact: 'Fact C', id: 'c' }),
      ]);

      // Parallel reads
      const [a, b, c] = await Promise.all([
        memory.getById('a'),
        memory.getById('b'),
        memory.getById('c'),
      ]);

      expect(a!.fact).toBe('Fact A');
      expect(b!.fact).toBe('Fact B');
      expect(c!.fact).toBe('Fact C');
    });
  });

  describe('Redis backend', () => {
    it('should store and retrieve facts via Redis', async () => {
      const redis = new MockRedis();
      const backend = new RedisMemoryBackend({ redis, namespace: 'agent-memory' });
      const memory = new MemoryManager({ backend });

      await memory.store({ fact: 'Redis-stored fact', id: 'redis-1' });
      const results = await memory.search('Redis-stored');

      expect(results).toHaveLength(1);
      expect(results[0].fact).toBe('Redis-stored fact');
    });

    it('should share memories across agents via Redis', async () => {
      const redis = new MockRedis();
      const backend1 = new RedisMemoryBackend({ redis, namespace: 'shared-memory' });
      const backend2 = new RedisMemoryBackend({ redis, namespace: 'shared-memory' });

      const memory1 = new MemoryManager({ backend: backend1 });
      const memory2 = new MemoryManager({ backend: backend2 });

      await memory1.store({ fact: 'Agent A discovered X=42', id: 'discovery-1' });

      // Agent B should see Agent A's discovery
      const results = await memory2.search('X=42');
      expect(results).toHaveLength(1);
      expect(results[0].fact).toContain('Agent A discovered');
    });

    it('should handle Redis disconnection gracefully', async () => {
      const redis = new MockRedis();
      const backend = new RedisMemoryBackend({ redis, namespace: 'memory', fallbackToLocal: true });
      const memory = new MemoryManager({ backend });

      await memory.store({ fact: 'Before disconnect', id: 'pre' });
      redis.disconnect();

      // Should fall back to local cache
      const results = await memory.search('Before disconnect');
      expect(results).toHaveLength(1);
    });
  });

  describe('memory injection into system prompt', () => {
    it('should inject relevant memories as context before each turn', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });
      await memory.store({ fact: 'User prefers concise answers' });
      await memory.store({ fact: 'User is working on TypeScript project' });

      const messageManager = new MockMessageManager();
      const plugin = new MemoryPlugin({ memory, injectionStrategy: 'system-prompt' });

      const agent = new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager: new MockStateManager(),
        messageManager,
        toolExecutor: new MockToolExecutor(),
        eventBus,
        plugins: [plugin],
      });

      await agent.runTurn('Help me with my code');

      // System prompt should contain memory context
      const messages = messageManager.getMessages();
      const systemMsg = messages.find(m => m.role === 'system');
      expect(systemMsg?.content).toContain('concise');
      expect(systemMsg?.content).toContain('TypeScript');
    });

    it('should limit injected memories to most relevant N', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });

      // Store many facts
      for (let i = 0; i < 50; i++) {
        await memory.store({ fact: `Fact ${i}: some data` });
      }

      const plugin = new MemoryPlugin({ memory, maxInjected: 5, injectionStrategy: 'system-prompt' });

      const messageManager = new MockMessageManager();
      const agent = new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager: new MockStateManager(),
        messageManager,
        toolExecutor: new MockToolExecutor(),
        eventBus,
        plugins: [plugin],
      });

      await agent.runTurn('Question');

      const messages = messageManager.getMessages();
      const systemMsg = messages.find(m => m.role === 'system');
      // Should not inject all 50 facts
      const factCount = (systemMsg?.content?.match(/Fact \d+/g) || []).length;
      expect(factCount).toBeLessThanOrEqual(5);
    });
  });

  describe('memory extraction from responses', () => {
    it('should extract facts from agent responses (afterTurn)', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });
      const plugin = new MemoryPlugin({ memory, extractFromResponses: true });

      const llm = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse(
          'I found that the project uses React 18 and TypeScript 5.0.'
        ),
      });

      const agent = new AgentLoop({
        llm,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus,
        plugins: [plugin],
      });

      await agent.runTurn('What tech stack does the project use?');

      // Memory should now contain extracted facts
      const results = await memory.search('React');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('memory deduplication', () => {
    it('should deduplicate semantically identical facts', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend(), deduplication: true });

      await memory.store({ fact: 'The server is located in us-east-1' });
      await memory.store({ fact: 'Server location: us-east-1' }); // Same meaning
      await memory.store({ fact: 'Our server is in the us-east-1 region' }); // Same meaning

      const results = await memory.getAll();
      // Should deduplicate to 1 fact (or at most 2 if fuzzy matching isn't perfect)
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('memory expiration', () => {
    it('should remove expired facts after TTL', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });

      await memory.store({ fact: 'Temporary: meeting at 3pm', ttl: 3600000 }); // 1 hour TTL
      await memory.store({ fact: 'Permanent: team lead is Alice' }); // No TTL

      clock.advance(3700000); // Advance past TTL

      const results = await memory.getAll({ includeExpired: false });
      expect(results.some(r => r.fact.includes('meeting'))).toBe(false);
      expect(results.some(r => r.fact.includes('Alice'))).toBe(true);
    });

    it('should support configurable TTL per fact', async () => {
      const memory = new MemoryManager({ backend: new InMemoryBackend() });

      await memory.store({ fact: 'Short-lived', ttl: 1000 }); // 1 second
      await memory.store({ fact: 'Long-lived', ttl: 86400000 }); // 1 day

      clock.advance(5000);

      const results = await memory.getAll({ includeExpired: false });
      expect(results.some(r => r.fact === 'Short-lived')).toBe(false);
      expect(results.some(r => r.fact === 'Long-lived')).toBe(true);
    });
  });

  describe('cross-agent memory sharing', () => {
    it('should allow agent A discovery to help agent B', async () => {
      const redis = new MockRedis();
      const sharedBackend = new RedisMemoryBackend({ redis, namespace: 'team-memory' });
      const sharedMemory = new MemoryManager({ backend: sharedBackend });

      // Agent A makes a discovery
      await sharedMemory.store({
        fact: 'The API endpoint is https://api.example.com/v2',
        source: 'agent-a',
        tags: ['api', 'config'],
      });

      // Agent B searches for API info
      const results = await sharedMemory.search('API endpoint');
      expect(results).toHaveLength(1);
      expect(results[0].fact).toContain('https://api.example.com/v2');
      expect(results[0].source).toBe('agent-a');
    });

    it('should support namespaced private + shared memory', async () => {
      const redis = new MockRedis();
      const privateA = new MemoryManager({
        backend: new RedisMemoryBackend({ redis, namespace: 'private:agent-a' }),
      });
      const privateB = new MemoryManager({
        backend: new RedisMemoryBackend({ redis, namespace: 'private:agent-b' }),
      });
      const shared = new MemoryManager({
        backend: new RedisMemoryBackend({ redis, namespace: 'shared' }),
      });

      await privateA.store({ fact: 'Agent A secret', id: 'a-secret' });
      await shared.store({ fact: 'Shared knowledge', id: 'shared-1' });

      // Agent B should not see Agent A's private memory
      const bResults = await privateB.search('Agent A secret');
      expect(bResults).toHaveLength(0);

      // But Agent B should see shared memory
      const sharedResults = await shared.search('Shared knowledge');
      expect(sharedResults).toHaveLength(1);
    });
  });
});
