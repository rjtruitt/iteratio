import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockMessageManager } from '../../../__test__/';
import { AddUserMessageStep } from '../AddUserMessageStep';
import { StepContext } from '../../../interfaces/IStep';

describe('AddUserMessageStep', () => {
  let step: AddUserMessageStep;
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

  beforeEach(() => {
    messageManager = new MockMessageManager();
    // Instantiate without DI container - pass dependency directly
    step = new AddUserMessageStep(messageManager);
  });

  it('should have name "add-user-message"', () => {
    expect(step.name).toBe('add-user-message');
  });

  it('should have priority 100', () => {
    expect(step.priority).toBe(100);
  });

  it('should add a user message with input from context.data.userInput', async () => {
    const ctx = createContext({ data: { userInput: 'Hello, agent!' } });
    await step.execute(ctx);

    const messages = messageManager.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hello, agent!');
  });

  it('should set message role to "user"', async () => {
    const ctx = createContext({ data: { userInput: 'Test input' } });
    await step.execute(ctx);

    const messages = messageManager.getMessages();
    expect(messages[0].role).toBe('user');
  });

  it('should handle empty input string by skipping message addition', async () => {
    const ctx = createContext({ data: { userInput: '' } });
    const result = await step.execute(ctx);

    expect(messageManager.count()).toBe(0);
    expect(result).toBe(ctx);
  });

  it('should handle multi-line input preserving newlines', async () => {
    const multiLine = 'Line 1\nLine 2\nLine 3';
    const ctx = createContext({ data: { userInput: multiLine } });
    await step.execute(ctx);

    const messages = messageManager.getMessages();
    expect(messages[0].content).toBe(multiLine);
  });

  it('should update context.messages array with all messages from manager', async () => {
    // Pre-populate some messages
    messageManager.addMessage({ role: 'system', content: 'You are helpful' });
    const ctx = createContext({ data: { userInput: 'Hi' } });

    const result = await step.execute(ctx);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].content).toBe('Hi');
  });

  it('should return the modified context', async () => {
    const ctx = createContext({ data: { userInput: 'Return test' } });
    const result = await step.execute(ctx);

    expect(result).toBe(ctx);
  });

  it('should not modify context.shouldContinue', async () => {
    const ctx = createContext({ data: { userInput: 'Do not change shouldContinue' }, shouldContinue: true });
    const result = await step.execute(ctx);

    expect(result.shouldContinue).toBe(true);
  });

  it('should handle undefined userInput by skipping', async () => {
    const ctx = createContext({ data: {} });
    const result = await step.execute(ctx);

    expect(messageManager.count()).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it('should not set name or tool_call_id on the user message', async () => {
    const ctx = createContext({ data: { userInput: 'Plain user message' } });
    await step.execute(ctx);

    const messages = messageManager.getMessages();
    expect(messages[0].name).toBeUndefined();
    expect(messages[0].tool_call_id).toBeUndefined();
  });
});
