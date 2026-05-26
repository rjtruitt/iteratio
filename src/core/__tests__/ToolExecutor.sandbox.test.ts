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

describe('ToolExecutor - Sandbox Security', () => {
  describe('permission checks', () => {
    it('checks permission before executing tool', async () => {
      const executor = createToolExecutor();
      const permissionCheck = vi.fn().mockReturnValue(true);
      const tool = createMockTool('filesystem', {
        execute: async () => ({ success: true, data: 'file contents' }),
      });
      executor.registerTool(tool);

      // Configure sandbox with permission callback
      (executor as any).sandbox = { checkPermission: permissionCheck };

      const result = await executor.executeTool(
        createToolCall('filesystem', { path: '/allowed/dir/file.txt' }),
        createBasicContext()
      );

      expect(permissionCheck).toHaveBeenCalledBefore(tool.execute as any);
    });

    it('denies execution when permission check returns false', async () => {
      const executor = createToolExecutor();
      const executeFn = vi.fn().mockResolvedValue({ success: true });
      const tool = createMockTool('restricted', { execute: executeFn });
      executor.registerTool(tool);

      // Configure sandbox to deny
      (executor as any).sandbox = {
        checkPermission: () => false,
        allowedPaths: [],
      };

      const result = await executor.executeTool(
        createToolCall('restricted', { path: '/secret/data' }),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(executeFn).not.toHaveBeenCalled();
    });
  });

  describe('path allowlist', () => {
    it('allows execution when path is in the allowlist', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('readFile', {
        execute: async () => ({ success: true, data: 'content' }),
      });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        allowedPaths: ['/home/user/workspace', '/tmp'],
        checkPath: (p: string) => ['/home/user/workspace', '/tmp'].some(a => p.startsWith(a)),
      };

      const result = await executor.executeTool(
        createToolCall('readFile', { path: '/home/user/workspace/file.ts' }),
        createBasicContext()
      );

      expect(result.success).toBe(true);
    });

    it('denies execution when path is not in the allowlist', async () => {
      const executor = createToolExecutor();
      const executeFn = vi.fn().mockResolvedValue({ success: true });
      const tool = createMockTool('readFile', { execute: executeFn });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        allowedPaths: ['/safe/dir'],
        checkPath: (p: string) => p.startsWith('/safe/dir'),
      };

      const result = await executor.executeTool(
        createToolCall('readFile', { path: '/etc/passwd' }),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(executeFn).not.toHaveBeenCalled();
    });

    it('path traversal attempt with ../ is rejected', async () => {
      const executor = createToolExecutor();
      const executeFn = vi.fn().mockResolvedValue({ success: true });
      const tool = createMockTool('readFile', { execute: executeFn });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        allowedPaths: ['/safe/dir'],
        checkPath: (p: string) => !p.includes('..') && p.startsWith('/safe/dir'),
      };

      const result = await executor.executeTool(
        createToolCall('readFile', { path: '/safe/dir/../../../etc/passwd' }),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(executeFn).not.toHaveBeenCalled();
    });

    it('null byte in path is rejected', async () => {
      const executor = createToolExecutor();
      const executeFn = vi.fn().mockResolvedValue({ success: true });
      const tool = createMockTool('readFile', { execute: executeFn });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        allowedPaths: ['/safe'],
        checkPath: (p: string) => !p.includes('\0'),
      };

      const result = await executor.executeTool(
        createToolCall('readFile', { path: '/safe/file\0.txt' }),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(executeFn).not.toHaveBeenCalled();
    });
  });

  describe('host allowlist', () => {
    it('allows execution when host is in the allowlist', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('httpFetch', {
        execute: async () => ({ success: true, data: { status: 200 } }),
      });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        allowedHosts: ['api.example.com', 'cdn.example.com'],
        checkHost: (h: string) => ['api.example.com', 'cdn.example.com'].includes(h),
      };

      const result = await executor.executeTool(
        createToolCall('httpFetch', { url: 'https://api.example.com/data' }),
        createBasicContext()
      );

      expect(result.success).toBe(true);
    });

    it('denies execution when host is not in the allowlist', async () => {
      const executor = createToolExecutor();
      const executeFn = vi.fn().mockResolvedValue({ success: true });
      const tool = createMockTool('httpFetch', { execute: executeFn });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        allowedHosts: ['safe.example.com'],
        checkHost: (h: string) => h === 'safe.example.com',
      };

      const result = await executor.executeTool(
        createToolCall('httpFetch', { url: 'https://evil.attacker.com/steal' }),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(executeFn).not.toHaveBeenCalled();
    });

    it('denies access to localhost when not in allowlist', async () => {
      const executor = createToolExecutor();
      const executeFn = vi.fn().mockResolvedValue({ success: true });
      const tool = createMockTool('httpFetch', { execute: executeFn });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        allowedHosts: ['api.production.com'],
        checkHost: (h: string) => h === 'api.production.com',
      };

      const result = await executor.executeTool(
        createToolCall('httpFetch', { url: 'http://localhost:8080/admin' }),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(executeFn).not.toHaveBeenCalled();
    });
  });

  describe('sandbox timeout', () => {
    it('enforces execution timeout within sandbox', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('slowTool', {
        execute: async () => {
          await new Promise(resolve => setTimeout(resolve, 60000));
          return { success: true };
        },
      });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        timeoutMs: 1000,
      };

      const result = await executor.executeTool(
        createToolCall('slowTool', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      expect(result.error?.message ?? JSON.stringify(result.error)).toContain('timeout');
    });

    it('tool that completes within sandbox timeout succeeds', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('fastTool', {
        execute: async () => ({ success: true, data: 'quick' }),
      });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        timeoutMs: 5000,
      };

      const result = await executor.executeTool(
        createToolCall('fastTool', {}),
        createBasicContext()
      );

      expect(result.success).toBe(true);
    });
  });

  describe('injection prevention', () => {
    it('rejects tool name containing injection characters', async () => {
      const executor = createToolExecutor();

      (executor as any).sandbox = {
        validateToolName: (name: string) => /^[a-zA-Z0-9_-]+$/.test(name),
      };

      const result = await executor.executeTool(
        createToolCall('tool; rm -rf /', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });

    it('rejects tool name with shell metacharacters', async () => {
      const executor = createToolExecutor();

      (executor as any).sandbox = {
        validateToolName: (name: string) => /^[a-zA-Z0-9_-]+$/.test(name),
      };

      const result = await executor.executeTool(
        createToolCall('tool$(whoami)', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });

    it('rejects tool name with backticks', async () => {
      const executor = createToolExecutor();

      (executor as any).sandbox = {
        validateToolName: (name: string) => /^[a-zA-Z0-9_-]+$/.test(name),
      };

      const result = await executor.executeTool(
        createToolCall('tool`id`', {}),
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });

    it('allows valid tool names with alphanumerics, hyphens, and underscores', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('valid-tool_name123', {
        execute: async () => ({ success: true }),
      });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        validateToolName: (name: string) => /^[a-zA-Z0-9_-]+$/.test(name),
      };

      const result = await executor.executeTool(
        createToolCall('valid-tool_name123', {}),
        createBasicContext()
      );

      expect(result.success).toBe(true);
    });

    it('rejects arguments containing embedded script tags', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('webTool', {
        execute: async () => ({ success: true }),
      });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        sanitizeArgs: (args: unknown) => {
          const str = JSON.stringify(args);
          if (str.includes('<script>')) throw new Error('Injection attempt detected');
          return args;
        },
      };

      const result = await executor.executeTool(
        createToolCall('webTool', { html: '<script>alert("xss")</script>' }),
        createBasicContext()
      );

      expect(result.success).toBe(false);
    });
  });

  describe('sandbox error messages', () => {
    it('permission denied error includes the denied resource', async () => {
      const executor = createToolExecutor();
      const tool = createMockTool('fileTool', {
        execute: async () => ({ success: true }),
      });
      executor.registerTool(tool);

      (executor as any).sandbox = {
        checkPath: (p: string) => {
          if (!p.startsWith('/allowed')) {
            throw new Error(`Access denied: ${p}`);
          }
          return true;
        },
      };

      const result = await executor.executeTool(
        createToolCall('fileTool', { path: '/forbidden/secret.key' }),
        createBasicContext()
      );

      expect(result.success).toBe(false);
      const errorStr = result.error?.message ?? JSON.stringify(result.error);
      expect(errorStr).toContain('/forbidden/secret.key');
    });

    it('sandbox violation is logged', async () => {
      const logger = createMockLogger();
      const executor = Object.create(ToolExecutor.prototype);
      (executor as any).tools = new Map();
      (executor as any).logger = logger;

      const tool = createMockTool('blocked', {
        execute: async () => ({ success: true }),
      });
      (executor as any).tools.set('blocked', tool);

      (executor as any).sandbox = {
        checkPermission: () => { throw new Error('Sandbox violation'); },
      };

      await executor.executeTool(createToolCall('blocked', {}), createBasicContext());

      expect(logger.error).toHaveBeenCalled();
    });
  });
});
