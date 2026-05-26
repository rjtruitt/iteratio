/**
 * Scenario Family 4: Multiple LLM Providers with Routing
 * Tests intelligent routing of requests to different LLM providers based on
 * task type, cost, quality, rate limits, and fallback chains.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockFlightController,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  MockToolExecutor,
  TestAgentFactory,
  TestClock,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { ModelRegistry } from '../../hub/ModelRegistry';
import { ModelRouter } from '../../hub/ModelRouter';
import { FlightControllerAdapter } from '../../hub/FlightControllerAdapter';
import { RateLimiter } from '../../hub/RateLimiter';

describe('Multi-LLM Routing - E2E', () => {
  let claude: MockLLMProvider;
  let gpt: MockLLMProvider;
  let gemini: MockLLMProvider;
  let eventBus: MockEventBus;
  let clock: TestClock;

  beforeEach(() => {
    claude = new MockLLMProvider({
      defaultResponse: { content: 'Claude response', finish_reason: 'stop', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } },
    });
    gpt = new MockLLMProvider({
      defaultResponse: { content: 'GPT response', finish_reason: 'stop', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } },
    });
    gemini = new MockLLMProvider({
      defaultResponse: { content: 'Gemini response', finish_reason: 'stop', usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } },
    });
    eventBus = new MockEventBus();
    clock = new TestClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('task-based routing', () => {
    it('should route coding tasks to Claude', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude, capabilities: ['coding', 'analysis'] },
          { id: 'gpt', provider: gpt, capabilities: ['writing', 'creative'] },
        ],
        rules: [
          { taskType: 'coding', preferredModel: 'claude' },
          { taskType: 'writing', preferredModel: 'gpt' },
        ],
      });

      const response = await router.route({
        taskType: 'coding',
        messages: [{ role: 'user', content: 'Write a function to sort an array' }],
      });

      expect(response.content).toBe('Claude response');
      expect(claude.callCount).toBe(1);
      expect(gpt.callCount).toBe(0);
    });

    it('should route writing tasks to GPT', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude, capabilities: ['coding', 'analysis'] },
          { id: 'gpt', provider: gpt, capabilities: ['writing', 'creative'] },
        ],
        rules: [
          { taskType: 'coding', preferredModel: 'claude' },
          { taskType: 'writing', preferredModel: 'gpt' },
        ],
      });

      const response = await router.route({
        taskType: 'writing',
        messages: [{ role: 'user', content: 'Write a poem about nature' }],
      });

      expect(response.content).toBe('GPT response');
      expect(gpt.callCount).toBe(1);
      expect(claude.callCount).toBe(0);
    });

    it('should use default model for unmatched task types', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude, capabilities: ['coding'] },
          { id: 'gpt', provider: gpt, capabilities: ['writing'] },
        ],
        rules: [
          { taskType: 'coding', preferredModel: 'claude' },
        ],
        defaultModel: 'gpt',
      });

      const response = await router.route({
        taskType: 'unknown-task',
        messages: [{ role: 'user', content: 'Do something' }],
      });

      expect(response.content).toBe('GPT response');
    });
  });

  describe('fallback chains', () => {
    it('should fallback to GPT when Claude is unavailable', async () => {
      const failingClaude = new MockLLMProvider({ throwOnCall: 0, throwError: new Error('Service unavailable') });

      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: failingClaude, capabilities: ['coding'] },
          { id: 'gpt', provider: gpt, capabilities: ['coding'] },
        ],
        fallbackChain: ['claude', 'gpt'],
      });

      const response = await router.route({
        taskType: 'coding',
        messages: [{ role: 'user', content: 'Write code' }],
      });

      expect(response.content).toBe('GPT response');
      expect(response.model).toBe('gpt');
      expect(failingClaude.callCount).toBe(1);
      expect(gpt.callCount).toBe(1);
    });

    it('should try all models in fallback chain before failing', async () => {
      const failing1 = new MockLLMProvider({ throwOnCall: 0 });
      const failing2 = new MockLLMProvider({ throwOnCall: 0 });

      const router = new ModelRouter({
        models: [
          { id: 'model-a', provider: failing1 },
          { id: 'model-b', provider: failing2 },
          { id: 'model-c', provider: gemini },
        ],
        fallbackChain: ['model-a', 'model-b', 'model-c'],
      });

      const response = await router.route({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('Gemini response');
      expect(failing1.callCount).toBe(1);
      expect(failing2.callCount).toBe(1);
      expect(gemini.callCount).toBe(1);
    });

    it('should throw when all models in fallback chain fail', async () => {
      const failing1 = new MockLLMProvider({ throwOnCall: 0 });
      const failing2 = new MockLLMProvider({ throwOnCall: 0 });

      const router = new ModelRouter({
        models: [
          { id: 'model-a', provider: failing1 },
          { id: 'model-b', provider: failing2 },
        ],
        fallbackChain: ['model-a', 'model-b'],
      });

      await expect(router.route({
        messages: [{ role: 'user', content: 'Hello' }],
      })).rejects.toThrow(/all models failed|no available model/i);
    });

    it('should emit fallback events for observability', async () => {
      const failingClaude = new MockLLMProvider({ throwOnCall: 0 });

      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: failingClaude },
          { id: 'gpt', provider: gpt },
        ],
        fallbackChain: ['claude', 'gpt'],
        eventBus,
      });

      await router.route({ messages: [{ role: 'user', content: 'Hi' }] });

      expect(eventBus.emitted('model:fallback')).toBe(true);
      expect(eventBus.lastEmitted<any>('model:fallback')?.from).toBe('claude');
      expect(eventBus.lastEmitted<any>('model:fallback')?.to).toBe('gpt');
    });
  });

  describe('model-per-step routing', () => {
    it('should use different models for different pipeline steps', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude },
          { id: 'gpt', provider: gpt },
          { id: 'gemini', provider: gemini },
        ],
        stepRouting: {
          'research': 'claude',
          'draft': 'gpt',
          'review': 'gemini',
        },
      });

      const r1 = await router.routeForStep('research', [{ role: 'user', content: 'Research' }]);
      const r2 = await router.routeForStep('draft', [{ role: 'user', content: 'Draft' }]);
      const r3 = await router.routeForStep('review', [{ role: 'user', content: 'Review' }]);

      expect(r1.content).toBe('Claude response');
      expect(r2.content).toBe('GPT response');
      expect(r3.content).toBe('Gemini response');
    });
  });

  describe('simultaneous requests', () => {
    it('should make parallel requests to multiple providers', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude },
          { id: 'gpt', provider: gpt },
          { id: 'gemini', provider: gemini },
        ],
      });

      const results = await router.invokeAll([{ role: 'user', content: 'Hello' }]);

      expect(results).toHaveLength(3);
      expect(results.map(r => r.content)).toContain('Claude response');
      expect(results.map(r => r.content)).toContain('GPT response');
      expect(results.map(r => r.content)).toContain('Gemini response');
    });

    it('should select best response from parallel invocations', async () => {
      const shortClaude = new MockLLMProvider({
        defaultResponse: { content: 'Short', finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
      });
      const detailedGpt = new MockLLMProvider({
        defaultResponse: { content: 'A very detailed and comprehensive answer that covers all aspects', finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } },
      });

      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: shortClaude },
          { id: 'gpt', provider: detailedGpt },
        ],
        selectionStrategy: 'longest', // Pick the most detailed response
      });

      const best = await router.invokeAndSelect([{ role: 'user', content: 'Explain quantum computing' }]);
      expect(best.content).toContain('detailed and comprehensive');
    });
  });

  describe('rate limit handling', () => {
    it('should switch to another provider when rate limited', async () => {
      const rateLimitedClaude = new MockLLMProvider({
        throwOnCall: 0,
        throwError: Object.assign(new Error('Rate limit exceeded'), { name: 'RateLimitError', retryAfterMs: 60000 }),
      });

      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: rateLimitedClaude },
          { id: 'gpt', provider: gpt },
        ],
        fallbackChain: ['claude', 'gpt'],
        rateLimitStrategy: 'switch',
      });

      const response = await router.route({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(response.content).toBe('GPT response');
    });

    it('should track rate limit windows per provider', async () => {
      const limiter = new RateLimiter({
        limits: {
          'claude': { maxRequests: 2, windowMs: 60000 },
          'gpt': { maxRequests: 5, windowMs: 60000 },
        },
      });

      await limiter.record('claude');
      await limiter.record('claude');

      expect(limiter.isLimited('claude')).toBe(true);
      expect(limiter.isLimited('gpt')).toBe(false);
    });

    it('should reset rate limit window after time passes', async () => {
      const limiter = new RateLimiter({
        limits: {
          'claude': { maxRequests: 2, windowMs: 60000 },
        },
      });

      await limiter.record('claude');
      await limiter.record('claude');
      expect(limiter.isLimited('claude')).toBe(true);

      clock.advance(61000);
      expect(limiter.isLimited('claude')).toBe(false);
    });

    it('should pre-route away from rate-limited providers', async () => {
      const limiter = new RateLimiter({
        limits: { 'claude': { maxRequests: 1, windowMs: 60000 } },
      });
      await limiter.record('claude');

      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude },
          { id: 'gpt', provider: gpt },
        ],
        rateLimiter: limiter,
        fallbackChain: ['claude', 'gpt'],
      });

      const response = await router.route({
        messages: [{ role: 'user', content: 'Hello' }],
      });

      // Should not even try claude since it's rate limited
      expect(claude.callCount).toBe(0);
      expect(response.content).toBe('GPT response');
    });
  });

  describe('cost-based routing', () => {
    it('should use cheapest model for simple tasks', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude, costPer1kTokens: 0.015 },
          { id: 'gpt', provider: gpt, costPer1kTokens: 0.002 },
          { id: 'gemini', provider: gemini, costPer1kTokens: 0.001 },
        ],
        routingStrategy: 'cost-optimized',
      });

      const response = await router.route({
        taskComplexity: 'simple',
        messages: [{ role: 'user', content: 'What is 2+2?' }],
      });

      expect(response.content).toBe('Gemini response');
      expect(gemini.callCount).toBe(1);
    });

    it('should track cumulative cost across requests', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude, costPer1kTokens: 0.015 },
          { id: 'gpt', provider: gpt, costPer1kTokens: 0.002 },
        ],
      });

      await router.route({ messages: [{ role: 'user', content: 'Hello' }] });
      await router.route({ messages: [{ role: 'user', content: 'Hello again' }] });

      const usage = router.getUsage();
      expect(usage.totalCost).toBeGreaterThan(0);
      expect(usage.requestCount).toBe(2);
    });

    it('should enforce budget limits', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude, costPer1kTokens: 0.015 },
        ],
        budgetLimit: 0.001, // Very low budget
      });

      // First call barely fits
      await router.route({ messages: [{ role: 'user', content: 'Hello' }] });

      // Second call should exceed budget
      await expect(router.route({
        messages: [{ role: 'user', content: 'Hello again' }],
      })).rejects.toThrow(/budget exceeded/i);
    });
  });

  describe('quality-based routing', () => {
    it('should use best model for complex tasks', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude, qualityScore: 95 },
          { id: 'gpt', provider: gpt, qualityScore: 85 },
          { id: 'gemini', provider: gemini, qualityScore: 80 },
        ],
        routingStrategy: 'quality-optimized',
      });

      const response = await router.route({
        taskComplexity: 'complex',
        messages: [{ role: 'user', content: 'Analyze the implications of quantum decoherence' }],
      });

      expect(response.content).toBe('Claude response');
    });

    it('should balance cost and quality based on task complexity', async () => {
      const router = new ModelRouter({
        models: [
          { id: 'claude', provider: claude, qualityScore: 95, costPer1kTokens: 0.015 },
          { id: 'gpt', provider: gpt, qualityScore: 85, costPer1kTokens: 0.002 },
        ],
        routingStrategy: 'balanced',
      });

      // Simple task → cheaper model
      const simple = await router.route({
        taskComplexity: 'simple',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(simple.model).toBe('gpt');

      // Complex task → better model
      const complex = await router.route({
        taskComplexity: 'complex',
        messages: [{ role: 'user', content: 'Prove P != NP' }],
      });
      expect(complex.model).toBe('claude');
    });
  });

  describe('FlightController adapter', () => {
    it('should mediate all routing through FlightController', async () => {
      const fc = new MockFlightController();
      const adapter = new FlightControllerAdapter({ fc, eventBus });

      const response = await adapter.invoke(
        [{ role: 'user', content: 'Hello' }],
        { model: 'claude-sonnet-4-20250514' }
      );

      expect(response.content).toBe('FC mock response');
      expect(fc.callCount).toBe(1);
    });

    it('should handle FlightController rate limiting', async () => {
      const fc = new MockFlightController({ rateLimitOnCall: 0 });
      const adapter = new FlightControllerAdapter({ fc, eventBus, retryOnRateLimit: true });

      // Should retry after rate limit
      const response = await adapter.invoke(
        [{ role: 'user', content: 'Hello' }],
        {}
      );

      expect(fc.callCount).toBe(2); // First call rate limited, second succeeds
      expect(response.content).toBe('FC mock response');
    });

    it('should report health status through adapter', async () => {
      const fc = new MockFlightController({ healthStatus: 'degraded' });
      const adapter = new FlightControllerAdapter({ fc, eventBus });

      const health = adapter.checkHealth();
      expect(health.status).toBe('degraded');
    });
  });
});
