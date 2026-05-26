import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLLMProvider, MockToolExecutor, createMockTool } from '../../../__test__/';
import { CallLLMStep } from '../CallLLMStep';
import { StepContext } from '../../../interfaces/IStep';
import type { LLMResponse } from '../../../interfaces/ILLMProvider';

describe('CallLLMStep', () => {
  let step: CallLLMStep;
  let llmProvider: MockLLMProvider;
  let toolExecutor: MockToolExecutor;

  function createContext(overrides: Partial<StepContext> = {}): StepContext {
    return {
      turnNumber: 1,
      messages: [{ role: 'user', content: 'Hello' }],
      state: {},
      metadata: {},
      shouldContinue: true,
      data: {},
      ...overrides,
    };
  }

  beforeEach(() => {
    llmProvider = new MockLLMProvider();
    toolExecutor = new MockToolExecutor();
    step = new CallLLMStep(llmProvider, toolExecutor);
  });

  it('should have name "call-llm"', () => {
    expect(step.name).toBe('call-llm');
  });

  it('should have priority 200', () => {
    expect(step.priority).toBe(200);
  });

  it('should send messages to LLM provider', async () => {
    const messages = [
      { role: 'system' as const, content: 'Be helpful' },
      { role: 'user' as const, content: 'What is 2+2?' },
    ];
    const ctx = createContext({ messages });

    await step.execute(ctx);

    expect(llmProvider.callCount).toBe(1);
    expect(llmProvider.calls[0].messages).toEqual(messages);
  });

  it('should set context.llmResponse from LLM response', async () => {
    const response = MockLLMProvider.simpleResponse('The answer is 4');
    llmProvider = new MockLLMProvider({ defaultResponse: response });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.llmResponse).toBeDefined();
    expect(result.llmResponse.content).toBe('The answer is 4');
  });

  it('should handle tool_calls in response', async () => {
    const toolCallResponse = MockLLMProvider.toolCallResponse([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"NYC"}' },
    ]);
    llmProvider = new MockLLMProvider({ defaultResponse: toolCallResponse });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.llmResponse.tool_calls).toHaveLength(1);
    expect(result.llmResponse.tool_calls[0].name).toBe('get_weather');
  });

  it('should handle stop response with no tool calls', async () => {
    const response = MockLLMProvider.simpleResponse('Done');
    llmProvider = new MockLLMProvider({ defaultResponse: response });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.llmResponse.finish_reason).toBe('stop');
    expect(result.llmResponse.tool_calls).toBeUndefined();
  });

  it('should propagate errors from LLM provider', async () => {
    const error = new Error('LLM service unavailable');
    llmProvider = new MockLLMProvider({ throwOnCall: 0, throwError: error });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    await expect(step.execute(ctx)).rejects.toThrow('LLM service unavailable');
  });

  it('should pass tool definitions to LLM when tools are registered', async () => {
    const tool = createMockTool('search');
    toolExecutor.registerTool(tool);
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    await step.execute(ctx);

    expect(llmProvider.calls[0].options?.tools).toBeDefined();
    expect(llmProvider.calls[0].options!.tools!.length).toBeGreaterThan(0);
    expect(llmProvider.calls[0].options!.tools![0].name).toBe('search');
  });

  it('should not pass tools when no tools are registered', async () => {
    const ctx = createContext();
    await step.execute(ctx);

    expect(llmProvider.calls[0].options?.tools).toBeUndefined();
  });

  it('should store model info in context.metadata.llmModel', async () => {
    const response: LLMResponse = {
      content: 'Hi',
      finish_reason: 'stop',
      model: 'gpt-4',
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    };
    llmProvider = new MockLLMProvider({ defaultResponse: response });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.metadata.llmModel).toBe('gpt-4');
  });

  it('should store usage info in context.metadata.llmUsage', async () => {
    const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
    const response: LLMResponse = {
      content: 'Response',
      finish_reason: 'stop',
      usage,
    };
    llmProvider = new MockLLMProvider({ defaultResponse: response });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.metadata.llmUsage).toEqual(usage);
  });

  it('should pass all messages including system, user, assistant, and tool messages', async () => {
    const messages = [
      { role: 'system' as const, content: 'System prompt' },
      { role: 'user' as const, content: 'User question' },
      { role: 'assistant' as const, content: 'Previous response' },
      { role: 'tool' as const, content: '{"result": true}', tool_call_id: 'call_1' },
    ];
    const ctx = createContext({ messages });
    await step.execute(ctx);

    expect(llmProvider.calls[0].messages).toEqual(messages);
  });

  it('should handle multiple tool calls in a single response', async () => {
    const toolCallResponse = MockLLMProvider.toolCallResponse([
      { id: 'call_1', name: 'search', arguments: '{"q":"foo"}' },
      { id: 'call_2', name: 'read_file', arguments: '{"path":"bar.ts"}' },
    ]);
    llmProvider = new MockLLMProvider({ defaultResponse: toolCallResponse });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.llmResponse.tool_calls).toHaveLength(2);
  });

  it('should return the same context object (mutated)', async () => {
    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result).toBe(ctx);
  });

  it('should handle response with finish_reason "length" (token limit hit)', async () => {
    const response: LLMResponse = {
      content: 'Truncated resp...',
      finish_reason: 'length',
      usage: { input_tokens: 4000, output_tokens: 4096, total_tokens: 8096 },
    };
    llmProvider = new MockLLMProvider({ defaultResponse: response });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.llmResponse.finish_reason).toBe('length');
  });

  it('should handle response with finish_reason "content_filter"', async () => {
    const response: LLMResponse = {
      content: '',
      finish_reason: 'content_filter',
      usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
    };
    llmProvider = new MockLLMProvider({ defaultResponse: response });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.llmResponse.finish_reason).toBe('content_filter');
  });

  it('should handle empty messages array', async () => {
    const ctx = createContext({ messages: [] });
    await step.execute(ctx);

    expect(llmProvider.calls[0].messages).toEqual([]);
  });

  it('should not modify context.shouldContinue', async () => {
    const ctx = createContext({ shouldContinue: true });
    const result = await step.execute(ctx);

    expect(result.shouldContinue).toBe(true);
  });

  it('should handle LLM response with metadata', async () => {
    const response: LLMResponse = {
      content: 'With metadata',
      finish_reason: 'stop',
      metadata: { latencyMs: 230, cached: false },
    };
    llmProvider = new MockLLMProvider({ defaultResponse: response });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.llmResponse.metadata).toEqual({ latencyMs: 230, cached: false });
  });

  it('should accumulate token usage across multiple calls in metadata', async () => {
    const usage = { input_tokens: 50, output_tokens: 25, total_tokens: 75 };
    const response: LLMResponse = { content: 'R', finish_reason: 'stop', usage };
    llmProvider = new MockLLMProvider({ defaultResponse: response });
    step = new CallLLMStep(llmProvider, toolExecutor);

    const ctx = createContext();
    const result = await step.execute(ctx);

    expect(result.metadata.llmUsage).toEqual(usage);
  });
});
