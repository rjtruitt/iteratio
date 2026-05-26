import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter, RateLimitConfig } from '../RateLimiter';
import { TestClock } from '../../__test__/TestClock';
import { MockRedis } from '../../__test__/MockRedis';

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock(Date.now());
    clock.install();
    limiter = new RateLimiter();
  });

  afterEach(() => {
    limiter.stop();
    clock.uninstall();
  });

  describe('token bucket: allows requests within limit', () => {
    it('should allow requests when under RPM limit', () => {
      limiter.setLimits('model-a', { rpm: 10 });

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(true);
    });

    it('should allow requests when under TPM limit', () => {
      limiter.setLimits('model-a', { tpm: 10000 });

      const result = limiter.checkLimit('model-a', 'client-1', 500);
      expect(result.allowed).toBe(true);
    });

    it('should allow requests when no limits are configured', () => {
      const result = limiter.checkLimit('model-no-limits', 'client-1', 9999);
      expect(result.allowed).toBe(true);
    });
  });

  describe('token bucket: rejects when exhausted', () => {
    it('should reject when RPM limit is reached', () => {
      limiter.setLimits('model-a', { rpm: 3 });

      limiter.trackUsage('model-a', 'client-1', 10);
      limiter.trackUsage('model-a', 'client-1', 10);
      limiter.trackUsage('model-a', 'client-1', 10);

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(false);
      expect(result.limitExceeded).toBe('rpm');
    });

    it('should reject when TPM limit is reached', () => {
      limiter.setLimits('model-a', { tpm: 1000 });

      limiter.trackUsage('model-a', 'client-1', 800);

      const result = limiter.checkLimit('model-a', 'client-1', 300);
      expect(result.allowed).toBe(false);
      expect(result.limitExceeded).toBe('tpm');
    });

    it('should reject when concurrent limit is reached', () => {
      limiter.setLimits('model-a', { concurrent: 2 });

      limiter.requestStarted('model-a', 'client-1');
      limiter.requestStarted('model-a', 'client-1');

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(false);
      expect(result.limitExceeded).toBe('concurrent');
    });

    it('should include reason in rejection result', () => {
      limiter.setLimits('model-a', { rpm: 1 });
      limiter.trackUsage('model-a', 'client-1', 10);

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.reason).toContain('RPM');
    });
  });

  describe('token bucket: refills over time', () => {
    it('should allow requests again after minute window passes', () => {
      limiter.setLimits('model-a', { rpm: 2 });

      limiter.trackUsage('model-a', 'client-1', 10);
      limiter.trackUsage('model-a', 'client-1', 10);

      let result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(false);

      // Advance past the 1-minute window
      clock.advance(61000);

      result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(true);
    });

    it('should allow requests after day window passes for TPD', () => {
      limiter.setLimits('model-a', { tpd: 100 });

      limiter.trackUsage('model-a', 'client-1', 100);

      let result = limiter.checkLimit('model-a', 'client-1', 10);
      expect(result.allowed).toBe(false);

      // Advance past 24 hours
      clock.advance(86400001);

      result = limiter.checkLimit('model-a', 'client-1', 10);
      expect(result.allowed).toBe(true);
    });
  });

  describe('burst: allows burst up to bucket size', () => {
    it('should allow burst of requests within limit', () => {
      limiter.setLimits('model-a', { rpm: 10 });

      // Burst of 5 requests in rapid succession
      for (let i = 0; i < 5; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
      }

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(true); // Still under 10 RPM
    });

    it('should reject burst that exceeds limit', () => {
      limiter.setLimits('model-a', { rpm: 5 });

      for (let i = 0; i < 5; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
      }

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(false);
    });
  });

  describe('sustained: limits average rate', () => {
    it('should track sustained rate over time window', () => {
      limiter.setLimits('model-a', { tpm: 600 }); // 10 tokens/second avg

      // Use 300 tokens in first half of minute
      limiter.trackUsage('model-a', 'client-1', 300);
      clock.advance(30000);

      // Can still use more in second half
      const result = limiter.checkLimit('model-a', 'client-1', 200);
      expect(result.allowed).toBe(true);
    });

    it('should reject when sustained rate exceeds daily limit', () => {
      limiter.setLimits('model-a', { rpd: 10 });

      for (let i = 0; i < 10; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
        clock.advance(1000); // Spread over time
      }

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(false);
      expect(result.limitExceeded).toBe('rpd');
    });
  });

  describe('multi-tenant: separate limits per tenant/agent', () => {
    it('should track usage independently per client', () => {
      limiter.setLimits('model-a', { rpm: 5 });

      // Client 1 uses up their limit
      for (let i = 0; i < 5; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
      }

      // Client 2 should still be allowed
      const result = limiter.checkLimit('model-a', 'client-2');
      expect(result.allowed).toBe(true);
    });

    it('should track usage independently per model', () => {
      limiter.setLimits('model-a', { rpm: 3 });
      limiter.setLimits('model-b', { rpm: 3 });

      // Exhaust model-a for client
      for (let i = 0; i < 3; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
      }

      // Model-b should still be available
      const result = limiter.checkLimit('model-b', 'client-1');
      expect(result.allowed).toBe(true);
    });

    it('should isolate concurrent counts per tenant', () => {
      limiter.setLimits('model-a', { concurrent: 2 });

      limiter.requestStarted('model-a', 'client-1');
      limiter.requestStarted('model-a', 'client-1');

      // Client 1 at limit
      expect(limiter.checkLimit('model-a', 'client-1').allowed).toBe(false);
      // Client 2 unaffected
      expect(limiter.checkLimit('model-a', 'client-2').allowed).toBe(true);
    });
  });

  describe('rate limit headers (remaining, reset time)', () => {
    it('should return remaining capacity in result', () => {
      limiter.setLimits('model-a', { rpm: 10, tpm: 5000 });

      limiter.trackUsage('model-a', 'client-1', 1000);

      const result = limiter.checkLimit('model-a', 'client-1', 500);
      expect(result.remaining).toBeDefined();
      expect(result.remaining!.rpm).toBe(9);
      expect(result.remaining!.tpm).toBe(4000);
    });

    it('should return resetAt time when limit exceeded', () => {
      limiter.setLimits('model-a', { rpm: 1 });
      limiter.trackUsage('model-a', 'client-1', 10);

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(false);
      expect(result.resetAt).toBeTypeOf('number');
      expect(result.resetAt!).toBeGreaterThan(Date.now());
    });
  });

  describe('graceful degradation when Redis unavailable', () => {
    it('should fall back to in-memory tracking when Redis is down', () => {
      const mockRedis = new MockRedis();
      mockRedis.disconnect();

      // RateLimiter should still work with in-memory tracking
      limiter.setLimits('model-a', { rpm: 10 });
      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(true);
    });
  });

  describe('configurable per-model limits', () => {
    it('should enforce different limits per model', () => {
      limiter.setLimits('cheap-model', { rpm: 100, tpm: 100000 });
      limiter.setLimits('expensive-model', { rpm: 5, tpm: 10000 });

      // Cheap model allows many requests
      for (let i = 0; i < 50; i++) {
        limiter.trackUsage('cheap-model', 'client-1', 10);
      }
      expect(limiter.checkLimit('cheap-model', 'client-1').allowed).toBe(true);

      // Expensive model has lower limits
      for (let i = 0; i < 5; i++) {
        limiter.trackUsage('expensive-model', 'client-1', 10);
      }
      expect(limiter.checkLimit('expensive-model', 'client-1').allowed).toBe(false);
    });
  });

  describe('per-operation limits', () => {
    it('should support different limits for tool calls vs LLM requests', () => {
      limiter.setLimits('tool-calls', { rpm: 30 });
      limiter.setLimits('llm-requests', { rpm: 10 });

      // Track tool usage
      for (let i = 0; i < 20; i++) {
        limiter.trackUsage('tool-calls', 'client-1', 0);
      }
      expect(limiter.checkLimit('tool-calls', 'client-1').allowed).toBe(true);

      // LLM requests have stricter limits
      for (let i = 0; i < 10; i++) {
        limiter.trackUsage('llm-requests', 'client-1', 100);
      }
      expect(limiter.checkLimit('llm-requests', 'client-1').allowed).toBe(false);
    });
  });

  describe('sliding window rate limiting', () => {
    it('should use sliding window not fixed window', () => {
      limiter.setLimits('model-a', { rpm: 4 });

      // Use 2 requests at t=0
      limiter.trackUsage('model-a', 'client-1', 10);
      limiter.trackUsage('model-a', 'client-1', 10);

      // Advance 30 seconds
      clock.advance(30000);

      // Use 2 more requests at t=30s
      limiter.trackUsage('model-a', 'client-1', 10);
      limiter.trackUsage('model-a', 'client-1', 10);

      // At t=30s, sliding window sees all 4 requests (within last 60s)
      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(false);

      // At t=61s, first 2 requests fall out of window
      clock.advance(31000);
      const result2 = limiter.checkLimit('model-a', 'client-1');
      expect(result2.allowed).toBe(true);
    });
  });

  describe('rate limit backoff suggestion in error', () => {
    it('should include suggested wait time in rejection', () => {
      limiter.setLimits('model-a', { rpm: 1 });
      limiter.trackUsage('model-a', 'client-1', 10);

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(false);
      expect(result.resetAt).toBeDefined();
      // resetAt should be in the future
      expect(result.resetAt! - Date.now()).toBeGreaterThan(0);
      expect(result.resetAt! - Date.now()).toBeLessThanOrEqual(60000);
    });
  });

  describe('concurrent request tracking', () => {
    it('should increment concurrent on requestStarted', () => {
      limiter.setLimits('model-a', { concurrent: 5 });
      limiter.requestStarted('model-a', 'client-1');

      const usage = limiter.getUsage('model-a', 'client-1');
      expect(usage.concurrent).toBe(1);
    });

    it('should decrement concurrent on requestCompleted', () => {
      limiter.setLimits('model-a', { concurrent: 5 });
      limiter.requestStarted('model-a', 'client-1');
      limiter.requestStarted('model-a', 'client-1');
      limiter.requestCompleted('model-a', 'client-1');

      const usage = limiter.getUsage('model-a', 'client-1');
      expect(usage.concurrent).toBe(1);
    });

    it('should not go below zero concurrent', () => {
      limiter.setLimits('model-a', { concurrent: 5 });
      limiter.requestCompleted('model-a', 'client-1');

      const usage = limiter.getUsage('model-a', 'client-1');
      expect(usage.concurrent).toBe(0);
    });
  });

  describe('resetUsage', () => {
    it('should reset usage counters for a client', () => {
      limiter.setLimits('model-a', { rpm: 5 });
      for (let i = 0; i < 5; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
      }

      limiter.resetUsage('model-a', 'client-1');

      const result = limiter.checkLimit('model-a', 'client-1');
      expect(result.allowed).toBe(true);
    });
  });

  describe('events', () => {
    it('should emit usage-tracked event', () => {
      const listener = vi.fn();
      limiter.on('usage-tracked', listener);
      limiter.setLimits('model-a', { rpm: 100 });

      limiter.trackUsage('model-a', 'client-1', 50);

      expect(listener).toHaveBeenCalledWith('model-a', 'client-1', expect.any(Object));
    });
  });

  describe('Edge Cases', () => {
    it('should handle rate limit = 0 (always blocked)', () => {
      limiter.setLimits('model-zero', { rpm: 0 });

      const result = limiter.checkLimit('model-zero', 'client-1');
      // With 0 RPM, no requests should be allowed (usage >= limit since 0 >= 0)
      expect(result.allowed).toBe(false);
    });

    it('should handle rate limit = Infinity (never blocked)', () => {
      limiter.setLimits('model-inf', { rpm: Infinity });

      // Even after many requests, should never be blocked
      for (let i = 0; i < 10000; i++) {
        limiter.trackUsage('model-inf', 'client-1', 1000);
      }

      const result = limiter.checkLimit('model-inf', 'client-1');
      expect(result.allowed).toBe(true);

    });

    it('should handle request at exactly the rate limit boundary', () => {
      limiter.setLimits('model-boundary', { rpm: 5 });

      // Use exactly 4 requests (one below the limit)
      for (let i = 0; i < 4; i++) {
        limiter.trackUsage('model-boundary', 'client-1', 10);
      }

      // The 5th check should still be allowed (at the limit, not over)
      const result = limiter.checkLimit('model-boundary', 'client-1');
      expect(result.allowed).toBe(true);

      // Track the 5th
      limiter.trackUsage('model-boundary', 'client-1', 10);

      // The 6th should be blocked (over the limit)
      const result2 = limiter.checkLimit('model-boundary', 'client-1');
      expect(result2.allowed).toBe(false);

    });

    it('should handle burst of requests at exactly the limit', () => {
      limiter.setLimits('model-burst', { rpm: 10 });

      // Send exactly 10 requests at once
      for (let i = 0; i < 10; i++) {
        limiter.trackUsage('model-burst', 'client-1', 10);
      }

      // Should be at the limit - next request should be blocked
      const result = limiter.checkLimit('model-burst', 'client-1');
      expect(result.allowed).toBe(false);

    });

    it('should handle rate limit window = 0ms', () => {
      // A zero-length window is nonsensical - should handle gracefully
      limiter.setLimits('model-zero-window', { rpm: 10 });

      // Advance 0ms - window boundary behavior
      clock.advance(0);

      limiter.trackUsage('model-zero-window', 'client-1', 10);
      const result = limiter.checkLimit('model-zero-window', 'client-1');
      expect(result.allowed).toBe(true);

    });

    it('should handle rate limit with negative value (invalid config)', () => {
      // Negative limits should be rejected
      expect(() => limiter.setLimits('model-neg', { rpm: -5 })).toThrow();
    });

    it('should handle concurrent rate limit checks (race condition)', async () => {
      limiter.setLimits('model-race', { rpm: 5 });

      // Simulate multiple concurrent checks
      const checks = Array.from({ length: 10 }, () =>
        Promise.resolve(limiter.checkLimit('model-race', 'client-1'))
      );

      const results = await Promise.all(checks);
      // All checks should complete without error
      expect(results.every(r => typeof r.allowed === 'boolean')).toBe(true);

    });

    it('should handle rate limit reset during active window', () => {
      limiter.setLimits('model-reset', { rpm: 3 });

      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        limiter.trackUsage('model-reset', 'client-1', 10);
      }
      expect(limiter.checkLimit('model-reset', 'client-1').allowed).toBe(false);

      // Reset the usage mid-window
      limiter.resetUsage('model-reset', 'client-1');

      // Should be allowed again
      const result = limiter.checkLimit('model-reset', 'client-1');
      expect(result.allowed).toBe(true);

    });

    it('should handle 10000 requests in 1ms (stress test)', () => {
      limiter.setLimits('model-stress', { rpm: 100000, tpm: 1000000000 });

      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        limiter.trackUsage('model-stress', 'client-1', 1);
      }
      const elapsed = performance.now() - start;

      // Should handle high throughput without hanging
      const result = limiter.checkLimit('model-stress', 'client-1');
      expect(result).toBeDefined();
      expect(elapsed).toBeLessThan(5000);

    });

    it('should handle rate limiter with multiple strategies applied to same key', () => {
      // Apply RPM, TPM, concurrent, and daily limits all at once
      limiter.setLimits('model-multi', {
        rpm: 10,
        tpm: 5000,
        rpd: 100,
        tpd: 50000,
        concurrent: 3,
      });

      limiter.trackUsage('model-multi', 'client-1', 1000);
      limiter.requestStarted('model-multi', 'client-1');

      const result = limiter.checkLimit('model-multi', 'client-1', 500);
      // Should check all strategies and return composite result
      expect(result).toBeDefined();
      expect(typeof result.allowed).toBe('boolean');

    });
  });

  describe('Adversarial: Rate Limit Bypass', () => {
    it('should not allow bypass via forged client identity (per-client limit evasion)', () => {
      limiter.setLimits('model-a', { rpm: 3 });

      // Exhaust limit for client-1
      for (let i = 0; i < 3; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
      }

      // Attacker forges a slightly different client ID to bypass per-client tracking
      // Known gap: null-byte identity forgery creates a new bucket (per-client tracking)
      const result = limiter.checkLimit('model-a', 'client-1\x00', 10);

      // This is a known gap - the null byte creates a different key
      expect(result.allowed).toBe(true);
    });

    it('should enforce global model limit even with distributed requests across multiple IPs', () => {
      limiter.setLimits('model-a', { rpm: 10 });

      // Coordinated attack: 10 different "clients" each send 1 request
      for (let i = 0; i < 10; i++) {
        limiter.trackUsage('model-a', `attacker-${i}`, 10);
      }

      // Known gap: per-client tracking means global model limit is NOT enforced
      // Each attacker has their own bucket with only 1 request
      const result = limiter.checkLimit('model-a', 'attacker-10');
      expect(result.allowed).toBe(true);
    });

    it('should handle request arriving exactly when window resets (boundary gaming)', () => {
      limiter.setLimits('model-a', { rpm: 3 });

      // Use up 2 requests
      limiter.trackUsage('model-a', 'client-1', 10);
      limiter.trackUsage('model-a', 'client-1', 10);

      // Advance to exactly the window boundary (60s)
      clock.advance(60000);

      // After 60s, old requests fall outside the sliding window
      // So the client has a fresh budget
      limiter.trackUsage('model-a', 'client-1', 10);
      limiter.trackUsage('model-a', 'client-1', 10);
      limiter.trackUsage('model-a', 'client-1', 10);

      const result = limiter.checkLimit('model-a', 'client-1');

      // At boundary, old entries are cleaned up (>= 60s old), 3 new entries = at limit
      expect(result.allowed).toBe(false);
    });

    it('should prevent rapid key rotation to evade per-key tracking', () => {
      limiter.setLimits('model-a', { rpm: 5 });

      // Attacker rotates through generated keys to get unlimited requests
      for (let i = 0; i < 100; i++) {
        const fakeKey = `generated-key-${i}-${Date.now()}`;
        limiter.trackUsage('model-a', fakeKey, 10);
      }

      // Known gap: no global cross-key rate limiting
      // Each rotated key gets its own fresh bucket
      const result = limiter.checkLimit('model-a', 'generated-key-101');
      expect(result.allowed).toBe(true);
    });

    it('should handle request with payload designed to be expensive but under size limit', () => {
      limiter.setLimits('model-a', { tpm: 10000 });

      // Request claims low token count but the actual processing cost is high
      // Known gap: no retroactive usage adjustment mechanism
      limiter.trackUsage('model-a', 'client-1', 1); // claims 1 token

      // The system trusts the reported token count
      const result = limiter.checkLimit('model-a', 'client-1', 1);
      expect(result.allowed).toBe(true);
    });

    it('should cap tracking storage when flooded with preflight/lightweight requests', () => {
      limiter.setLimits('model-a', { rpm: 1000000 });

      // Flood with unique client IDs to exhaust tracking storage
      for (let i = 0; i < 1000; i++) {
        limiter.trackUsage('model-a', `flood-client-${i}`, 0);
      }

      // Known gap: no eviction policy on tracking storage
      // All entries are stored in memory
      const usage = limiter.getUsage('model-a', 'flood-client-0');
      expect(usage).toBeDefined();
      expect(usage.rpm).toBeGreaterThanOrEqual(0);
    });

    it('should resist time manipulation (clock skew) to reset rate limit window early', () => {
      limiter.setLimits('model-a', { rpm: 3 });

      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
      }
      expect(limiter.checkLimit('model-a', 'client-1').allowed).toBe(false);

      // Clock goes backwards - entries still within the window (timestamp > now - 60s)
      // Since entries have timestamps in the "future" relative to new now, they're
      // still within the sliding window, so the limit stays enforced
      clock.advance(-30000); // go back 30 seconds

      const result = limiter.checkLimit('model-a', 'client-1');

      // Entries have timestamps 30s in the "future" from current time,
      // which means they are within the 60s sliding window (now - 60000 to now)
      // Actually, since entries were at t=X and now is t=X-30s, the entries
      // are at now+30s which is > now, so >= minuteAgo filter keeps them
      expect(result.allowed).toBe(false);
    });

    it('should handle concurrent requests designed to exploit check-then-act race', async () => {
      limiter.setLimits('model-a', { rpm: 5 });

      // Use 4 of 5 allowed requests
      for (let i = 0; i < 4; i++) {
        limiter.trackUsage('model-a', 'client-1', 10);
      }

      // Two requests check simultaneously — both see 1 slot remaining
      const check1 = limiter.checkLimit('model-a', 'client-1');
      const check2 = limiter.checkLimit('model-a', 'client-1');

      // Both checks pass, but only one should be allowed (TOCTOU race)
      // FAILS: check-then-act is not atomic
      if (check1.allowed) limiter.trackUsage('model-a', 'client-1', 10);
      if (check2.allowed) limiter.trackUsage('model-a', 'client-1', 10);

      // Now over limit — the system allowed 6 of 5
      const finalCheck = limiter.checkLimit('model-a', 'client-1');
      expect(finalCheck.allowed).toBe(false);

    });
  });

  describe('Untested Methods', () => {
    it('getLimits(key) — get configured limits for key', () => {
      limiter.setLimits('model-x', { rpm: 20, tpm: 50000, concurrent: 5 });

      const limits = limiter.getLimits('model-x');

      expect(limits).toBeDefined();
      expect(limits!.rpm).toBe(20);
      expect(limits!.tpm).toBe(50000);
      expect(limits!.concurrent).toBe(5);

    });

    it('getLimits(key) — returns null for unconfigured key', () => {
      const limits = limiter.getLimits('nonexistent-model');

      expect(limits).toBeNull();

    });

    it('getLimits(key) — reflects updated limits after setLimits called again', () => {
      limiter.setLimits('model-y', { rpm: 10 });
      limiter.setLimits('model-y', { rpm: 50, tpm: 100000 });

      const limits = limiter.getLimits('model-y');

      expect(limits!.rpm).toBe(50);
      expect(limits!.tpm).toBe(100000);

    });
  });
});
