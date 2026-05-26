import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockMessageManager } from '../../../__test__/';
import { AddToolResultsStep } from '../AddToolResultsStep';
import { StepContext } from '../../../interfaces/IStep';
import type { LLMResponse } from '../../../interfaces/ILLMProvider';

describe('AddToolResultsStep', () => {
  let step: AddToolResultsStep;
  let messageManager: MockMessageManager;

  function createContext(overrides: Partial<StepContext> = {}): StepContext {
    return {
      turnNumber: 1,
      messages: [],
      state: {},
      metadata: {},
      shouldContinue: false,
      data: {},
      ...overrides,
    };
  }

  function makeLLMResponse(content = ''): LLMResponse {
    return {
      content,
      tool_calls: [{ id: 'call_1', name: 'search', arguments: '{}' }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
  }

  beforeEach(() => {
    messageManager = new MockMessageManager();
    step = new AddToolResultsStep(messageManager);
  });

  it('should have name "add-tool-results"', () => {
    expect(step.name).toBe('add-tool-results');
  });

  it('should have priority 400', () => {
    expect(step.priority).toBe(400);
  });

  it('should add tool result messages to context.messages', async () => {
    const toolResults = [
      { success: true, data: { answer: 42 }, tool_call_id: 'call_1' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    const result = await step.execute(ctx);

    // Should have assistant message + tool message
    const messages = messageManager.getMessages();
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it('should map tool_call_id correctly on tool messages', async () => {
    const toolResults = [
      { success: true, data: { found: true }, tool_call_id: 'call_abc' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    await step.execute(ctx);

    const toolMessages = messageManager.getMessages({ role: 'tool' });
    expect(toolMessages[0].tool_call_id).toBe('call_abc');
  });

  it('should handle success result with JSON serialized data', async () => {
    const toolResults = [
      { success: true, data: { items: [1, 2, 3] }, tool_call_id: 'call_1' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    await step.execute(ctx);

    const toolMessages = messageManager.getMessages({ role: 'tool' });
    expect(toolMessages[0].content).toBe(JSON.stringify({ items: [1, 2, 3] }));
  });

  it('should handle error result with error message in content', async () => {
    const toolResults = [
      { success: false, data: null, error: 'File not found', tool_call_id: 'call_1' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    await step.execute(ctx);

    const toolMessages = messageManager.getMessages({ role: 'tool' });
    expect(toolMessages[0].content).toContain('File not found');
  });

  it('should handle missing tool_call_id gracefully by skipping or using fallback', async () => {
    const toolResults = [
      { success: true, data: { val: 'no-id' } },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    // Should not throw
    await expect(step.execute(ctx)).resolves.toBeDefined();
  });

  it('should add multiple tool results in order', async () => {
    const toolResults = [
      { success: true, data: { result: 'first' }, tool_call_id: 'call_1' },
      { success: true, data: { result: 'second' }, tool_call_id: 'call_2' },
      { success: true, data: { result: 'third' }, tool_call_id: 'call_3' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    await step.execute(ctx);

    const toolMessages = messageManager.getMessages({ role: 'tool' });
    expect(toolMessages).toHaveLength(3);
    expect(JSON.parse(toolMessages[0].content)).toEqual({ result: 'first' });
    expect(JSON.parse(toolMessages[1].content)).toEqual({ result: 'second' });
    expect(JSON.parse(toolMessages[2].content)).toEqual({ result: 'third' });
  });

  it('should add assistant message before tool result messages', async () => {
    const toolResults = [
      { success: true, data: { x: 1 }, tool_call_id: 'call_1' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse('Thinking...'),
      toolResults,
    });

    await step.execute(ctx);

    const messages = messageManager.getMessages();
    const assistantIdx = messages.findIndex(m => m.role === 'assistant');
    const toolIdx = messages.findIndex(m => m.role === 'tool');
    expect(assistantIdx).toBeLessThan(toolIdx);
  });

  it('should set shouldContinue to true (loop needs another LLM call)', async () => {
    const toolResults = [
      { success: true, data: {}, tool_call_id: 'call_1' },
    ];
    const ctx = createContext({
      shouldContinue: false,
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    const result = await step.execute(ctx);
    expect(result.shouldContinue).toBe(true);
  });

  it('should update context.messages with current message manager state', async () => {
    messageManager.addMessage({ role: 'system', content: 'System prompt' });
    const toolResults = [
      { success: true, data: { ok: true }, tool_call_id: 'call_1' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    const result = await step.execute(ctx);

    // Should include system + assistant + tool messages
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
  });

  it('should return shouldExecute false when toolResults is undefined', () => {
    const ctx = createContext({ toolResults: undefined });
    expect(step.shouldExecute!(ctx)).toBe(false);
  });

  it('should return shouldExecute false when toolResults is empty', () => {
    const ctx = createContext({ toolResults: [] });
    expect(step.shouldExecute!(ctx)).toBe(false);
  });

  it('should return shouldExecute true when toolResults has entries', () => {
    const ctx = createContext({
      toolResults: [{ success: true, data: {} }],
    });
    expect(step.shouldExecute!(ctx)).toBe(true);
  });

  it('should set role "tool" on each tool result message', async () => {
    const toolResults = [
      { success: true, data: { a: 1 }, tool_call_id: 'call_1' },
      { success: true, data: { b: 2 }, tool_call_id: 'call_2' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    await step.execute(ctx);

    const toolMessages = messageManager.getMessages({ role: 'tool' });
    toolMessages.forEach(m => {
      expect(m.role).toBe('tool');
    });
  });

  it('should return the modified context object', async () => {
    const toolResults = [
      { success: true, data: {}, tool_call_id: 'call_1' },
    ];
    const ctx = createContext({
      llmResponse: makeLLMResponse(),
      toolResults,
    });

    const result = await step.execute(ctx);
    expect(result).toBe(ctx);
  });
});
