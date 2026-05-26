import type { ILLMProvider, LLMOptions, LLMResponse, Message } from '../interfaces/ILLMProvider.js';

export interface MockLLMProviderOptions {
  responses?: LLMResponse[];
  defaultResponse?: LLMResponse;
  throwOnCall?: number;
  throwError?: Error;
  delayMs?: number;
}

export class MockLLMProvider implements ILLMProvider {
  private callIndex = 0;
  private _calls: Array<{ messages: Message[]; options?: LLMOptions }> = [];
  private responses: LLMResponse[];
  private defaultResponse: LLMResponse;
  private throwOnCall?: number;
  private throwError?: Error;
  private delayMs: number;
  private _customInvoke: ((messages: Message[], options?: LLMOptions) => Promise<LLMResponse>) | null = null;

  constructor(options: MockLLMProviderOptions = {}) {
    this.responses = options.responses ?? [];
    this.defaultResponse = options.defaultResponse ?? MockLLMProvider.simpleResponse('Mock response');
    this.throwOnCall = options.throwOnCall;
    this.throwError = options.throwError;
    this.delayMs = options.delayMs ?? 0;
  }

  get calls() { return this._calls; }
  get callCount() { return this._calls.length; }

  get invoke(): (messages: Message[], options?: LLMOptions) => Promise<LLMResponse> {
    return async (messages: Message[], options?: LLMOptions): Promise<LLMResponse> => {
      this._calls.push({ messages, options });
      const currentCall = this.callIndex++;

      // If custom invoke was set, use it
      if (this._customInvoke) {
        return this._customInvoke(messages, options);
      }

      if (this.throwOnCall !== undefined && currentCall === this.throwOnCall) {
        throw this.throwError ?? new Error(`MockLLMProvider: forced error on call ${currentCall}`);
      }

      if (this.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.delayMs));
      }

      return this.responses[currentCall] ?? this.defaultResponse;
    };
  }

  set invoke(fn: (messages: Message[], options?: LLMOptions) => Promise<LLMResponse>) {
    this._customInvoke = fn;
  }

  getInfo() {
    return { provider: 'mock', model: 'mock-model', capabilities: ['tools', 'streaming'] };
  }

  async shutdown(): Promise<void> {}

  reset(): void {
    this._calls = [];
    this.callIndex = 0;
    this._customInvoke = null;
  }

  static simpleResponse(content: string): LLMResponse {
    return {
      content,
      finish_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
  }

  static toolCallResponse(toolCalls: Array<{ id: string; name: string; arguments: string }>): LLMResponse {
    return {
      content: '',
      tool_calls: toolCalls,
      finish_reason: 'tool_calls',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
  }

  static sequencedResponses(...responses: LLMResponse[]): MockLLMProvider {
    return new MockLLMProvider({ responses });
  }
}
