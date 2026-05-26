import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnManager, TurnConfig } from '../TurnManager';
import type { Message, LoopState, ToolCall, ToolResult, LLMResponse } from '../../types/index';

function createToolCallResponse(toolCalls: ToolCall[]): LLMResponse {
  return {
    content: '',
    toolCalls,
    stopReason: 'tool_use',
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  };
}

function createHookTestConfig(overrides: Partial<TurnConfig> = {}): TurnConfig {
  return {
    sendRequest: vi.fn().mockResolvedValue({
      content: 'response',
      toolCalls: [{ id: 'tc-1', name: 'testTool', arguments: { x: 1 } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
    executeTool: vi.fn().mockResolvedValue({ success: true, data: { result: 'ok' } }),
    turnTimeout: 30000,
    ...overrides,
  };
}

describe('TurnManager - Lifecycle Hooks', () => {
  describe('onToolCall hook', () => {
    it('is called before tool execution', async () => {
      const callOrder: string[] = [];
      const config = createHookTestConfig({
        onToolCall: vi.fn().mockImplementation(async () => {
          callOrder.push('onToolCall');
        }),
        executeTool: vi.fn().mockImplementation(async () => {
          callOrder.push('executeTool');
          return { success: true };
        }),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(callOrder.indexOf('onToolCall')).toBeLessThan(callOrder.indexOf('executeTool'));
    });

    it('receives the tool call object', async () => {
      const onToolCall = vi.fn().mockResolvedValue(undefined);
      const config = createHookTestConfig({ onToolCall });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tc-1', name: 'testTool', arguments: { x: 1 } }),
        expect.anything()
      );
    });

    it('receives the current state', async () => {
      const onToolCall = vi.fn().mockResolvedValue(undefined);
      const state: LoopState = { mode: 'testing', count: 5 };
      const config = createHookTestConfig({ onToolCall });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], state);

      expect(onToolCall).toHaveBeenCalledWith(expect.anything(), state);
    });

    it('is called for each tool call when multiple tools are invoked', async () => {
      const onToolCall = vi.fn().mockResolvedValue(undefined);
      const config = createHookTestConfig({
        onToolCall,
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse([
          { id: 'tc-1', name: 'toolA', arguments: {} },
          { id: 'tc-2', name: 'toolB', arguments: {} },
          { id: 'tc-3', name: 'toolC', arguments: {} },
        ])),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(onToolCall).toHaveBeenCalledTimes(3);
    });
  });

  describe('onToolResult hook', () => {
    it('is called after tool execution', async () => {
      const callOrder: string[] = [];
      const config = createHookTestConfig({
        onToolResult: vi.fn().mockImplementation(async () => {
          callOrder.push('onToolResult');
        }),
        executeTool: vi.fn().mockImplementation(async () => {
          callOrder.push('executeTool');
          return { success: true, data: { x: 1 } };
        }),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(callOrder.indexOf('executeTool')).toBeLessThan(callOrder.indexOf('onToolResult'));
    });

    it('receives the tool call and the result', async () => {
      const onToolResult = vi.fn().mockResolvedValue(undefined);
      const toolResult: ToolResult = { success: true, data: { computed: 99 } };
      const config = createHookTestConfig({
        onToolResult,
        executeTool: vi.fn().mockResolvedValue(toolResult),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(onToolResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tc-1', name: 'testTool' }),
        toolResult,
        expect.anything()
      );
    });

    it('receives the current state', async () => {
      const onToolResult = vi.fn().mockResolvedValue(undefined);
      const state: LoopState = { session: 'xyz' };
      const config = createHookTestConfig({ onToolResult });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], state);

      expect(onToolResult).toHaveBeenCalledWith(expect.anything(), expect.anything(), state);
    });

    it('is called even when tool returns an error result', async () => {
      const onToolResult = vi.fn().mockResolvedValue(undefined);
      const config = createHookTestConfig({
        onToolResult,
        executeTool: vi.fn().mockResolvedValue({ success: false, error: 'Oops' }),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(onToolResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ success: false, error: 'Oops' }),
        expect.anything()
      );
    });
  });

  describe('onError hook', () => {
    it('is called when sendRequest fails', async () => {
      const onError = vi.fn().mockResolvedValue(false);
      const config = createHookTestConfig({
        onError,
        sendRequest: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        'request',
        expect.anything()
      );
    });

    it('is called when tool execution throws', async () => {
      const onError = vi.fn().mockResolvedValue(false);
      const config = createHookTestConfig({
        onError,
        executeTool: vi.fn().mockRejectedValue(new Error('Tool crashed')),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        'tool',
        expect.anything()
      );
    });

    it('receives the error object', async () => {
      const specificError = new Error('Specific failure reason');
      const onError = vi.fn().mockResolvedValue(false);
      const config = createHookTestConfig({
        onError,
        sendRequest: vi.fn().mockRejectedValue(specificError),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(onError).toHaveBeenCalledWith(specificError, expect.anything(), expect.anything());
    });

    it('receives the correct context string for request errors', async () => {
      const onError = vi.fn().mockResolvedValue(false);
      const config = createHookTestConfig({
        onError,
        sendRequest: vi.fn().mockRejectedValue(new Error('fail')),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(onError).toHaveBeenCalledWith(expect.anything(), 'request', expect.anything());
    });

    it('receives the state', async () => {
      const onError = vi.fn().mockResolvedValue(false);
      const state: LoopState = { important: 'data' };
      const config = createHookTestConfig({
        onError,
        sendRequest: vi.fn().mockRejectedValue(new Error('fail')),
      });
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Hi' }], state);

      expect(onError).toHaveBeenCalledWith(expect.anything(), expect.anything(), state);
    });

    it('hook exception is swallowed and not propagated to caller', async () => {
      const onError = vi.fn().mockRejectedValue(new Error('Hook itself exploded'));
      const config = createHookTestConfig({
        onError,
        sendRequest: vi.fn().mockRejectedValue(new Error('original error')),
      });
      const manager = new TurnManager(config);

      // Should not throw even though onError throws
      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.error?.message).toBe('original error');
    });
  });

  describe('hooks are optional', () => {
    it('no onToolCall hook does not crash during tool execution', async () => {
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(
          createToolCallResponse([{ id: 'tc-1', name: 'tool', arguments: {} }])
        ),
        executeTool: vi.fn().mockResolvedValue({ success: true }),
        turnTimeout: 30000,
        // onToolCall intentionally omitted
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.toolResults?.get('tc-1')).toEqual({ success: true });
    });

    it('no onToolResult hook does not crash after tool execution', async () => {
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(
          createToolCallResponse([{ id: 'tc-1', name: 'tool', arguments: {} }])
        ),
        executeTool: vi.fn().mockResolvedValue({ success: true, data: 'done' }),
        turnTimeout: 30000,
        // onToolResult intentionally omitted
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.error).toBeUndefined();
    });

    it('no onError hook does not crash when request fails', async () => {
      const config: TurnConfig = {
        sendRequest: vi.fn().mockRejectedValue(new Error('Boom')),
        executeTool: vi.fn(),
        turnTimeout: 30000,
        // onError intentionally omitted
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.error?.message).toBe('Boom');
    });

    it('all hooks undefined simultaneously works fine', async () => {
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue({
          content: 'ok',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
        executeTool: vi.fn(),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Hi' }], {});

      expect(result.response?.content).toBe('ok');
    });
  });
});
