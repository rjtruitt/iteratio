import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoopBuilder } from '../AgentLoopBuilder';
import type { ILLMProvider, Message, LLMResponse } from '../../interfaces/ILLMProvider';
import type { IPlugin } from '../../interfaces/IPlugin';

function createMockLLM(): ILLMProvider {
  return {
    invoke: vi.fn().mockResolvedValue({
      content: 'mock response',
      finish_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    getInfo: vi.fn().mockReturnValue({ provider: 'mock', model: 'test-model' }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPlugin(name = 'test-plugin'): IPlugin {
  return {
    name,
    version: '1.0.0',
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AgentLoopBuilder', () => {
  describe('name()', () => {
    it('should set agent name and return this for chaining', () => {
      const builder = AgentLoopBuilder.create();
      const result = builder.name('my-agent');
      expect(result).toBe(builder);
    });
  });

  describe('withSystemPrompt()', () => {
    it('should set system prompt and return this for chaining', () => {
      const builder = AgentLoopBuilder.create();
      const result = builder.withSystemPrompt('You are helpful.');
      expect(result).toBe(builder);
    });
  });

  describe('withLLM()', () => {
    it('should set LLM provider and return this for chaining', () => {
      const builder = AgentLoopBuilder.create();
      const llm = createMockLLM();
      const result = builder.withLLM(llm);
      expect(result).toBe(builder);
    });
  });

  describe('withContainer()', () => {
    it('should set DI container and return this for chaining', () => {
      const builder = AgentLoopBuilder.create();
      // FAILS: Cannot import Container without inversify installed in test env
      // This test validates the method signature exists and returns `this`
      expect(builder.withContainer).toBeTypeOf('function');
      expect(true).toBe(false); // Red phase — needs inversify container mock
    });
  });

  describe('withPlugin()', () => {
    it('should add a single plugin and return this for chaining', () => {
      const builder = AgentLoopBuilder.create();
      const plugin = createMockPlugin();
      const result = builder.withPlugin(plugin);
      expect(result).toBe(builder);
    });

    it('should allow calling withPlugin multiple times', () => {
      const builder = AgentLoopBuilder.create();
      const result = builder
        .withPlugin(createMockPlugin('p1'))
        .withPlugin(createMockPlugin('p2'));
      expect(result).toBe(builder);
    });
  });

  describe('withPlugins()', () => {
    it('should add multiple plugins and return this for chaining', () => {
      const builder = AgentLoopBuilder.create();
      const plugins = [createMockPlugin('a'), createMockPlugin('b')];
      const result = builder.withPlugins(plugins);
      expect(result).toBe(builder);
    });
  });

  describe('build()', () => {
    it('should create an AgentLoop instance', () => {
      const builder = AgentLoopBuilder.create();
      const llm = createMockLLM();

      // FAILS: build() requires inversify container resolution which may not work in test
      const loop = builder.name('test-agent').withLLM(llm).build();
      expect(loop).toBeDefined();
      expect(loop.runTurn).toBeTypeOf('function');
    });

    it('should throw if no LLM provider is set', () => {
      const builder = AgentLoopBuilder.create();

      expect(() => builder.build()).toThrow('LLM provider required');
    });

    it('should throw if no name is set', () => {
      const builder = AgentLoopBuilder.create();
      const llm = createMockLLM();

      // FAILS: build() currently does not validate name is set
      expect(() => builder.withLLM(llm).build()).toThrow(/name/i);
    });

    it('should support fluent chaining (name().withLLM().build())', () => {
      const builder = AgentLoopBuilder.create();
      const llm = createMockLLM();

      // FAILS: may throw due to DI resolution, but validates chaining compiles
      const loop = builder.name('fluent').withLLM(llm).build();
      expect(loop).toBeDefined();
    });

    it('should apply default steps to the built loop', () => {
      const builder = AgentLoopBuilder.create();
      const llm = createMockLLM();

      // FAILS: registerDefaultSteps is a no-op placeholder
      const loop = builder.name('defaults').withLLM(llm).build();
      const order = loop.getWorkflowOrder();
      expect(order.length).toBeGreaterThan(0);
    });

    it('should add all plugins provided via withPlugin to the built loop', () => {
      const builder = AgentLoopBuilder.create();
      const llm = createMockLLM();
      const plugin = createMockPlugin('test-plugin');

      const loop = builder.name('with-plugins').withLLM(llm).withPlugin(plugin).build();

      // Verify plugin was added (access internal plugins array)
      expect((loop as any).plugins).toContainEqual(
        expect.objectContaining({ name: 'test-plugin' })
      );
    });
  });
});
