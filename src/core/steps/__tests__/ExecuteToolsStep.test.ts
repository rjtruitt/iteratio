import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockToolExecutor, createMockTool } from '../../../__test__/';
import { ExecuteToolsStep } from '../ExecuteToolsStep';
import { StepContext } from '../../../interfaces/IStep';
import type { LLMResponse, ToolCall } from '../../../interfaces/ILLMProvider';

describe('ExecuteToolsStep', () => {
  let step: ExecuteToolsStep;
  let toolExecutor: MockToolExecutor;

  function createContext(overrides: Partial<StepContext> = {}): StepContext {
    return {
      turnNumber: 1,
      messages: [],
      state: {},
      metadata: {},
      shouldContinue: true,
      data: {},
      ...overrides,
    };
  }

  function makeLLMResponse(toolCalls?: ToolCall[]): LLMResponse {
    return {
      content: '',
      tool_calls: toolCalls,
      finish_reason: toolCalls ? 'tool_calls' : 'stop',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
  }

  beforeEach(() => {
    toolExecutor = new MockToolExecutor();
    step = new ExecuteToolsStep(toolExecutor);
  });

  it('should have name "execute-tools"', () => {
    expect(step.name).toBe('execute-tools');
  });

  it('should have priority 300', () => {
    expect(step.priority).toBe(300);
  });

  it('should execute tool calls from context.llmResponse.tool_calls', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{"q":"test"}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    await step.execute(ctx);

    expect(toolExecutor.callCount).toBe(1);
    expect(toolExecutor.calls[0].toolCall.name).toBe('search');
  });

  it('should skip execution via shouldExecute when no tool calls present', () => {
    const ctx = createContext({ llmResponse: makeLLMResponse() });
    expect(step.shouldExecute!(ctx)).toBe(false);
  });

  it('should skip execution via shouldExecute when tool_calls is empty array', () => {
    const ctx = createContext({ llmResponse: makeLLMResponse([]) });
    expect(step.shouldExecute!(ctx)).toBe(false);
  });

  it('should return true from shouldExecute when tool_calls has entries', () => {
    const toolCalls: ToolCall[] = [{ id: 'c1', name: 'foo', arguments: '{}' }];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });
    expect(step.shouldExecute!(ctx)).toBe(true);
  });

  it('should execute multiple tools', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{"q":"a"}' },
      { id: 'call_2', name: 'read_file', arguments: '{"path":"x.ts"}' },
      { id: 'call_3', name: 'write_file', arguments: '{"path":"y.ts","content":"z"}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    await step.execute(ctx);

    expect(toolExecutor.callCount).toBe(3);
  });

  it('should handle tool execution errors by propagating them', async () => {
    toolExecutor = new MockToolExecutor({
      throwOnTool: 'bad_tool',
      throwError: new Error('Tool failed'),
    });
    step = new ExecuteToolsStep(toolExecutor);

    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'bad_tool', arguments: '{}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    await expect(step.execute(ctx)).rejects.toThrow('Tool failed');
  });

  it('should store results in context.toolResults', async () => {
    toolExecutor.setResult('search', { success: true, data: { results: ['a', 'b'] } });
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{"q":"test"}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    const result = await step.execute(ctx);

    expect(result.toolResults).toBeDefined();
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults![0].data).toEqual({ results: ['a', 'b'] });
  });

  it('should execute in parallel mode by default', async () => {
    const executeSpy = vi.spyOn(toolExecutor, 'executeTools');
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'tool_a', arguments: '{}' },
      { id: 'call_2', name: 'tool_b', arguments: '{}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    await step.execute(ctx);

    expect(executeSpy).toHaveBeenCalledWith(
      toolCalls,
      expect.anything(),
      'parallel'
    );
  });

  it('should pass turnNumber in tool context', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{}' },
    ];
    const ctx = createContext({ turnNumber: 5, llmResponse: makeLLMResponse(toolCalls) });

    await step.execute(ctx);

    expect(toolExecutor.calls[0].context.turnNumber).toBe(5);
  });

  it('should pass state in tool context', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{}' },
    ];
    const state = { counter: 3 };
    const ctx = createContext({ state, llmResponse: makeLLMResponse(toolCalls) });

    await step.execute(ctx);

    expect(toolExecutor.calls[0].context.state).toEqual({ counter: 3 });
  });

  it('should pass metadata in tool context', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{}' },
    ];
    const metadata = { requestId: 'abc-123' };
    const ctx = createContext({ metadata, llmResponse: makeLLMResponse(toolCalls) });

    await step.execute(ctx);

    expect(toolExecutor.calls[0].context.metadata).toEqual({ requestId: 'abc-123' });
  });

  it('should return the same context object', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    const result = await step.execute(ctx);
    expect(result).toBe(ctx);
  });

  it('should handle shouldExecute when llmResponse is undefined', () => {
    const ctx = createContext({ llmResponse: undefined });
    expect(step.shouldExecute!(ctx)).toBe(false);
  });

  it('should preserve order of results matching order of tool calls', async () => {
    toolExecutor.setResult('alpha', { success: true, data: { order: 1 } });
    toolExecutor.setResult('beta', { success: true, data: { order: 2 } });

    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'alpha', arguments: '{}' },
      { id: 'call_2', name: 'beta', arguments: '{}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    const result = await step.execute(ctx);

    expect(result.toolResults![0].data).toEqual({ order: 1 });
    expect(result.toolResults![1].data).toEqual({ order: 2 });
  });

  it('should handle tool that returns success: false', async () => {
    toolExecutor.setResult('fail_tool', { success: false, data: null, error: 'Permission denied' });

    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'fail_tool', arguments: '{}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    const result = await step.execute(ctx);

    expect(result.toolResults![0].success).toBe(false);
    expect(result.toolResults![0].error).toBe('Permission denied');
  });

  it('should pass tool arguments as string in tool call', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{"query":"hello world","limit":10}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    await step.execute(ctx);

    expect(toolExecutor.calls[0].toolCall.arguments).toBe('{"query":"hello world","limit":10}');
  });

  it('should not modify context.shouldContinue', async () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search', arguments: '{}' },
    ];
    const ctx = createContext({ shouldContinue: true, llmResponse: makeLLMResponse(toolCalls) });

    const result = await step.execute(ctx);
    expect(result.shouldContinue).toBe(true);
  });

  it('should handle a single tool call that returns large data', async () => {
    const largeData = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i, value: `item_${i}` })) };
    toolExecutor.setResult('big_query', { success: true, data: largeData });

    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'big_query', arguments: '{}' },
    ];
    const ctx = createContext({ llmResponse: makeLLMResponse(toolCalls) });

    const result = await step.execute(ctx);
    expect(result.toolResults![0].data.items).toHaveLength(1000);
  });
});
