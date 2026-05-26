import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlightControllerAdapter } from '../FlightControllerAdapter';

function createMockFC(overrides: Record<string, any> = {}) {
  return {
    invoke: vi.fn().mockResolvedValue({
      content: 'mock response',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'claude-sonnet-4-20250514',
      metadata: {},
    }),
    getInfo: vi.fn().mockReturnValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      capabilities: ['tool_calling', 'streaming'],
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('FlightControllerAdapter', () => {
  describe('constructor', () => {
    it('should accept a FlightController instance', () => {
      const fc = createMockFC();
      const adapter = new FlightControllerAdapter(fc);
      expect(adapter).toBeDefined();
    });

    it('should throw if FlightController instance is null/undefined', () => {
      expect(() => new FlightControllerAdapter(null)).toThrow();
      expect(() => new FlightControllerAdapter(undefined)).toThrow();
    });
  });

  describe('invoke()', () => {
    it('should delegate to FC invoke()', async () => {
      const fc = createMockFC();
      const adapter = new FlightControllerAdapter(fc);

      await adapter.invoke([{ role: 'user', content: 'hello' }]);

      expect(fc.invoke).toHaveBeenCalledOnce();
    });

    it('should return LLM response in iteratio format', async () => {
      const fc = createMockFC();
      const adapter = new FlightControllerAdapter(fc);

      const result = await adapter.invoke([{ role: 'user', content: 'hello' }]);

      expect(result).toHaveProperty('content', 'mock response');
      expect(result).toHaveProperty('finish_reason', 'stop');
      expect(result).toHaveProperty('usage');
      expect(result).toHaveProperty('model');
    });

    it('should handle rate limit error from FC', async () => {
      const fc = createMockFC({
        invoke: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
      });
      const adapter = new FlightControllerAdapter(fc);

      // FAILS: adapter does not wrap FC errors into iteratio error types
      await expect(adapter.invoke([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow('Rate limit exceeded');
    });

    it('should handle model unavailable error from FC', async () => {
      const fc = createMockFC({
        invoke: vi.fn().mockRejectedValue(new Error('Model unavailable')),
      });
      const adapter = new FlightControllerAdapter(fc);

      await expect(adapter.invoke([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow('Model unavailable');
    });

    it('should pass streaming option through to FC', async () => {
      const fc = createMockFC();
      const adapter = new FlightControllerAdapter(fc);

      await adapter.invoke(
        [{ role: 'user', content: 'hello' }],
        { stream: true }
      );

      expect(fc.invoke).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ stream: true })
      );
    });

    it('should pass tool definitions through to FC', async () => {
      const fc = createMockFC();
      const adapter = new FlightControllerAdapter(fc);
      const tools = [{ name: 'search', description: 'Search', input_schema: { type: 'object', properties: {}, required: [] } }];

      await adapter.invoke(
        [{ role: 'user', content: 'hello' }],
        { tools }
      );

      expect(fc.invoke).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tools })
      );
    });

    it('should handle FC throwing a generic error', async () => {
      const fc = createMockFC({
        invoke: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const adapter = new FlightControllerAdapter(fc);

      await expect(adapter.invoke([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow('Connection refused');
    });
  });

  describe('getInfo()', () => {
    it('should return model information from FC', () => {
      const fc = createMockFC();
      const adapter = new FlightControllerAdapter(fc);

      const info = adapter.getInfo();

      expect(info).toHaveProperty('provider', 'anthropic');
      expect(info).toHaveProperty('model', 'claude-sonnet-4-20250514');
      expect(info).toHaveProperty('capabilities');
    });

    it('should return default info when FC has no getInfo method', () => {
      const fc = createMockFC({ getInfo: undefined });
      const adapter = new FlightControllerAdapter(fc);

      const info = adapter.getInfo();

      expect(info).toHaveProperty('provider', 'flight-controller');
    });
  });

  describe('shutdown()', () => {
    it('should call FC shutdown to clean up resources', async () => {
      const fc = createMockFC();
      const adapter = new FlightControllerAdapter(fc);

      await adapter.shutdown();

      expect(fc.shutdown).toHaveBeenCalledOnce();
    });

    it('should handle FC without shutdown method gracefully', async () => {
      const fc = createMockFC({ shutdown: undefined });
      const adapter = new FlightControllerAdapter(fc);

      await expect(adapter.shutdown()).resolves.toBeUndefined();
    });
  });
});
