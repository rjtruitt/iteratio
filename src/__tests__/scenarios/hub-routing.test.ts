import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockToolExecutor,
  MockFlightController,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 27: Hub-Based Resource Sharing ---
// Tests model routing, tool sharing, artifact transfer, RBAC denial,
// fallback routing, hub leader failover, hub-level rate limiting, and discovery.

describe('E2E Scenario 27: Hub Routing', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let transport: MockTransport;
  let llm: MockLLMProvider;
  let toolExecutor: MockToolExecutor;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    transport = ctx.transport;
    llm = ctx.llm;
    toolExecutor = ctx.toolExecutor;
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
  });

  describe('Model Routing', () => {
    it('should route agent request to appropriate model based on capability', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerModel('claude-haiku', { capabilities: ['fast', 'summarization'] });
      hub.registerModel('claude-opus', { capabilities: ['reasoning', 'coding', 'analysis'] });

      const routing = await hub.routeRequest({
        agentId: 'agent-1',
        requiredCapability: 'reasoning',
      });

      expect(routing.model).toBe('claude-opus');
    });

    it('should route to most cost-effective model when multiple match', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerModel('opus', { capabilities: ['coding'], costPer1k: 0.015 });
      hub.registerModel('sonnet', { capabilities: ['coding'], costPer1k: 0.003 });

      const routing = await hub.routeRequest({
        agentId: 'agent-1',
        requiredCapability: 'coding',
        preference: 'cost-effective',
      });

      expect(routing.model).toBe('sonnet');
    });

    it('should return error when no model matches required capability', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerModel('haiku', { capabilities: ['fast'] });

      const routing = await hub.routeRequest({
        agentId: 'agent-1',
        requiredCapability: 'image-generation',
      });

      expect(routing.error).toBeDefined();
      expect(routing.error).toContain('no model');
    });

    it('should emit routing event with model selection reason', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerModel('opus', { capabilities: ['analysis'] });

      await hub.routeRequest({
        agentId: 'agent-1',
        requiredCapability: 'analysis',
      });

      expect(eventBus.emitted('hub:routed')).toBe(true);
      const routeEvent = eventBus.lastEmitted<any>('hub:routed');
      expect(routeEvent.reason).toBeDefined();
    });
  });

  describe('Tool Sharing', () => {
    it('should make agent A tools accessible to agent B via hub', async () => {
      const hub = stateManager.get<any>('resourceHub');

      // Agent A registers tools with hub
      hub.registerAgentTools('agent-a', [
        { name: 'web-search', description: 'Search the web' },
        { name: 'calculator', description: 'Math operations' },
      ]);

      // Agent B requests tool access
      const tools = await hub.getAvailableTools('agent-b');

      expect(tools.some((t: any) => t.name === 'web-search')).toBe(true);
      expect(tools.some((t: any) => t.name === 'calculator')).toBe(true);
    });

    it('should proxy tool execution through hub', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentTools('agent-a', [
        { name: 'web-search', execute: async (args: any) => ({ results: ['page1', 'page2'] }) },
      ]);

      // Agent B executes agent A's tool via hub
      const result = await hub.executeTool('agent-b', 'web-search', { query: 'iteratio' });

      expect(result.results).toEqual(['page1', 'page2']);
    });

    it('should track tool usage per agent', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentTools('agent-a', [
        { name: 'calculator', execute: async () => ({ result: 42 }) },
      ]);

      await hub.executeTool('agent-b', 'calculator', { expr: '6*7' });
      await hub.executeTool('agent-c', 'calculator', { expr: '2+2' });

      const usage = hub.getToolUsage('calculator');
      expect(usage.totalCalls).toBe(2);
      expect(usage.byAgent['agent-b']).toBe(1);
      expect(usage.byAgent['agent-c']).toBe(1);
    });
  });

  describe('Artifact Transfer', () => {
    it('should transfer file artifact from one agent to another via hub', async () => {
      const hub = stateManager.get<any>('resourceHub');

      // Agent A produces artifact
      await hub.publishArtifact('agent-a', {
        id: 'report-1',
        type: 'file',
        data: Buffer.from('report content'),
        metadata: { mimeType: 'text/plain' },
      });

      // Agent B retrieves artifact
      const artifact = await hub.getArtifact('agent-b', 'report-1');

      expect(artifact.data.toString()).toBe('report content');
      expect(artifact.metadata.mimeType).toBe('text/plain');
    });

    it('should notify recipient agent when artifact is available', async () => {
      const hub = stateManager.get<any>('resourceHub');

      // Agent B subscribes to artifacts
      hub.subscribeToArtifacts('agent-b');

      await hub.publishArtifact('agent-a', {
        id: 'data-1',
        type: 'json',
        data: { processed: true },
      });

      expect(eventBus.emitted('artifact:available')).toBe(true);
      const notification = eventBus.lastEmitted<any>('artifact:available');
      expect(notification.artifactId).toBe('data-1');
      expect(notification.from).toBe('agent-a');
    });

    it('should support artifact expiration', async () => {
      const hub = stateManager.get<any>('resourceHub');

      await hub.publishArtifact('agent-a', {
        id: 'ephemeral',
        type: 'file',
        data: 'temp',
        ttlMs: 5000,
      });

      clock.advance(6000);

      const artifact = await hub.getArtifact('agent-b', 'ephemeral');
      expect(artifact).toBeNull();
    });
  });

  describe('RBAC Denial', () => {
    it('should deny agent access to tool it does not have permission for', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentTools('admin-agent', [
        { name: 'delete-database', description: 'Dangerous operation' },
      ]);
      hub.setPermissions('regular-agent', { allowedTools: ['calculator', 'web-search'] });

      const result = await hub.executeTool('regular-agent', 'delete-database', {});

      expect(result.denied).toBe(true);
      expect(result.reason).toContain('permission');
    });

    it('should log RBAC denial with agent and tool details', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentTools('owner', [{ name: 'admin-tool' }]);
      hub.setPermissions('low-priv', { allowedTools: [] });

      await hub.executeTool('low-priv', 'admin-tool', {});

      expect(eventBus.emitted('rbac:denied')).toBe(true);
      const denial = eventBus.lastEmitted<any>('rbac:denied');
      expect(denial.agentId).toBe('low-priv');
      expect(denial.tool).toBe('admin-tool');
    });

    it('should support wildcard permissions (allow all tools)', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentTools('owner', [{ name: 'any-tool', execute: async () => 'ok' }]);
      hub.setPermissions('superuser', { allowedTools: ['*'] });

      const result = await hub.executeTool('superuser', 'any-tool', {});
      expect(result.denied).toBeUndefined();
    });

    it('should deny model access based on agent role', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerModel('expensive-model', { capabilities: ['analysis'], restricted: true });
      hub.setPermissions('basic-agent', { allowedModels: ['haiku'] });

      const routing = await hub.routeRequest({
        agentId: 'basic-agent',
        requiredCapability: 'analysis',
        preferredModel: 'expensive-model',
      });

      expect(routing.denied).toBe(true);
    });
  });

  describe('Fallback Routing', () => {
    it('should route to fallback model when primary is unavailable', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerModel('primary', { capabilities: ['coding'], available: false });
      hub.registerModel('fallback', { capabilities: ['coding'], available: true });

      const routing = await hub.routeRequest({
        agentId: 'agent-1',
        requiredCapability: 'coding',
      });

      expect(routing.model).toBe('fallback');
      expect(routing.usedFallback).toBe(true);
    });

    it('should emit fallback event when primary model is unavailable', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerModel('primary', { capabilities: ['fast'], available: false });
      hub.registerModel('secondary', { capabilities: ['fast'], available: true });

      await hub.routeRequest({
        agentId: 'agent-1',
        requiredCapability: 'fast',
      });

      expect(eventBus.emitted('hub:fallback')).toBe(true);
    });

    it('should try fallback chain in order', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerModel('tier-1', { capabilities: ['x'], available: false, priority: 1 });
      hub.registerModel('tier-2', { capabilities: ['x'], available: false, priority: 2 });
      hub.registerModel('tier-3', { capabilities: ['x'], available: true, priority: 3 });

      const routing = await hub.routeRequest({
        agentId: 'agent-1',
        requiredCapability: 'x',
      });

      expect(routing.model).toBe('tier-3');
      expect(routing.fallbackChainAttempts).toBe(3);
    });
  });

  describe('Hub Leader Failover', () => {
    it('should elect new hub leader when current leader dies', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.setNodes(['hub-1', 'hub-2', 'hub-3']);
      hub.setLeader('hub-1');

      // hub-1 dies
      hub.simulateNodeDeath('hub-1');
      clock.advance(3000);

      expect(hub.getLeader()).not.toBe('hub-1');
      expect(['hub-2', 'hub-3']).toContain(hub.getLeader());
    });

    it('should transfer routing state to new hub leader', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.setNodes(['hub-1', 'hub-2']);
      hub.setLeader('hub-1');

      // Register models under hub-1 leadership
      hub.registerModel('model-a', { capabilities: ['x'] });

      // Failover to hub-2
      hub.simulateNodeDeath('hub-1');
      clock.advance(3000);

      // New leader should have model registry
      const models = hub.getRegisteredModels();
      expect(models.some((m: any) => m.name === 'model-a')).toBe(true);
    });
  });

  describe('Hub-Level Rate Limiting', () => {
    it('should enforce shared rate limit across all agents through hub', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.setGlobalRateLimit({ maxPerSecond: 10 });

      let allowed = 0;
      for (let i = 0; i < 15; i++) {
        const result = await hub.routeRequest({
          agentId: `agent-${i % 3}`, // 3 different agents
          requiredCapability: 'fast',
        });
        if (!result.rateLimited) allowed++;
      }

      expect(allowed).toBeLessThanOrEqual(10);
    });

    it('should return rate limit info when request is throttled', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.setGlobalRateLimit({ maxPerSecond: 1 });

      await hub.routeRequest({ agentId: 'a', requiredCapability: 'x' });
      const throttled = await hub.routeRequest({ agentId: 'b', requiredCapability: 'x' });

      expect(throttled.rateLimited).toBe(true);
      expect(throttled.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('Hub-Mediated Discovery', () => {
    it('should answer "who can do X?" queries', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentCapabilities('agent-a', ['web-search', 'summarization']);
      hub.registerAgentCapabilities('agent-b', ['coding', 'testing']);
      hub.registerAgentCapabilities('agent-c', ['web-search', 'coding']);

      const whoCanSearch = await hub.discoverAgents({ capability: 'web-search' });

      expect(whoCanSearch).toContain('agent-a');
      expect(whoCanSearch).toContain('agent-c');
      expect(whoCanSearch).not.toContain('agent-b');
    });

    it('should return agent metadata in discovery results', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentCapabilities('agent-a', ['analysis'], { model: 'opus', load: 0.3 });

      const results = await hub.discoverAgentsWithMeta({ capability: 'analysis' });

      expect(results[0].agentId).toBe('agent-a');
      expect(results[0].metadata.model).toBe('opus');
      expect(results[0].metadata.load).toBe(0.3);
    });

    it('should update discovery index when agent capabilities change', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentCapabilities('agent-a', ['coding']);

      let discoverable = await hub.discoverAgents({ capability: 'coding' });
      expect(discoverable).toContain('agent-a');

      // Agent removes capability
      hub.unregisterAgentCapabilities('agent-a', ['coding']);

      discoverable = await hub.discoverAgents({ capability: 'coding' });
      expect(discoverable).not.toContain('agent-a');
    });

    it('should support fuzzy capability matching', async () => {
      const hub = stateManager.get<any>('resourceHub');
      hub.registerAgentCapabilities('agent-a', ['code-generation', 'code-review']);

      const results = await hub.discoverAgents({ capability: 'coding', fuzzy: true });

      // Should match 'code-generation' and 'code-review' as related to 'coding'
      expect(results).toContain('agent-a');
    });
  });
});
