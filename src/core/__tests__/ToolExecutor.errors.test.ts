import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from '../ToolExecutor';
import { createMockTool } from '../../__test__/MockToolExecutor';
import type { ITool, ToolContext, ToolResult } from '../../interfaces/IToolExecutor';
import type { ToolCall } from '../../interfaces/ILLMProvider';
import type { ILogger } from '../../interfaces/ILogger';

function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createToolExecutor(): ToolExecutor {
  const executor = Object.create(ToolExecutor.prototype);
  (executor as any).tools = new Map();
  (executor as any).logger = createMockLogger();
  return executor;
}

function createBasicContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    turnNumber: 1,
    state: {},
    metadata: {},
    ...overrides,
  };
}

function createToolCall(name: string, args: unknown = {}, id?: string): ToolCall {
  return {
    id: id ?? `call-${name}`,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

describe('ToolExecutor - Error Handling', () => {
  describe('synchronous errors', () => {
    it('tool that throws synchronous error is caught', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('syncThrow', {
        execute: () => { throw new Error('Sync explosion'); },
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('syncThrow', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(result.error?.message ?? JSON.stringify(result.error)).toContain('Sync explosion');
    });

    it('tool that throws non-Error value is caught', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('stringThrow', {
        execute: () => { throw 'just a string'; },
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('stringThrow', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });

    it('tool that throws TypeError is caught', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('typeError', {
        execute: () => {
          const obj: any = null;
          return obj.nonExistent();  // TypeError: Cannot read properties of null
        },
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('typeError', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });
  });

  describe('promise rejections', () => {
    it('tool that rejects promise is caught', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('asyncFail', {
        execute: async () => { throw new Error('Async failure'); },
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('asyncFail', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(result.error?.message ?? JSON.stringify(result.error)).toContain('Async failure');
    });

    it('tool that returns rejected promise via Promise.reject', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('rejectTool', {
        execute: () => Promise.reject(new Error('Explicitly rejected')),
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('rejectTool', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(result.error?.message ?? JSON.stringify(result.error)).toContain('Explicitly rejected');
    });

    it('tool that rejects after delay is caught', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('delayedFail', {
        execute: () => new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Delayed failure')), 10);
        }),
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('delayedFail', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });
  });

  describe('timeout errors', () => {
    it('tool that exceeds timeout produces timeout error', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('neverResolve', {
        execute: () => new Promise(() => {}), // Never resolves
      });
      executor.registerTool(tool);

      // Set a timeout on the executor
      (executor as any).defaultTimeout = 100;

      const result = await executor.executeTool(
        createToolCall('neverResolve', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(result.error?.message ?? JSON.stringify(result.error)).toContain('timeout');
    });

    it('timeout error includes the tool name', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('slowQuery', {
        execute: () => new Promise(() => {}),
      });
      executor.registerTool(tool);

      (executor as any).defaultTimeout = 50;

      const result = await executor.executeTool(
        createToolCall('slowQuery', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      const errorStr = result.error?.message ?? JSON.stringify(result.error);
      expect(errorStr).toContain('slowQuery');
    });

    it('tool that completes just before timeout succeeds', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('justInTime', {
        execute: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return { success: true, data: 'made it' };
        },
      });
      executor.registerTool(tool);

      (executor as any).defaultTimeout = 5000;

      const result = await executor.executeTool(
        createToolCall('justInTime', {}),
        createBasicContext()
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('made it');
    });
  });

  describe('cascading failures', () => {
    it('tool A that internally calls tool B handles B failure gracefully', async () => {
      const executor = createToolExecutor();
      const toolB = createMockTool('toolB', {
        execute: async () => { throw new Error('B failed'); },
      });
      const toolA = createMockTool('toolA', {
        execute: async (args, ctx) => {
          // Tool A tries to use Tool B's result
          const bResult = await executor.executeTool(
            { id: 'inner', name: 'toolB', arguments: '{}' },
            ctx
          );
          if (!bResult.success) {
            return { success: false, error: `Dependency failed: ${bResult.error}` };
          }
          return { success: true, data: bResult.data };
        },
      });
      executor.registerTool(toolA);
      executor.registerTool(toolB);

      const result = await executor.executeTool(
        createToolCall('toolA', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });

    it('failure in one tool of executeTools does not prevent others from running (parallel)', async () => {
      const executor = createToolExecutor();
      executor.registerTool(createMockTool('goodTool', {
        execute: async () => ({ success: true, data: 'ok' }),
      }));
      executor.registerTool(createMockTool('badTool', {
        execute: async () => { throw new Error('I fail'); },
      }));

      const results = await executor.executeTools(
        [createToolCall('goodTool', {}, 'c1'), createToolCall('badTool', {}, 'c2')],
        createBasicContext(),
        'parallel'
      );

      // Both should return results (not throw)
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });

    it('failure in one tool of executeTools does not prevent others from running (sequential)', async () => {
      const executor = createToolExecutor();
      executor.registerTool(createMockTool('first', {
        execute: async () => { throw new Error('First fails'); },
      }));
      executor.registerTool(createMockTool('second', {
        execute: async () => ({ success: true, data: 'second ran' }),
      }));

      const results = await executor.executeTools(
        [createToolCall('first', {}, 'c1'), createToolCall('second', {}, 'c2')],
        createBasicContext(),
        'sequential'
      );

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
    });
  });

  describe('malformed arguments', () => {
    it('arguments that are not valid JSON produce parse error', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('jsonTool', {
        execute: async () => ({ success: true }),
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        { id: 'call-1', name: 'jsonTool', arguments: 'not valid json {{{' },
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });

    it('parse error message indicates the issue is argument parsing', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('parseTool', {
        execute: async () => ({ success: true }),
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        { id: 'call-1', name: 'parseTool', arguments: '{{garbage}}' },
        createBasicContext()
      );

      expect(result.success).toBe(false);
      const errorStr = result.error?.message ?? result.error?.code ?? JSON.stringify(result.error);
      expect(errorStr.toLowerCase()).toMatch(/parse|json|syntax|invalid/);
    });

    it('empty string arguments produce parse error', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('emptyArgs', {
        execute: async () => ({ success: true }),
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        { id: 'call-1', name: 'emptyArgs', arguments: '' },
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });

    it('null arguments value is handled gracefully', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('nullArgs', {
        execute: async (args) => ({ success: true, data: args }),
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        { id: 'call-1', name: 'nullArgs', arguments: 'null' },
        createBasicContext()
      );

      // "null" is valid JSON, should parse to null
      expect(result.success).toBe(true);
    });
  });

  describe('result normalization', () => {
    it('tool returning non-standard shape is normalized to ToolResult', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('weirdTool', {
        execute: async () => ({ randomField: 'hello', anotherField: 123 }) as any,
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('weirdTool', {}),
        createBasicContext()
      );

      // Result should be normalized to have success/data/error shape
      expect(result).toHaveProperty('success');
    });

    it('tool returning undefined is normalized to error result', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('undefinedTool', {
        execute: async () => undefined as any,
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('undefinedTool', {}),
        createBasicContext()
      );

      expect(result).toHaveProperty('success');
      // undefined return should be treated as an error or normalized
      expect(result.success).toBe(false);
    });

    it('tool returning null is normalized to error result', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('nullTool', {
        execute: async () => null as any,
      });
      executor.registerTool(tool);

      const result = await executor.executeTool(
        createToolCall('nullTool', {}),
        createBasicContext()
      );

      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
    });
  });

  describe('error logging', () => {
    it('tool execution error is logged via logger', async () => {
      const logger = createMockLogger();
      const executor = Object.create(ToolExecutor.prototype);
      (executor as any).tools = new Map();
      (executor as any).logger = logger;

      const tool = createMockTool('loggedFail', {
        execute: async () => { throw new Error('Should be logged'); },
      });
      (executor as any).tools.set('loggedFail', tool);

      await executor.executeTool(createToolCall('loggedFail', {}), createBasicContext());

      expect(logger.error).toHaveBeenCalled();
    });

    it('tool not found is logged as debug or error', async () => {
      const logger = createMockLogger();
      const executor = Object.create(ToolExecutor.prototype);
      (executor as any).tools = new Map();
      (executor as any).logger = logger;

      await executor.executeTool(createToolCall('ghost', {}), createBasicContext());

      // Should log the not-found situation
      const allLogCalls = [
        ...logger.debug.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ];
      expect(allLogCalls.length).toBeGreaterThan(0);
    });
  });
});
