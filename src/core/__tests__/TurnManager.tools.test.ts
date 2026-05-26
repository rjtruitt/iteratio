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

function createConfigWithToolResponse(
  toolCalls: ToolCall[],
  toolResults?: Map<string, ToolResult>,
  overrides: Partial<TurnConfig> = {}
): TurnConfig {
  const resultMap = toolResults ?? new Map();
  return {
    sendRequest: vi.fn().mockResolvedValue(createToolCallResponse(toolCalls)),
    executeTool: vi.fn().mockImplementation((name: string) => {
      const result = resultMap.get(name);
      return Promise.resolve(result ?? { success: true, data: { tool: name } });
    }),
    turnTimeout: 30000,
    ...overrides,
  };
}

describe('TurnManager - Tool Execution', () => {
  describe('single tool call', () => {
    it('executes the tool specified in the LLM response', async () => {
      const toolCall: ToolCall = { id: 'call-1', name: 'readFile', arguments: { path: '/tmp/x' } };
      const config = createConfigWithToolResponse([toolCall]);
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Read file' }], {});

      expect(config.executeTool).toHaveBeenCalledWith('readFile', { path: '/tmp/x' }, {});
    });

    it('includes tool call in result.toolCalls', async () => {
      const toolCall: ToolCall = { id: 'call-1', name: 'search', arguments: { query: 'test' } };
      const config = createConfigWithToolResponse([toolCall]);
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Search' }], {});

      expect(result.toolCalls).toEqual([toolCall]);
    });

    it('maps tool result by call ID in toolResults', async () => {
      const toolCall: ToolCall = { id: 'call-abc', name: 'compute', arguments: {} };
      const expectedResult: ToolResult = { success: true, data: { answer: 42 } };
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse([toolCall])),
        executeTool: vi.fn().mockResolvedValue(expectedResult),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Compute' }], {});

      expect(result.toolResults).toBeInstanceOf(Map);
      expect(result.toolResults?.get('call-abc')).toEqual(expectedResult);
    });

    it('passes tool arguments correctly to executeTool', async () => {
      const complexArgs = { path: '/home/user', recursive: true, filters: ['*.ts'] };
      const toolCall: ToolCall = { id: 'tc-1', name: 'listFiles', arguments: complexArgs };
      const config = createConfigWithToolResponse([toolCall]);
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'list' }], {});

      expect(config.executeTool).toHaveBeenCalledWith('listFiles', complexArgs, {});
    });
  });

  describe('multiple tool calls', () => {
    it('executes all tool calls in the response', async () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc-1', name: 'toolA', arguments: { x: 1 } },
        { id: 'tc-2', name: 'toolB', arguments: { y: 2 } },
        { id: 'tc-3', name: 'toolC', arguments: { z: 3 } },
      ];
      const config = createConfigWithToolResponse(toolCalls);
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'Do all' }], {});

      expect(config.executeTool).toHaveBeenCalledTimes(3);
    });

    it('maps each tool call ID to its result', async () => {
      const toolCalls: ToolCall[] = [
        { id: 'id-alpha', name: 'alpha', arguments: {} },
        { id: 'id-beta', name: 'beta', arguments: {} },
      ];
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse(toolCalls)),
        executeTool: vi.fn().mockImplementation((name: string) => {
          return Promise.resolve({ success: true, data: { from: name } });
        }),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'Go' }], {});

      expect(result.toolResults?.get('id-alpha')).toEqual({ success: true, data: { from: 'alpha' } });
      expect(result.toolResults?.get('id-beta')).toEqual({ success: true, data: { from: 'beta' } });
    });

    it('creates a tool message for each tool call result', async () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc-1', name: 'toolA', arguments: {} },
        { id: 'tc-2', name: 'toolB', arguments: {} },
      ];
      const config = createConfigWithToolResponse(toolCalls);
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      const toolMessages = result.messages.filter(m => m.role === 'tool');
      expect(toolMessages).toHaveLength(2);
    });

    it('preserves order of tool calls in execution', async () => {
      const executionOrder: string[] = [];
      const toolCalls: ToolCall[] = [
        { id: 'tc-1', name: 'first', arguments: {} },
        { id: 'tc-2', name: 'second', arguments: {} },
        { id: 'tc-3', name: 'third', arguments: {} },
      ];
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse(toolCalls)),
        executeTool: vi.fn().mockImplementation((name: string) => {
          executionOrder.push(name);
          return Promise.resolve({ success: true });
        }),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      expect(executionOrder).toEqual(['first', 'second', 'third']);
    });
  });

  describe('tool error handling', () => {
    it('tool that returns error result is still included in toolResults', async () => {
      const toolCall: ToolCall = { id: 'tc-err', name: 'failingTool', arguments: {} };
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse([toolCall])),
        executeTool: vi.fn().mockResolvedValue({ success: false, error: 'Something broke' }),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      expect(result.toolResults?.get('tc-err')).toEqual({ success: false, error: 'Something broke' });
    });

    it('tool that throws is caught and produces error result', async () => {
      const toolCall: ToolCall = { id: 'tc-throw', name: 'throwingTool', arguments: {} };
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse([toolCall])),
        executeTool: vi.fn().mockRejectedValue(new Error('Unexpected crash')),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      // Should not propagate as an uncaught error
      expect(result.error).toBeDefined();
    });

    it('partial tool failure - some succeed and some fail', async () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc-ok', name: 'goodTool', arguments: {} },
        { id: 'tc-bad', name: 'badTool', arguments: {} },
        { id: 'tc-ok2', name: 'goodTool2', arguments: {} },
      ];
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse(toolCalls)),
        executeTool: vi.fn().mockImplementation((name: string) => {
          if (name === 'badTool') {
            return Promise.resolve({ success: false, error: 'Failed' });
          }
          return Promise.resolve({ success: true, data: { tool: name } });
        }),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      expect(result.toolResults?.get('tc-ok')?.success).toBe(true);
      expect(result.toolResults?.get('tc-bad')?.success).toBe(false);
      expect(result.toolResults?.get('tc-ok2')?.success).toBe(true);
    });

    it('tool error result generates error message content in tool message', async () => {
      const toolCall: ToolCall = { id: 'tc-err', name: 'errorTool', arguments: {} };
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse([toolCall])),
        executeTool: vi.fn().mockResolvedValue({ success: false, error: 'Permission denied' }),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      const toolMsg = result.messages.find(m => m.role === 'tool');
      expect(toolMsg?.content).toContain('Error');
      expect(toolMsg?.content).toContain('Permission denied');
    });
  });

  describe('tool result messages', () => {
    it('tool message has role "tool"', async () => {
      const toolCall: ToolCall = { id: 'tc-1', name: 'myTool', arguments: {} };
      const config = createConfigWithToolResponse([toolCall]);
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      const toolMsg = result.messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg?.role).toBe('tool');
    });

    it('tool message has tool_call_id set to the call ID', async () => {
      const toolCall: ToolCall = { id: 'unique-call-id-xyz', name: 'myTool', arguments: {} };
      const config = createConfigWithToolResponse([toolCall]);
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      const toolMsg = result.messages.find(m => m.role === 'tool');
      expect(toolMsg?.tool_call_id).toBe('unique-call-id-xyz');
    });

    it('tool message has name set to the tool name', async () => {
      const toolCall: ToolCall = { id: 'tc-1', name: 'searchDatabase', arguments: {} };
      const config = createConfigWithToolResponse([toolCall]);
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      const toolMsg = result.messages.find(m => m.role === 'tool');
      expect(toolMsg?.name).toBe('searchDatabase');
    });

    it('successful tool result content is JSON stringified data', async () => {
      const toolCall: ToolCall = { id: 'tc-1', name: 'getData', arguments: {} };
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue(createToolCallResponse([toolCall])),
        executeTool: vi.fn().mockResolvedValue({ success: true, data: { items: [1, 2, 3] } }),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      const toolMsg = result.messages.find(m => m.role === 'tool');
      expect(toolMsg?.content).toBe(JSON.stringify({ items: [1, 2, 3] }));
    });

    it('messages array has assistant message first, then tool messages', async () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc-1', name: 'tool1', arguments: {} },
        { id: 'tc-2', name: 'tool2', arguments: {} },
      ];
      const config = createConfigWithToolResponse(toolCalls);
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      expect(result.messages[0].role).toBe('assistant');
      expect(result.messages[1].role).toBe('tool');
      expect(result.messages[2].role).toBe('tool');
    });
  });

  describe('edge cases', () => {
    it('response with empty toolCalls array is treated as no tool calls', async () => {
      const config: TurnConfig = {
        sendRequest: vi.fn().mockResolvedValue({
          content: 'No tools needed',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        }),
        executeTool: vi.fn(),
        turnTimeout: 30000,
      };
      const manager = new TurnManager(config);

      const result = await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      expect(config.executeTool).not.toHaveBeenCalled();
      expect(result.toolCalls).toBeUndefined();
    });

    it('tool with undefined arguments passes undefined to executeTool', async () => {
      const toolCall: ToolCall = { id: 'tc-1', name: 'noArgs', arguments: undefined as unknown };
      const config = createConfigWithToolResponse([toolCall]);
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      expect(config.executeTool).toHaveBeenCalledWith('noArgs', undefined, {});
    });

    it('tool call with null arguments passes null to executeTool', async () => {
      const toolCall: ToolCall = { id: 'tc-1', name: 'nullArgs', arguments: null };
      const config = createConfigWithToolResponse([toolCall]);
      const manager = new TurnManager(config);

      await manager.executeTurn([{ role: 'user', content: 'x' }], {});

      expect(config.executeTool).toHaveBeenCalledWith('nullArgs', null, {});
    });
  });
});
