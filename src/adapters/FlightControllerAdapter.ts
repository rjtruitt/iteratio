import { ILLMProvider, Message, LLMResponse, LLMOptions } from '../interfaces/ILLMProvider.js';

/**
 * Adapter making flight-controller compatible with iteratio's ILLMProvider interface.
 *
 * flight-controller handles multi-provider routing, rate limiting, retry logic,
 * cost tracking, model fallback chains, and streaming. This adapter wraps a
 * flight-controller instance so it can be used anywhere an {@link ILLMProvider}
 * is expected.
 *
 * @implements ILLMProvider
 */
export class FlightControllerAdapter implements ILLMProvider {
  /**
   * Create a new FlightControllerAdapter.
   *
   * @param flightController - An instance of a flight-controller client.
   * @throws {Error} If flightController is null or undefined.
   */
  constructor(private flightController: any) {
    if (!flightController) {
      throw new Error(
        'FlightController instance required. Install with: npm install flight-controller'
      );
    }
  }

  /**
   * Send messages through flight-controller and normalize the response.
   *
   * Forwards the messages and options to the wrapped flight-controller instance
   * and maps the raw response into the standard {@link LLMResponse} format.
   *
   * @param messages - The conversation messages to send.
   * @param options - Optional LLM parameters (temperature, max_tokens, tools, etc.).
   * @returns A normalized LLMResponse with content, tool_calls, usage, and model info.
   */
  async invoke(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    const response = await this.flightController.invoke(messages, {
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      stop: options?.stop,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      stream: options?.stream,
      metadata: options?.metadata
    });

    return {
      content: response.content,
      tool_calls: response.tool_calls,
      finish_reason: response.finish_reason || 'stop',
      usage: response.usage,
      model: response.model,
      metadata: response.metadata
    };
  }

  /**
   * Return provider metadata from the underlying flight-controller instance.
   *
   * Includes provider name, model identifier, and capabilities such as
   * tool_calling, streaming, and rate_limiting.
   *
   * @returns An object with provider, model, and capabilities fields.
   */
  getInfo() {
    return this.flightController.getInfo?.() || {
      provider: 'flight-controller',
      model: 'unknown',
      capabilities: ['tool_calling', 'streaming', 'rate_limiting']
    };
  }

  /**
   * Gracefully shut down the flight-controller instance if it supports shutdown.
   *
   * Called during application teardown to release any held resources
   * (connections, timers, etc.) in the underlying flight-controller.
   *
   * @returns A promise that resolves when shutdown is complete.
   */
  async shutdown(): Promise<void> {
    if (this.flightController.shutdown) {
      await this.flightController.shutdown();
    }
  }
}
