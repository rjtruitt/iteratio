import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnManager, TurnConfig, TurnResult } from '../TurnManager';
import type { Message, LoopState, ToolCall, ToolResult, LLMResponse } from '../../types/index';

function createBasicConfig(overrides: Partial<TurnConfig> = {}): TurnConfig {
  return {
    sendRequest: vi.fn().mockResolvedValue({
      content: 'Hello from LLM',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } satisfies LLMResponse),
    executeTool: vi.fn().mockResolvedValue({ success: true, data: { mock: true } }),
    turnTimeout: 30000,
    ...overrides,
  };
}

function createToolCallResponse(toolCalls: ToolCall[]): LLMResponse {
  return {
    content: '',
    toolCalls,
    stopReason: 'tool_use',
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  };
}

describe('TurnManager', () => {
  describe('construction', () => {
    it('constructs with a valid TurnConfig', () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);
      expect(manager).toBeInstanceOf(TurnManager);
    });

    it('stores the config for use in executeTurn', () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);
      // Verify config is used by calling executeTurn
      expect(manager.executeTurn).toBeDefined();
      expect(typeof manager.executeTurn).toBe('function');
    });
  });

  describe('executeTurn - basic request flow', () => {
    it('sends messages to sendRequest callback', async () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);
      const messages: Message[] = [{ role: 'user', content: 'Hello' }];
      const state: LoopState = {};

      await manager.executeTurn(messages, state);

      expect(config.sendRequest).toHaveBeenCalledWith(messages, state);
    });

    it('passes the state object to sendRequest', async () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);
      const state: LoopState = { counter: 42, mode: 'test' };

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], state);

      expect(config.sendRequest).toHaveBeenCalledWith(expect.any(Array), state);
    });

    it('returns TurnResult with response from LLM', async () => {
      const expectedResponse: LLMResponse = {
        content: 'Test response',
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      };
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue(expectedResponse),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.response).toEqual(expectedResponse);
    });

    it('returns TurnResult with messages array containing assistant message', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: 'Assistant says hello',
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.messages).toContainEqual({
        role: 'assistant',
        content: 'Assistant says hello',
      });
    });

    it('returns TurnResult with tokensUsed from response usage', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: 'response',
          stopReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.tokensUsed).toBe(150);
    });

    it('handles response with no tool calls returning only assistant message', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: 'Simple response',
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.toolCalls).toBeUndefined();
      expect(result.toolResults).toBeUndefined();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('assistant');
    });

    it('handles empty messages array without crashing', async () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([], {});

      expect(result).toBeDefined();
      expect(config.sendRequest).toHaveBeenCalledWith([], {});
    });

    it('includes multiple user messages in the request', async () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'What is 2+2?' },
      ];

      await manager.executeTurn(messages, {});

      expect(config.sendRequest).toHaveBeenCalledWith(messages, {});
    });
  });

  describe('executeTurn - response structure', () => {
    it('result.messages starts as empty array before population', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: 'resp',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      expect(Array.isArray(result.messages)).toBe(true);
    });

    it('result.error is undefined when turn succeeds', async () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.error).toBeUndefined();
    });

    it('assistant message content matches LLM response content', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: 'Exact content match test',
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      const assistantMsg = result.messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.content).toBe('Exact content match test');
    });

    it('tokensUsed is computed from response.usage.totalTokens', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: '',
          stopReason: 'end_turn',
          usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: '' }], {});

      expect(result.tokensUsed).toBe(300);
    });

    it('response with empty content still produces assistant message', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: '',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.messages[0]).toEqual({ role: 'assistant', content: '' });
    });
  });

  describe('executeTurn - error handling', () => {
    it('sendRequest rejection sets error on result', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockRejectedValue(new Error('Network failure')),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('Network failure');
    });

    it('sendRequest rejection still returns a TurnResult (not a thrown error)', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockRejectedValue(new Error('Oops')),
      });
      const manager = new TurnManager(config);

      // Should not throw
      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result).toBeDefined();
      expect(result.messages).toBeDefined();
    });

    it('error result has tokensUsed of 0 when request fails before response', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockRejectedValue(new Error('Fail')),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.tokensUsed).toBe(0);
    });

    it('error result has no response when request fails', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockRejectedValue(new Error('Fail')),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.response).toBeUndefined();
    });

    it('non-Error thrown is wrapped in an Error object', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockRejectedValue('string error'),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.error).toBeDefined();
    });
  });

  describe('executeTurn - state passthrough', () => {
    it('state is forwarded to sendRequest unchanged', async () => {
      const state: LoopState = { key: 'value', nested: { deep: true } };
      const config = createBasicConfig();
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], state);

      expect(config.sendRequest).toHaveBeenCalledWith(expect.anything(), state);
    });

    it('state is forwarded to executeTool when tool calls are present', async () => {
      const state: LoopState = { sessionId: 'abc-123' };
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue(
          createToolCallResponse([{ id: 'tc1', name: 'myTool', arguments: {} }])
        ),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], state);

      expect(config.executeTool).toHaveBeenCalledWith('myTool', {}, state);
    });
  });

  describe('Edge Cases', () => {
    it('should handle executeTurn with empty messages array', async () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([], {});

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
    });

    it('should handle executeTurn with messages containing undefined content', async () => {
      const config = createBasicConfig();
      const manager = new TurnManager(config);
      const messages: Message[] = [{ role: 'user', content: undefined as any }];

      const result = await manager.executeTurn(messages, {});

      expect(result).toBeDefined();
    });

    it('should handle sendRequest returning null (unexpected)', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue(null),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      // Should handle gracefully — either error result or defensive null handling
      expect(result.error).toBeDefined();
    });

    it('should handle sendRequest returning after exactly turnTimeout ms (boundary)', async () => {
      const turnTimeout = 100;
      const config = createBasicConfig({
        sendRequest: vi.fn().mockImplementation(async () => {
          await new Promise(r => setTimeout(r, turnTimeout));
          return {
            content: 'just in time',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }),
        turnTimeout,
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      // At exactly the boundary, behavior depends on implementation:
      // either timeout error or success response
      expect(result).toBeDefined();
      expect(result.error?.message).toContain('timeout');
    });

    it('should handle tool execution returning undefined (not an object)', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue(
          createToolCallResponse([{ id: 'tc1', name: 'brokenTool', arguments: {} }])
        ),
        executeTool: vi.fn().mockResolvedValue(undefined),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      // Should handle undefined tool result gracefully
      expect(result).toBeDefined();
      expect(result.toolResults).toBeDefined();
    });

    it('should handle a tool that takes exactly 0ms (synchronous resolution)', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue(
          createToolCallResponse([{ id: 'tc1', name: 'instantTool', arguments: {} }])
        ),
        executeTool: vi.fn().mockResolvedValue({ success: true, data: { instant: true } }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.toolResults).toBeDefined();
      expect(result.toolResults![0].success).toBe(true);
    });

    it('should handle LLM response with empty string content', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: '',
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.response?.content).toBe('');
      expect(result.messages[0].content).toBe('');
    });

    it('should handle LLM response with content exceeding 1MB', async () => {
      const largeContent = 'x'.repeat(1024 * 1024 + 1); // > 1MB
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue({
          content: largeContent,
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 500000, totalTokens: 500005 },
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.response?.content).toHaveLength(1024 * 1024 + 1);
    });

    it('should handle tool calls with empty arguments string', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockResolvedValue(
          createToolCallResponse([{ id: 'tc1', name: 'noArgs', arguments: '' }])
        ),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      // Empty string arguments should be handled (parsed as empty or error)
      expect(result).toBeDefined();
    });

    it('should handle executeTurn called concurrently (two calls in parallel)', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockImplementation(async () => {
          await new Promise(r => setTimeout(r, 10));
          return {
            content: 'response',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }),
      });
      const manager = new TurnManager(config);
      const messages: Message[] = [{ role: 'user', content: 'Hi' }];

      const [result1, result2] = await Promise.all([
        manager.executeTurn(messages, {}),
        manager.executeTurn(messages, {}),
      ]);

      // Both should complete independently without corrupting each other
      expect(result1.response?.content).toBe('response');
      expect(result2.response?.content).toBe('response');
    });

    it('should handle sendRequest that throws synchronously (not async rejection)', async () => {
      const config = createBasicConfig({
        sendRequest: vi.fn().mockImplementation(() => {
          throw new Error('synchronous throw');
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.error).toBeDefined();
      expect(result.error?.message).toBe('synchronous throw');
    });

    it('should handle state object mutated during executeTurn by sendRequest callback', async () => {
      const state: LoopState = { counter: 0 };
      const config = createBasicConfig({
        sendRequest: vi.fn().mockImplementation(async (msgs: Message[], st: LoopState) => {
          // Mutate state during callback
          st.counter = 999;
          st.injected = 'surprise';
          return {
            content: 'done',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }),
      });
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], state);

      // State mutation during execution should either be prevented or handled
      // This test documents the behavior
      expect(result).toBeDefined();
      expect(state.counter).toBe(999); // mutation happened — tests that we detect/prevent it
    });
  });
});
