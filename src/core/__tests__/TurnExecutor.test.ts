import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnExecutor } from '../TurnExecutor';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockToolExecutor } from '../../__test__/MockToolExecutor';
import type { ITurnExecutor, TurnContext, TurnResult } from '../../interfaces/ITurnExecutor';
import type { ILLMProvider } from '../../interfaces/ILLMProvider';
import type { IToolExecutor } from '../../interfaces/IToolExecutor';
import type { ILogger } from '../../interfaces/ILogger';

function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createTurnExecutor(
  llm?: ILLMProvider,
  tools?: IToolExecutor,
  logger?: ILogger
): TurnExecutor {
  // TurnExecutor uses DI decorators, but we construct directly for testing
  const executor = Object.create(TurnExecutor.prototype);
  (executor as any).llmProvider = llm ?? new MockLLMProvider();
  (executor as any).toolExecutor = tools ?? new MockToolExecutor();
  (executor as any).logger = logger ?? createMockLogger();
  return executor;
}

function createBasicContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    turnNumber: 1,
    messages: [{ role: 'user', content: 'Hello' }],
    state: {},
    metadata: {},
    ...overrides,
  };
}

describe('TurnExecutor', () => {
  describe('interface conformance', () => {
    it('implements ITurnExecutor interface with executeTurn method', () => {
      const executor = createTurnExecutor();
      expect(executor.executeTurn).toBeDefined();
      expect(typeof executor.executeTurn).toBe('function');
    });

    it('implements ITurnExecutor interface with shouldContinue method', () => {
      const executor = createTurnExecutor();
      expect(executor.shouldContinue).toBeDefined();
      expect(typeof executor.shouldContinue).toBe('function');
    });

    it('executeTurn returns a Promise', () => {
      const executor = createTurnExecutor();
      const context = createBasicContext();
      const result = executor.executeTurn(context);
      expect(result).toBeInstanceOf(Promise);
      // Clean up the rejected promise
      result.catch(() => {});
    });
  });

  describe('dependency injection', () => {
    it('accepts ILLMProvider dependency', () => {
      const llm = new MockLLMProvider();
      const executor = createTurnExecutor(llm);
      expect(executor).toBeDefined();
    });

    it('accepts IToolExecutor dependency', () => {
      const tools = new MockToolExecutor();
      const executor = createTurnExecutor(undefined, tools);
      expect(executor).toBeDefined();
    });

    it('accepts ILogger dependency', () => {
      const logger = createMockLogger();
      const executor = createTurnExecutor(undefined, undefined, logger);
      expect(executor).toBeDefined();
    });
  });

  describe('executeTurn delegation', () => {
    it('calls llmProvider.invoke with messages from context', async () => {
      const llm = new MockLLMProvider();
      const executor = createTurnExecutor(llm);
      const context = createBasicContext({
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'What is 2+2?' },
        ],
      });

      try {
        await executor.executeTurn(context);
      } catch {
        // Expected to throw TODO - that is the RED state
      }

      expect(llm.callCount).toBeGreaterThan(0);
      expect(llm.calls[0].messages).toEqual(context.messages);
    });

    it('passes tool definitions to llmProvider via options', async () => {
      const llm = new MockLLMProvider();
      const tools = new MockToolExecutor();
      const executor = createTurnExecutor(llm, tools);
      const context = createBasicContext();

      try {
        await executor.executeTurn(context);
      } catch {
        // Expected to throw TODO
      }

      // The LLM should receive tool definitions in options
      if (llm.callCount > 0) {
        expect(llm.calls[0].options?.tools).toBeDefined();
      }
    });

    it('returns TurnResult with response from LLM', async () => {
      const response = MockLLMProvider.simpleResponse('The answer is 4');
      const llm = new MockLLMProvider({ defaultResponse: response });
      const executor = createTurnExecutor(llm);
      const context = createBasicContext();

      const result = await executor.executeTurn(context);

      expect(result.response).toBeDefined();
      expect(result.response.content).toBe('The answer is 4');
    });

    it('returns TurnResult with updatedMessages including new assistant message', async () => {
      const llm = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('Hello there'),
      });
      const executor = createTurnExecutor(llm);
      const context = createBasicContext();

      const result = await executor.executeTurn(context);

      expect(result.updatedMessages).toBeDefined();
      const assistantMsgs = result.updatedMessages.filter(m => m.role === 'assistant');
      expect(assistantMsgs.length).toBeGreaterThan(0);
    });
  });

  describe('shouldContinue', () => {
    it('returns true when finish_reason is tool_calls', () => {
      const executor = createTurnExecutor();
      const result: TurnResult = {
        response: {
          content: '',
          tool_calls: [{ id: 'tc1', name: 'test', arguments: '{}' }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        },
        updatedMessages: [],
        shouldContinue: true,
      };

      expect(executor.shouldContinue(result)).toBe(true);
    });

    it('returns false when finish_reason is stop', () => {
      const executor = createTurnExecutor();
      const result: TurnResult = {
        response: {
          content: 'Final answer',
          finish_reason: 'stop',
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        },
        updatedMessages: [],
        shouldContinue: false,
      };

      expect(executor.shouldContinue(result)).toBe(false);
    });

    it('returns false when finish_reason is length', () => {
      const executor = createTurnExecutor();
      const result: TurnResult = {
        response: {
          content: 'Truncated...',
          finish_reason: 'length',
          usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        },
        updatedMessages: [],
        shouldContinue: false,
      };

      expect(executor.shouldContinue(result)).toBe(false);
    });
  });
});
