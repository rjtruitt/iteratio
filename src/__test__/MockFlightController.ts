/**
 * Mock for flight-controller Model/invoke interface.
 * Mirrors the real FC interface shape for FlightControllerAdapter testing.
 */

import type { LLMResponse, Message, LLMOptions } from '../interfaces/ILLMProvider.js';

export interface MockFCConfig {
  responses?: LLMResponse[];
  defaultResponse?: LLMResponse;
  throwOnCall?: number;
  throwError?: Error;
  rateLimitOnCall?: number;
  healthStatus?: 'healthy' | 'degraded' | 'unavailable';
}

export class MockFlightController {
  private callIndex = 0;
  private _calls: Array<{ messages: Message[]; options?: LLMOptions }> = [];
  private responses: LLMResponse[];
  private defaultResponse: LLMResponse;
  private throwOnCall?: number;
  private throwError?: Error;
  private rateLimitOnCall?: number;
  private _healthStatus: string;
  private _shutdown = false;

  constructor(config: MockFCConfig = {}) {
    this.responses = config.responses ?? [];
    this.defaultResponse = config.defaultResponse ?? {
      content: 'FC mock response',
      finish_reason: 'stop',
      usage: { input_tokens: 50, output_tokens: 25, total_tokens: 75 },
      model: 'claude-sonnet-4-20250514',
    };
    this.throwOnCall = config.throwOnCall;
    this.throwError = config.throwError;
    this.rateLimitOnCall = config.rateLimitOnCall;
    this._healthStatus = config.healthStatus ?? 'healthy';
  }

  get calls() { return this._calls; }
  get callCount() { return this._calls.length; }
  get isShutdown() { return this._shutdown; }

  async invoke(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    this._calls.push({ messages, options });
    const currentCall = this.callIndex++;

    if (this.rateLimitOnCall !== undefined && currentCall === this.rateLimitOnCall) {
      const error = new Error('Rate limit exceeded') as any;
      error.name = 'RateLimitError';
      error.retryAfterMs = 5000;
      throw error;
    }

    if (this.throwOnCall !== undefined && currentCall === this.throwOnCall) {
      throw this.throwError ?? new Error('FlightController: provider error');
    }

    return this.responses[currentCall] ?? this.defaultResponse;
  }

  getInfo() {
    return {
      provider: 'flight-controller',
      model: 'claude-sonnet-4-20250514',
      capabilities: ['tool_calling', 'streaming', 'rate_limiting', 'fallback_chains'],
    };
  }

  async shutdown(): Promise<void> {
    this._shutdown = true;
  }

  checkHealth() {
    return { status: this._healthStatus, latencyMs: 42 };
  }

  getUsage() {
    return {
      totalInputTokens: this._calls.length * 50,
      totalOutputTokens: this._calls.length * 25,
      totalCost: this._calls.length * 0.003,
    };
  }

  reset(): void {
    this._calls = [];
    this.callIndex = 0;
    this._shutdown = false;
  }
}
