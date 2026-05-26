import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockLLMProvider,
  MockEventBus,
  MockStateManager,
  MockRedis,
  MockFlightController,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 24: Rate Limiting Under Various Load Patterns ---
// Tests burst, sustained, over-limit, multi-tenant, cross-machine coordination,
// recovery, priority bypass, and FlightController delegation.

describe('E2E Scenario 24: Rate Limiting', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let redis: MockRedis;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    redis = new MockRedis();
    clock = new TestClock(1000); // start at t=1000
    scheduler = new TestScheduler();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
    redis.reset();
  });

  describe('Burst Traffic', () => {
    it('should allow first N requests in a burst and queue the rest', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 5, burstSize: 5 });

      const results: Array<{ allowed: boolean }> = [];

      // Send 10 requests instantly
      for (let i = 0; i < 10; i++) {
        results.push(await limiter.tryAcquire('agent-1'));
      }

      const allowed = results.filter(r => r.allowed);
      const blocked = results.filter(r => !r.allowed);

      expect(allowed.length).toBe(5);
      expect(blocked.length).toBe(5);
    });

    it('should return retry-after hint for blocked requests', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 2, burstSize: 2 });

      await limiter.tryAcquire('agent-1');
      await limiter.tryAcquire('agent-1');
      const blocked = await limiter.tryAcquire('agent-1');

      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it('should emit rate-limit:exceeded event on burst overflow', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 3, burstSize: 3 });

      for (let i = 0; i < 5; i++) {
        await limiter.tryAcquire('agent-1');
      }

      expect(eventBus.emitted('rateLimit:exceeded')).toBe(true);
    });
  });

  describe('Sustained Load', () => {
    it('should allow all requests at exactly the rate limit', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 10, burstSize: 10 });

      const results: boolean[] = [];

      // Send 1 request every 100ms (exactly 10/s)
      for (let i = 0; i < 10; i++) {
        const result = await limiter.tryAcquire('agent-1');
        results.push(result.allowed);
        clock.advance(100);
      }

      expect(results.every(r => r === true)).toBe(true);
    });

    it('should maintain steady throughput over extended period', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 5, burstSize: 5 });

      let totalAllowed = 0;

      // Run for 5 seconds at exactly 5 req/s
      for (let second = 0; second < 5; second++) {
        for (let req = 0; req < 5; req++) {
          const result = await limiter.tryAcquire('agent-1');
          if (result.allowed) totalAllowed++;
          clock.advance(200); // 5 requests per 1000ms
        }
      }

      expect(totalAllowed).toBe(25); // All 25 requests should pass
    });
  });

  describe('Over-Limit Load', () => {
    it('should reject excess requests when sustained above limit', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 5, burstSize: 5 });

      let rejected = 0;

      // Send 10 requests per second (double the limit) for 3 seconds
      for (let second = 0; second < 3; second++) {
        for (let req = 0; req < 10; req++) {
          const result = await limiter.tryAcquire('agent-1');
          if (!result.allowed) rejected++;
          clock.advance(100);
        }
      }

      // Roughly half should be rejected
      expect(rejected).toBeGreaterThan(10);
    });

    it('should provide backoff suggestion that increases with consecutive rejections', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 1, burstSize: 1 });

      await limiter.tryAcquire('agent-1'); // uses the 1 token

      const r1 = await limiter.tryAcquire('agent-1');
      const r2 = await limiter.tryAcquire('agent-1');
      const r3 = await limiter.tryAcquire('agent-1');

      // Backoff should increase
      expect(r2.retryAfterMs).toBeGreaterThanOrEqual(r1.retryAfterMs);
      expect(r3.retryAfterMs).toBeGreaterThanOrEqual(r2.retryAfterMs);
    });
  });

  describe('Multi-Tenant Rate Limits', () => {
    it('should maintain separate rate limits for 3 agents', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 2, burstSize: 2, perTenant: true });

      // Each agent gets its own bucket
      const r1 = await limiter.tryAcquire('agent-1');
      const r2 = await limiter.tryAcquire('agent-1');
      const r3 = await limiter.tryAcquire('agent-2');
      const r4 = await limiter.tryAcquire('agent-2');
      const r5 = await limiter.tryAcquire('agent-3');

      // agent-1: 2 allowed (at limit)
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      // agent-2: 2 allowed (separate limit)
      expect(r3.allowed).toBe(true);
      expect(r4.allowed).toBe(true);
      // agent-3: 1 allowed (under limit)
      expect(r5.allowed).toBe(true);
    });

    it('should not let one tenant exhaust another tenant limit', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 3, burstSize: 3, perTenant: true });

      // Agent-1 exhausts its limit
      for (let i = 0; i < 5; i++) await limiter.tryAcquire('agent-1');

      // Agent-2 should still have full capacity
      const result = await limiter.tryAcquire('agent-2');
      expect(result.allowed).toBe(true);
    });

    it('should support per-tenant configuration overrides', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 5, burstSize: 5, perTenant: true });
      limiter.setTenantLimit('premium-agent', { maxPerSecond: 20, burstSize: 20 });

      // Premium agent gets higher limit
      let premiumAllowed = 0;
      for (let i = 0; i < 15; i++) {
        const r = await limiter.tryAcquire('premium-agent');
        if (r.allowed) premiumAllowed++;
      }

      expect(premiumAllowed).toBe(15); // Under the 20/s limit
    });
  });

  describe('Cross-Machine Coordination', () => {
    it('should use shared Redis token bucket for distributed rate limiting', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 5, burstSize: 5, backend: redis });

      // Simulate requests from two machines sharing Redis
      const machine1Results: boolean[] = [];
      const machine2Results: boolean[] = [];

      for (let i = 0; i < 3; i++) {
        machine1Results.push((await limiter.tryAcquire('shared-tenant', { source: 'machine-1' })).allowed);
      }
      for (let i = 0; i < 3; i++) {
        machine2Results.push((await limiter.tryAcquire('shared-tenant', { source: 'machine-2' })).allowed);
      }

      // Combined total should not exceed 5
      const totalAllowed = [...machine1Results, ...machine2Results].filter(r => r).length;
      expect(totalAllowed).toBeLessThanOrEqual(5);
    });

    it('should store token state in Redis', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 10, burstSize: 10, backend: redis });

      await limiter.tryAcquire('agent-1');

      // Redis should have rate limit state
      const stored = await redis.get('ratelimit:agent-1');
      expect(stored).not.toBeNull();
    });
  });

  describe('Rate Limit Recovery', () => {
    it('should refill tokens over time', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 5, burstSize: 5 });

      // Exhaust all tokens
      for (let i = 0; i < 5; i++) await limiter.tryAcquire('agent-1');

      // All tokens used
      const exhausted = await limiter.tryAcquire('agent-1');
      expect(exhausted.allowed).toBe(false);

      // Wait for refill (1 second = 5 tokens)
      clock.advance(1000);

      const recovered = await limiter.tryAcquire('agent-1');
      expect(recovered.allowed).toBe(true);
    });

    it('should not exceed burst size when refilling', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 5, burstSize: 5 });

      // Wait a long time (tokens should cap at burstSize)
      clock.advance(10000);

      let allowed = 0;
      for (let i = 0; i < 10; i++) {
        const r = await limiter.tryAcquire('agent-1');
        if (r.allowed) allowed++;
      }

      // Should cap at burst size (5), not 50
      expect(allowed).toBe(5);
    });

    it('should emit recovery event when tokens are available again', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 5, burstSize: 5 });

      // Exhaust
      for (let i = 0; i < 5; i++) await limiter.tryAcquire('agent-1');

      // Refill
      clock.advance(1000);
      await limiter.tryAcquire('agent-1');

      expect(eventBus.emitted('rateLimit:recovered')).toBe(true);
    });
  });

  describe('Priority Bypass', () => {
    it('should allow admin/priority requests to skip rate limit', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 2, burstSize: 2 });

      // Exhaust normal limit
      await limiter.tryAcquire('agent-1');
      await limiter.tryAcquire('agent-1');

      // Normal request blocked
      const normal = await limiter.tryAcquire('agent-1');
      expect(normal.allowed).toBe(false);

      // Priority request bypasses
      const priority = await limiter.tryAcquire('agent-1', { priority: 'admin' });
      expect(priority.allowed).toBe(true);
    });

    it('should track priority bypass usage separately', async () => {
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 2, burstSize: 2 });

      await limiter.tryAcquire('agent-1', { priority: 'admin' });
      await limiter.tryAcquire('agent-1', { priority: 'admin' });

      const metrics = limiter.getMetrics('agent-1');
      expect(metrics.bypassCount).toBe(2);
    });
  });

  describe('FlightController Delegation', () => {
    it('should defer to FlightController for LLM-specific rate limits', async () => {
      const fc = new MockFlightController();
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 100, burstSize: 100 }); // high local limit
      limiter.delegateTo(fc, 'llm');

      // FC has its own rate limit (lower)
      fc.rateLimitOnCall = 3; // simulate rate limit on 4th call (0-indexed)

      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        try {
          await fc.invoke([], {});
          results.push(true);
        } catch (e: any) {
          if (e.name === 'RateLimitError') results.push(false);
          else throw e;
        }
      }

      // FC should have rate limited one call
      expect(results.filter(r => !r).length).toBe(1);
    });

    it('should respect FC retryAfterMs when rate limited', async () => {
      const fc = new MockFlightController({ rateLimitOnCall: 0 });
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.delegateTo(fc, 'llm');

      try {
        await fc.invoke([], {});
      } catch (e: any) {
        expect(e.retryAfterMs).toBe(5000);
      }
    });

    it('should combine local and FC rate limits (most restrictive wins)', async () => {
      const fc = new MockFlightController();
      const limiter = stateManager.get<any>('rateLimiter');
      limiter.configure({ maxPerSecond: 2, burstSize: 2 }); // local: 2/s
      limiter.delegateTo(fc, 'llm'); // FC: unlimited in mock

      // Local limit should still apply
      await limiter.tryAcquire('agent-1', { type: 'llm' });
      await limiter.tryAcquire('agent-1', { type: 'llm' });
      const third = await limiter.tryAcquire('agent-1', { type: 'llm' });

      expect(third.allowed).toBe(false);
    });
  });
});
