import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockMessageManager } from '../../../__test__/';
import { AddAssistantResponseStep } from '../AddAssistantResponseStep';
import { StepContext } from '../../../interfaces/IStep';
import type { LLMResponse } from '../../../interfaces/ILLMProvider';

describe('AddAssistantResponseStep', () => {
  let step: AddAssistantResponseStep;
  let messageManager: MockMessageManager;

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

  function makeStopResponse(content: string): LLMResponse {
    return {
      content,
      finish_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
  }

  function makeToolCallResponse(): LLMResponse {
    return {
      content: '',
      tool_calls: [{ id: 'call_1', name: 'search', arguments: '{}' }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
  }

  beforeEach(() => {
    messageManager = new MockMessageManager();
    step = new AddAssistantResponseStep(messageManager);
  });

  it('should have name "add-assistant-response"', () => {
    expect(step.name).toBe('add-assistant-response');
  });

  it('should have priority 500', () => {
    expect(step.priority).toBe(500);
  });

  it('should add assistant message from llmResponse.content', async () => {
    const ctx = createContext({ llmResponse: makeStopResponse('Hello! How can I help?') });

    await step.execute(ctx);

    const messages = messageManager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Hello! How can I help?');
  });

  it('should skip via shouldExecute if tool calls were present', () => {
    const ctx = createContext({ llmResponse: makeToolCallResponse() });
    expect(step.shouldExecute!(ctx)).toBe(false);
  });

  it('should execute via shouldExecute when no tool calls in response', () => {
    const ctx = createContext({ llmResponse: makeStopResponse('Final answer') });
    expect(step.shouldExecute!(ctx)).toBe(true);
  });

  it('should handle empty response content', async () => {
    const ctx = createContext({ llmResponse: makeStopResponse('') });

    await step.execute(ctx);

    const messages = messageManager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
  });

  it('should set shouldContinue to false (turn complete)', async () => {
    const ctx = createContext({
      shouldContinue: true,
      llmResponse: makeStopResponse('Done'),
    });

    const result = await step.execute(ctx);
    expect(result.shouldContinue).toBe(false);
  });

  it('should update context.messages with all messages from manager', async () => {
    messageManager.addMessage({ role: 'user', content: 'Hi' });
    const ctx = createContext({ llmResponse: makeStopResponse('Hello!') });

    const result = await step.execute(ctx);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('should return the same context object', async () => {
    const ctx = createContext({ llmResponse: makeStopResponse('Test') });
    const result = await step.execute(ctx);
    expect(result).toBe(ctx);
  });

  it('should handle shouldExecute when llmResponse has empty tool_calls array', () => {
    const response: LLMResponse = {
      content: 'No tools used',
      tool_calls: [],
      finish_reason: 'stop',
    };
    const ctx = createContext({ llmResponse: response });
    expect(step.shouldExecute!(ctx)).toBe(true);
  });

  it('should handle long multi-paragraph content', async () => {
    const longContent = 'Paragraph 1.\n\nParagraph 2.\n\nParagraph 3 with details.';
    const ctx = createContext({ llmResponse: makeStopResponse(longContent) });

    await step.execute(ctx);

    const messages = messageManager.getMessages();
    expect(messages[0].content).toBe(longContent);
  });

  it('should handle shouldExecute when llmResponse is undefined', () => {
    const ctx = createContext({ llmResponse: undefined });
    expect(step.shouldExecute!(ctx)).toBe(true);
  });
});
