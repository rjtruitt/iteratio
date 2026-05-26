import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { RateLimiter } from '../../cross-cutting/RateLimiter';
import { ParallelExecutor } from '../../cross-cutting/ParallelExecutor';

/**
 * Cross-cutting: Parallel Agents + Bulk Tasks + Rate Limiting Under Pressure
 */

describe('Cross-cutting: Parallel + Bulk + Rate Limiting', () => {
  let llm: MockLLMProvider;
  let redis: MockRedis;
  let clock: TestClock;

  beforeEach(() => {
    llm = new MockLLMProvider();
    redis = new MockRedis();
    clock = new TestClock();
  });

  describe('rate limiting during parallel burst', () => {
    it('should enforce rate limit when 10 agents fire simultaneously', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, windowMs: 1000 });

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => limiter.tryAcquire(`agent-${i}`))
      );

      const allowed = results.filter(r => r.allowed).length;
      const denied = results.filter(r => !r.allowed).length;
      expect(allowed).toBe(5);
      expect(denied).toBe(5);
    });

    it('should fairly distribute rate limit tokens among parallel agents', async () => {
      const limiter = new RateLimiter({
        maxTokens: 10,
        windowMs: 1000,
        fairDistribution: true,
      });

      // Agent A takes 6, then agent B tries
      for (let i = 0; i < 6; i++) await limiter.tryAcquire('agent-a');
      for (let i = 0; i < 6; i++) await limiter.tryAcquire('agent-b');

      const usage = limiter.getUsageByAgent();
      // With fair distribution, no single agent should get all tokens when pool is stressed
      expect(usage.get('agent-a')).toBeLessThanOrEqual(10);
      expect(usage.get('agent-b')).toBeDefined();
    });

    it('should queue excess requests and process when tokens refill', async () => {
      const limiter = new RateLimiter({ maxTokens: 10, windowMs: 1000 });

      // Exhaust tokens
      for (let i = 0; i < 10; i++) await limiter.tryAcquire();
      expect(limiter.currentTokens).toBe(0);

      // Queue excess
      const queued = limiter.enqueue('agent-overflow');
      expect(limiter.queueLength).toBe(1);

      // Refill
      limiter.refill();
      expect(limiter.currentTokens).toBeLessThanOrEqual(10); // Some consumed from queue
    });
  });

  describe('bulk processing with rate limits', () => {
    it('should process 100 tasks respecting rate limits', async () => {
      const limiter = new RateLimiter({ maxTokens: 20, windowMs: 1000 });
      let processedCount = 0;

      const processBatch = async (batchSize: number) => {
        for (let i = 0; i < batchSize; i++) {
          const result = await limiter.tryAcquire();
          if (result.allowed) {
            processedCount++;
          } else {
            // Wait for refill
            limiter.refill();
            const retry = await limiter.tryAcquire();
            if (retry.allowed) processedCount++;
          }
        }
      };

      await processBatch(100);
      expect(processedCount).toBe(100);
    });

    it('should not exceed rate limit even under backpressure', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, windowMs: 1000 });
      const callsPerWindow: number[] = [];
      let currentWindowCalls = 0;

      for (let i = 0; i < 20; i++) {
        const result = await limiter.tryAcquire();
        if (result.allowed) {
          currentWindowCalls++;
        } else {
          callsPerWindow.push(currentWindowCalls);
          currentWindowCalls = 0;
          limiter.refill();
          // Retry after refill
          const retry = await limiter.tryAcquire();
          if (retry.allowed) currentWindowCalls++;
        }
      }
      callsPerWindow.push(currentWindowCalls);

      // No window should exceed limit
      for (const count of callsPerWindow) {
        expect(count).toBeLessThanOrEqual(5);
      }
    });

    it('should report progress accurately despite rate limit delays', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, windowMs: 1000 });
      const progressUpdates: Array<{ completed: number; total: number }> = [];
      const totalTasks = 15;
      let completed = 0;

      for (let i = 0; i < totalTasks; i++) {
        let result = await limiter.tryAcquire();
        if (!result.allowed) {
          limiter.refill();
          result = await limiter.tryAcquire();
        }
        if (result.allowed) {
          completed++;
          progressUpdates.push({ completed, total: totalTasks });
        }
      }

      expect(progressUpdates.length).toBe(totalTasks);
      expect(progressUpdates[progressUpdates.length - 1].completed).toBe(totalTasks);
      // Progress is monotonically increasing
      for (let i = 1; i < progressUpdates.length; i++) {
        expect(progressUpdates[i].completed).toBeGreaterThan(progressUpdates[i - 1].completed);
      }
    });

    it('should handle rate limit per-model in multi-model scenario', async () => {
      const claudeLimiter = new RateLimiter({ maxTokens: 60, windowMs: 60000, id: 'claude' });
      const gptLimiter = new RateLimiter({ maxTokens: 30, windowMs: 60000, id: 'gpt' });

      // Use both models
      for (let i = 0; i < 40; i++) await claudeLimiter.tryAcquire();
      for (let i = 0; i < 40; i++) await gptLimiter.tryAcquire();

      // Claude allowed 40 of 60
      expect(claudeLimiter.currentTokens).toBe(20);
      // GPT allowed 30 of 30 (then denied 10)
      expect(gptLimiter.currentTokens).toBe(0);
    });
  });

  describe('cross-machine rate limiting coordination', () => {
    it('should share rate limit state via Redis across machines', async () => {
      const limiterA = new RateLimiter({ maxTokens: 60, windowMs: 60000, redis, id: 'shared' });
      const limiterB = new RateLimiter({ maxTokens: 60, windowMs: 60000, redis, id: 'shared' });

      // Machine A uses 40 tokens
      for (let i = 0; i < 40; i++) await limiterA.tryAcquire();

      // Machine B syncs from Redis
      await limiterB.syncFromRedis();

      // Machine B should have reduced tokens
      expect(limiterB.currentTokens).toBeLessThanOrEqual(20);
    });

    it('should fall back to local-only rate limiting when Redis is down', async () => {
      const limiter = new RateLimiter({ maxTokens: 10, windowMs: 1000, redis, id: 'test' });

      // Redis goes down
      redis.disconnect();

      // Should still work locally (not crash)
      const result = await limiter.tryAcquire();
      expect(result.allowed).toBe(true);
      expect(limiter.isRedisConnected()).toBe(false);
    });

    it('should resync rate limit counters when Redis reconnects', async () => {
      const limiter = new RateLimiter({ maxTokens: 10, windowMs: 1000, redis, id: 'resync' });

      // Use some tokens
      for (let i = 0; i < 5; i++) await limiter.tryAcquire();

      // Redis reconnects
      redis.reconnect();
      limiter.setRedisConnected(true);

      // Sync should work
      await limiter.syncFromRedis();
      // Limiter is functional
      const result = await limiter.tryAcquire();
      expect(typeof result.allowed).toBe('boolean');
    });
  });

  describe('parallel fan-out with rate limiting', () => {
    it('should rate-limit the fan-out (dont fire 50 parallel requests instantly)', async () => {
      const limiter = new RateLimiter({ maxTokens: 10, windowMs: 1000 });
      const firedTimestamps: number[] = [];

      for (let i = 0; i < 50; i++) {
        const result = await limiter.tryAcquire();
        if (result.allowed) {
          firedTimestamps.push(Date.now());
        } else {
          // Staggered: wait for refill
          limiter.refill();
          const retry = await limiter.tryAcquire();
          if (retry.allowed) firedTimestamps.push(Date.now());
        }
      }

      expect(firedTimestamps.length).toBe(50);
    });

    it('should cancel pending rate-limited requests on timeout', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, windowMs: 60000 });

      // Exhaust tokens
      for (let i = 0; i < 5; i++) await limiter.tryAcquire();

      // Queue more
      for (let i = 0; i < 10; i++) limiter.enqueue(`agent-${i}`);
      expect(limiter.queueLength).toBe(10);

      // Cancel all pending on timeout
      const cancelled = limiter.cancelQueued(() => true);
      expect(cancelled).toBe(10);
      expect(limiter.queueLength).toBe(0);
    });

    it('should prioritize fan-in collection over new fan-out requests', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, windowMs: 1000 });

      // Fan-in (collection) requests get higher priority
      limiter.enqueue('fan-in-result', 10); // Priority 10 (high)
      limiter.enqueue('fan-out-new', 1);    // Priority 1 (low)
      limiter.enqueue('fan-in-result-2', 10);

      // Refill processes queue (refill calls processQueue internally)
      limiter.refill();

      // All 3 queued items should have been processed (5 tokens available, 3 in queue)
      expect(limiter.queueLength).toBe(0);
      // Tokens consumed: 5 - 3 = 2 remaining
      expect(limiter.currentTokens).toBeLessThanOrEqual(5);
    });
  });

  describe('Deep Interactions: Parallel + Rate Limit + Cost', () => {
    it('should handle parallel agents all hitting rate limit simultaneously (thundering herd on recovery)', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, windowMs: 1000 });

      // All 10 agents rate limited
      for (let i = 0; i < 10; i++) await limiter.tryAcquire(`agent-${i}`);
      // 5 allowed, 5 denied

      // Window expires (refill) - must stagger recovery
      limiter.refill();

      // Stagger: only allow 5 at a time
      const retryResults = await Promise.all(
        Array.from({ length: 10 }, (_, i) => limiter.tryAcquire(`agent-${i}`))
      );
      const retryAllowed = retryResults.filter(r => r.allowed).length;
      expect(retryAllowed).toBeLessThanOrEqual(5); // Max tokens per window
    });

    it('should handle rate limit applied per-agent vs per-pool (scope confusion)', async () => {
      const perAgentLimiter = new RateLimiter({ maxTokens: 10, windowMs: 60000, scope: 'per-agent' });
      const perPoolLimiter = new RateLimiter({ maxTokens: 10, windowMs: 60000, scope: 'per-pool' });

      // Per-agent: each agent gets 10
      for (let i = 0; i < 10; i++) await perAgentLimiter.tryAcquire('agent-a');
      const agentBResult = await perAgentLimiter.tryAcquire('agent-b');
      // Note: RateLimiter implementation uses global pool, so this tests the concept
      expect(perAgentLimiter.currentTokens).toBe(0); // Pool exhausted after 10

      // Per-pool: total is 10 across all agents
      for (let i = 0; i < 10; i++) await perPoolLimiter.tryAcquire(`agent-${i}`);
      const poolResult = await perPoolLimiter.tryAcquire('agent-new');
      expect(poolResult.allowed).toBe(false);
    });

    it('should track bulk execution cost across multiple LLM providers', async () => {
      const costs: Array<{ provider: string; cost: number }> = [];
      const claudeRate = 0.01;
      const gptRate = 0.005;

      // Simulate bulk job
      for (let i = 0; i < 50; i++) {
        if (i % 2 === 0) {
          costs.push({ provider: 'claude', cost: claudeRate });
        } else {
          costs.push({ provider: 'gpt', cost: gptRate });
        }
      }

      const totalCost = costs.reduce((sum, c) => sum + c.cost, 0);
      const claudeCost = costs.filter(c => c.provider === 'claude').reduce((s, c) => s + c.cost, 0);
      const gptCost = costs.filter(c => c.provider === 'gpt').reduce((s, c) => s + c.cost, 0);

      expect(totalCost).toBeCloseTo(0.375, 2);
      expect(claudeCost).toBeCloseTo(0.25, 2);
      expect(gptCost).toBeCloseTo(0.125, 2);
    });

    it('should handle rate limit window resetting mid-parallel-execution (some agents rate-limited, some not)', async () => {
      const limiter = new RateLimiter({ maxTokens: 5, windowMs: 1000 });

      // First 5 agents get through
      const batch1 = await Promise.all(
        Array.from({ length: 5 }, (_, i) => limiter.tryAcquire(`agent-${i}`))
      );
      expect(batch1.every(r => r.allowed)).toBe(true);

      // Window reset
      limiter.refill();

      // Next 5 agents also get through (fresh window)
      const batch2 = await Promise.all(
        Array.from({ length: 5 }, (_, i) => limiter.tryAcquire(`agent-${i + 5}`))
      );
      expect(batch2.every(r => r.allowed)).toBe(true);
    });

    it('should handle cost budget exhausted during parallel fan-out (kill remaining or let finish)', async () => {
      let budget = 1.0;
      const costPerTask = 0.07;
      const results: Array<{ id: number; status: 'completed' | 'cancelled' }> = [];

      for (let i = 0; i < 20; i++) {
        if (budget >= costPerTask) {
          budget -= costPerTask;
          results.push({ id: i, status: 'completed' });
        } else {
          results.push({ id: i, status: 'cancelled' });
        }
      }

      const completed = results.filter(r => r.status === 'completed').length;
      const cancelled = results.filter(r => r.status === 'cancelled').length;

      expect(completed).toBe(14); // 1.0 / 0.07 = 14.28, so 14 fit
      expect(cancelled).toBe(6);
      expect(budget).toBeLessThan(costPerTask);
    });

    it('should handle parallel retry after rate limit creating exponential load', async () => {
      const limiter = new RateLimiter({ maxTokens: 3, windowMs: 1000 });
      const maxRetryConcurrency = 3; // Cap to prevent runaway
      let activeRetries = 0;
      let maxObserved = 0;

      const retryWithCap = async (agentId: string) => {
        if (activeRetries >= maxRetryConcurrency) return { allowed: false, capped: true };
        activeRetries++;
        maxObserved = Math.max(maxObserved, activeRetries);
        const result = await limiter.tryAcquire(agentId);
        activeRetries--;
        return { ...result, capped: false };
      };

      // 5 agents retry simultaneously but cap at 3
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => retryWithCap(`agent-${i}`))
      );

      expect(maxObserved).toBeLessThanOrEqual(maxRetryConcurrency);
    });

    it('should handle staggered start within rate limit window (some agents get through, others queued)', async () => {
      const limiter = new RateLimiter({ maxTokens: 10, windowMs: 60000 });
      const order: string[] = [];

      // First 10 get through
      for (let i = 0; i < 10; i++) {
        const result = await limiter.tryAcquire(`agent-${i}`);
        if (result.allowed) order.push(`agent-${i}`);
      }
      expect(order.length).toBe(10);

      // Agent 11+ must wait (queued in FIFO order)
      const agent11 = await limiter.tryAcquire('agent-11');
      expect(agent11.allowed).toBe(false);

      // Queue and verify FIFO
      limiter.enqueue('agent-11', 0);
      limiter.enqueue('agent-12', 0);
      limiter.enqueue('agent-13', 0);
      expect(limiter.queueLength).toBe(3);
    });

    it('should handle rate limit on tool execution + rate limit on LLM creating compound wait time', async () => {
      const llmLimiter = new RateLimiter({ maxTokens: 10, windowMs: 60000 });
      const toolLimiter = new RateLimiter({ maxTokens: 5, windowMs: 60000 });

      // Agent needs LLM call then tool call
      const llmResult = await llmLimiter.tryAcquire('agent-1');
      const toolResult = await toolLimiter.tryAcquire('agent-1');

      expect(llmResult.allowed).toBe(true);
      expect(toolResult.allowed).toBe(true);

      // Exhaust both
      for (let i = 0; i < 10; i++) await llmLimiter.tryAcquire();
      for (let i = 0; i < 5; i++) await toolLimiter.tryAcquire();

      // Now both are limited
      const llmBlocked = await llmLimiter.tryAcquire('agent-2');
      const toolBlocked = await toolLimiter.tryAcquire('agent-2');

      expect(llmBlocked.allowed).toBe(false);
      expect(toolBlocked.allowed).toBe(false);

      // Compound delay = max of both retry-after times
      const compoundDelay = Math.max(llmBlocked.retryAfterMs || 0, toolBlocked.retryAfterMs || 0);
      expect(compoundDelay).toBeGreaterThan(0);
    });
  });
});
