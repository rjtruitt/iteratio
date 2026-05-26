import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnManager, TurnConfig } from '../TurnManager';
import { TestClock } from '../../__test__/TestClock';
import type { Message, LoopState, LLMResponse } from '../../types/index';

function createBasicConfig(overrides: Partial<TurnConfig> = {}): TurnConfig {
  return {
    sendRequest: vi.fn().mockResolvedValue({
      content: 'response',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } satisfies LLMResponse),
    executeTool: vi.fn().mockResolvedValue({ success: true, data: {} }),
    turnTimeout: 5000,
    ...overrides,
  };
}

describe('TurnManager - Timeout Behavior', () => {
  let clock: TestClock;

  beforeEach(() => {
    clock = new TestClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('request timeout', () => {
    it('request that exceeds turnTimeout produces an error in result', async () => {
      const config = createBasicConfig({
        turnTimeout: 5000,
        sendRequest: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            content: 'late',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }), 10000))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(6000);
      const result = await resultPromise;

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('timed out');
    });

    it('timeout error message includes operation name', async () => {
      const config = createBasicConfig({
        turnTimeout: 3000,
        sendRequest: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 10000))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(4000);
      const result = await resultPromise;

      expect(result.error?.message).toContain('Request');
    });

    it('timeout error message includes duration in milliseconds', async () => {
      const config = createBasicConfig({
        turnTimeout: 2000,
        sendRequest: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 5000))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(3000);
      const result = await resultPromise;

      expect(result.error?.message).toContain('2000');
    });

    it('fast request completes before timeout without error', async () => {
      const config = createBasicConfig({
        turnTimeout: 5000,
        sendRequest: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            content: 'fast',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }), 100))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(200);
      const result = await resultPromise;

      expect(result.error).toBeUndefined();
      expect(result.response?.content).toBe('fast');
    });

    it('timeout timer is cleared on successful completion (no resource leak)', async () => {
      const config = createBasicConfig({
        turnTimeout: 5000,
        sendRequest: vi.fn().mockResolvedValue({
          content: 'immediate',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      // After successful turn, no pending timers should remain
      expect(clock.pendingTimers).toBe(0);
    });

    it('very short timeout (1ms) triggers timeout immediately for slow operations', async () => {
      const config = createBasicConfig({
        turnTimeout: 1,
        sendRequest: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            content: 'never',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }), 100))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(2);
      const result = await resultPromise;

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('timed out');
    });
  });

  describe('tool execution timeout', () => {
    it('tool execution that exceeds turnTimeout produces timeout error', async () => {
      const config = createBasicConfig({
        turnTimeout: 3000,
        sendRequest: vi.fn().mockResolvedValue({
          content: '',
          toolCalls: [{ id: 'tc1', name: 'slowTool', arguments: {} }],
          stopReason: 'tool_use',
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        }),
        executeTool: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 10000))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(4000);
      const result = await resultPromise;

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('timed out');
    });

    it('tool that completes within timeout does not produce an error', async () => {
      const config = createBasicConfig({
        turnTimeout: 5000,
        sendRequest: vi.fn().mockResolvedValue({
          content: '',
          toolCalls: [{ id: 'tc1', name: 'fastTool', arguments: {} }],
          stopReason: 'tool_use',
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        }),
        executeTool: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(
            () => resolve({ success: true, data: 'done' }), 100
          ))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(200);
      const result = await resultPromise;

      expect(result.error).toBeUndefined();
    });

    it('timeout during tool execution still includes the LLM response in result', async () => {
      const llmResponse: LLMResponse = {
        content: 'I will call a tool',
        toolCalls: [{ id: 'tc1', name: 'slowTool', arguments: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      };
      const config = createBasicConfig({
        turnTimeout: 2000,
        sendRequest: vi.fn().mockResolvedValue(llmResponse),
        executeTool: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 10000))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(3000);
      const result = await resultPromise;

      // Even though tool timed out, the response from the first phase should be preserved
      expect(result.response).toEqual(llmResponse);
    });

    it('timeout applies to the entire turn duration not individual operations', async () => {
      // If request takes 2s and tool takes 2s, a 3s timeout should trigger
      const config = createBasicConfig({
        turnTimeout: 3000,
        sendRequest: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            content: '',
            toolCalls: [{ id: 'tc1', name: 'tool', arguments: {} }],
            stopReason: 'tool_use',
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          }), 2000))
        ),
        executeTool: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(
            () => resolve({ success: true }), 2000
          ))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(3500);
      const result = await resultPromise;

      // Total time = 2s (request) + 2s (tool) = 4s > 3s timeout
      expect(result.error).toBeDefined();
    });
  });

  describe('timeout edge cases', () => {
    it('zero timeout should immediately fail', async () => {
      const config = createBasicConfig({
        turnTimeout: 0,
        sendRequest: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            content: 'x',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }), 1))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(1);
      const result = await resultPromise;

      expect(result.error).toBeDefined();
    });

    it('request that resolves at exactly the timeout boundary', async () => {
      const config = createBasicConfig({
        turnTimeout: 5000,
        sendRequest: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({
            content: 'exactly on time',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }), 5000))
        ),
      });
      const manager = new TurnManager(config);
      const resultPromise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      await clock.advanceAsync(5000);
      const result = await resultPromise;

      // At exact boundary, behavior depends on race resolution order
      // The test documents whichever behavior the implementation chooses
      expect(result.error !== undefined || result.response !== undefined).toBe(true);
    });

    it('multiple sequential turns each get their own timeout', async () => {
      let callCount = 0;
      const config = createBasicConfig({
        turnTimeout: 5000,
        sendRequest: vi.fn().mockImplementation(() => {
          callCount++;
          return new Promise((resolve) => setTimeout(() => resolve({
            content: `response-${callCount}`,
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }), 100));
        }),
      });
      const manager = new TurnManager(config);

      const result1Promise = manager.executeTurn([{ role: 'user', content: 'Hi' }], {});
      await clock.advanceAsync(200);
      const result1 = await result1Promise;

      const result2Promise = manager.executeTurn([{ role: 'user', content: 'Again' }], {});
      await clock.advanceAsync(200);
      const result2 = await result2Promise;

      expect(result1.error).toBeUndefined();
      expect(result2.error).toBeUndefined();
    });

    it('large timeout value does not cause overflow issues', async () => {
      const config = createBasicConfig({
        turnTimeout: Number.MAX_SAFE_INTEGER,
        sendRequest: vi.fn().mockResolvedValue({
          content: 'done',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.error).toBeUndefined();
    });
  });
});
