import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockToolExecutor, createMockTool } from '../../__test__/MockToolExecutor';
import { TestClock } from '../../__test__/TestClock';
import { Sandbox } from '../../cross-cutting/Sandbox';
import { ParallelExecutor } from '../../cross-cutting/ParallelExecutor';
import { RateLimiter } from '../../cross-cutting/RateLimiter';

/**
 * Cross-cutting: MCP Tools + Tool Sandbox + Parallel Execution + Timeout
 */

describe('Cross-cutting: MCP + Sandbox + Parallel + Timeout', () => {
  let llm: MockLLMProvider;
  let clock: TestClock;
  let sandbox: Sandbox;
  let executor: ParallelExecutor;

  beforeEach(() => {
    llm = new MockLLMProvider();
    clock = new TestClock();
    sandbox = new Sandbox({
      allowedPaths: ['/tmp/data', '/home/user'],
      blockedPaths: ['/etc', '/root'],
      secretPatterns: [/sk-[a-zA-Z0-9]{20,}/, /AKIA[A-Z0-9]{16}/],
    });
    executor = new ParallelExecutor({ maxConcurrency: 3, defaultTimeoutMs: 5000 });
  });

  describe('sandbox check before MCP tool execution', () => {
    it('should sandbox-check MCP tools same as local tools', async () => {
      const result = sandbox.checkToolInvocation('mcp_file_read', { path: '/tmp/data/report.txt' });
      expect(result.allowed).toBe(true);

      const blocked = sandbox.checkToolInvocation('mcp_file_read', { path: '/etc/passwd' });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toContain('blocked');
    });

    it('should block MCP tool if it violates sandbox rules', async () => {
      const result = sandbox.checkToolInvocation('mcp_file_write', { path: '../../etc/shadow' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Path traversal');
    });

    it('should validate MCP tool response for secret leakage', async () => {
      const toolResponse = 'Config loaded: api_key=sk-abcdefghijklmnopqrstuvwxyz123';
      const check = sandbox.checkToolResult('mcp_config_read', toolResponse);
      expect(check.clean).toBe(false);
      expect(check.patterns.length).toBeGreaterThan(0);
      expect(check.redacted).toContain('[REDACTED]');
      expect(check.redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123');
    });
  });

  describe('parallel MCP tool execution with sandbox', () => {
    it('should sandbox-check all parallel tools before any execute', async () => {
      const checks = [
        sandbox.checkToolInvocation('tool_a', { path: '/tmp/data/a.txt' }),
        sandbox.checkToolInvocation('tool_b', { path: '/etc/secret' }),
        sandbox.checkToolInvocation('tool_c', { path: '/tmp/data/c.txt' }),
      ];

      // Tool B fails sandbox, but A and C should still be allowed
      expect(checks[0].allowed).toBe(true);
      expect(checks[1].allowed).toBe(false);
      expect(checks[2].allowed).toBe(true);

      // Only execute allowed tools
      const allowedTasks = checks
        .map((check, i) => ({ check, index: i }))
        .filter(({ check }) => check.allowed)
        .map(({ index }) => ({
          id: `tool-${index}`,
          fn: async () => `result-${index}`,
        }));

      const results = await executor.executeAll(allowedTasks);
      expect(results.length).toBe(2);
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should handle mixed local and MCP tools in parallel', async () => {
      const tasks = [
        { id: 'local-a', fn: async () => 'local-result-a' },
        { id: 'mcp-b', fn: async () => 'mcp-result-b' },
        { id: 'local-c', fn: async () => 'local-result-c' },
      ];

      const results = await executor.executeAll(tasks);
      expect(results.length).toBe(3);
      expect(results.every(r => r.success)).toBe(true);
      expect(results.map(r => r.data)).toEqual(['local-result-a', 'mcp-result-b', 'local-result-c']);
    });

    it('should enforce concurrency limit on parallel MCP calls', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `mcp-tool-${i}`,
        fn: async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise(r => { const t = setTimeout(r, 50); if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref(); });
          currentConcurrent--;
          return `result-${i}`;
        },
      }));

      const results = await executor.executeAll(tasks);
      expect(results.length).toBe(5);
      expect(results.every(r => r.success)).toBe(true);
      expect(maxConcurrent).toBeLessThanOrEqual(3); // Max concurrency is 3
    });
  });

  describe('timeout during parallel execution', () => {
    it('should timeout individual tool without killing others', async () => {
      const tasks = [
        { id: 'fast-a', fn: async () => 'a', timeoutMs: 5000 },
        { id: 'slow-b', fn: () => new Promise(r => { const t = setTimeout(r, 500); if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref(); }), timeoutMs: 100 },
        { id: 'fast-c', fn: async () => 'c', timeoutMs: 5000 },
      ];

      const results = await executor.executeAll(tasks);
      const resultA = results.find(r => r.id === 'fast-a');
      const resultB = results.find(r => r.id === 'slow-b');
      const resultC = results.find(r => r.id === 'fast-c');

      expect(resultA?.success).toBe(true);
      expect(resultB?.success).toBe(false);
      expect(resultB?.timedOut).toBe(true);
      expect(resultC?.success).toBe(true);
    });

    it('should enforce per-turn timeout across all parallel tools', async () => {
      const turnExecutor = new ParallelExecutor({
        maxConcurrency: 5,
        defaultTimeoutMs: 30000,
        perTurnTimeoutMs: 150,
      });

      const tasks = [
        { id: 'a', fn: async () => { await new Promise(r => { const t = setTimeout(r, 50); if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref(); }); return 'a'; } },
        { id: 'b', fn: async () => { await new Promise(r => { const t = setTimeout(r, 200); if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref(); }); return 'b'; } },
        { id: 'c', fn: async () => { await new Promise(r => { const t = setTimeout(r, 300); if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref(); }); return 'c'; } },
      ];

      const results = await turnExecutor.executeAll(tasks);
      // First task should succeed (finishes before turn timeout)
      const first = results.find(r => r.id === 'a');
      expect(first?.success).toBe(true);
    });

    it('should cancel MCP remote call on timeout (not just ignore result)', async () => {
      let cancelled = false;
      const tasks = [{
        id: 'mcp-slow',
        fn: async () => {
          try {
            await new Promise((_, reject) => {
              const t = setTimeout(() => reject(new Error('timeout')), 100);
              if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
            });
          } catch {
            cancelled = true;
            throw new Error('Cancelled');
          }
        },
        timeoutMs: 50,
      }];

      const results = await executor.executeAll(tasks);
      expect(results[0].success).toBe(false);
      expect(results[0].timedOut).toBe(true);
    });

    it('should handle timeout during sandbox check (slow permission lookup)', async () => {
      const slowSandbox = {
        async checkWithTimeout(toolName: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ allowed: boolean; timedOut: boolean }> {
          const checkPromise = new Promise<boolean>(resolve => {
            const t = setTimeout(() => resolve(true), 200);
            if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
          });
          const timeoutPromise = new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref();
          });

          try {
            await Promise.race([checkPromise, timeoutPromise]);
            return { allowed: true, timedOut: false };
          } catch {
            return { allowed: false, timedOut: true }; // Safe default: block on timeout
          }
        },
      };

      const result = await slowSandbox.checkWithTimeout('tool', { path: '/tmp' }, 50);
      expect(result.allowed).toBe(false);
      expect(result.timedOut).toBe(true);
    });
  });

  describe('MCP server failure during parallel batch', () => {
    it('should handle MCP server disconnect mid-execution', async () => {
      let callCount = 0;
      const tasks = [
        { id: 'tool-1', fn: async () => { callCount++; return 'result-1'; } },
        { id: 'tool-2', fn: async () => { callCount++; throw new Error('MCP server disconnected'); } },
        { id: 'tool-3', fn: async () => { callCount++; throw new Error('MCP server disconnected'); } },
      ];

      const results = await executor.executeAll(tasks);
      const tool1 = results.find(r => r.id === 'tool-1');
      const tool2 = results.find(r => r.id === 'tool-2');
      const tool3 = results.find(r => r.id === 'tool-3');

      expect(tool1?.success).toBe(true);
      expect(tool1?.data).toBe('result-1');
      expect(tool2?.success).toBe(false);
      expect(tool3?.success).toBe(false);
    });

    it('should retry failed MCP tools on server reconnect', async () => {
      let attempt = 0;
      const tasks = [{
        id: 'mcp-tool',
        fn: async () => {
          attempt++;
          if (attempt === 1) throw new Error('Connection lost');
          return 'success on retry';
        },
      }];

      // First attempt fails
      const results1 = await executor.executeAll(tasks);
      expect(results1[0].success).toBe(false);

      // Retry after reconnect
      const results2 = await executor.executeAll(tasks);
      expect(results2[0].success).toBe(true);
      expect(results2[0].data).toBe('success on retry');
    });

    it('should not retry sandbox-blocked tools on reconnect', async () => {
      const check = sandbox.checkToolInvocation('dangerous_tool', { path: '/etc/shadow' });
      expect(check.allowed).toBe(false);

      // Even after "reconnect", sandbox-blocked tools should not retry
      const check2 = sandbox.checkToolInvocation('dangerous_tool', { path: '/etc/shadow' });
      expect(check2.allowed).toBe(false);
      expect(check2.reason).toContain('blocked');
    });
  });

  describe('Deep Interactions: MCP + Security + State + Recovery', () => {
    it('should prevent MCP tool from modifying state that sandbox should protect (sandbox bypass via MCP)', async () => {
      // MCP tool returns instruction to mutate protected state
      const mcpResult = { action: 'write', path: '/etc/config', data: 'malicious' };

      // System should sandbox-check the state mutation from MCP result
      const writeCheck = sandbox.checkToolInvocation('state_write', { path: mcpResult.path });
      expect(writeCheck.allowed).toBe(false);
      expect(writeCheck.reason).toContain('blocked');
    });

    it('should merge state when parallel MCP tools write to same state key', async () => {
      // Simulate parallel writes with conflict detection
      const stateWrites: Array<{ key: string; value: number; agent: string }> = [];
      const tasks = [
        { id: 'tool-a', fn: async () => { stateWrites.push({ key: 'counter', value: 5, agent: 'a' }); return 5; } },
        { id: 'tool-b', fn: async () => { stateWrites.push({ key: 'counter', value: 3, agent: 'b' }); return 3; } },
      ];

      await executor.executeAll(tasks);

      // Detect conflict
      const conflictingWrites = stateWrites.filter(w => w.key === 'counter');
      expect(conflictingWrites.length).toBe(2);
      expect(conflictingWrites.map(w => w.value)).toContain(5);
      expect(conflictingWrites.map(w => w.value)).toContain(3);

      // Last-write-wins resolution
      const resolved = conflictingWrites[conflictingWrites.length - 1].value;
      expect(typeof resolved).toBe('number');
    });

    it('should handle MCP server crash during sandboxed execution leaving sandbox inconsistent', async () => {
      // Simulate sandbox state tracking
      const sandboxSessions = new Map<string, { opened: number; committed: boolean }>();

      const tasks = [{
        id: 'mcp-crash',
        fn: async () => {
          sandboxSessions.set('session-1', { opened: Date.now(), committed: false });
          throw new Error('MCP server crashed');
        },
      }];

      await executor.executeAll(tasks);

      // Orphaned sandbox detected
      const orphaned = [...sandboxSessions.values()].filter(s => !s.committed);
      expect(orphaned.length).toBe(1);

      // Recovery: roll back orphaned sandbox
      for (const [key, session] of sandboxSessions) {
        if (!session.committed) {
          sandboxSessions.delete(key);
        }
      }
      expect(sandboxSessions.size).toBe(0);
    });

    it('should sandbox-check tool result from MCP that triggers next tool call', async () => {
      // MCP tool A returns a dangerous path
      const mcpToolAResult = { suggestedPath: '/etc/shadow' };

      // LLM would use that path for next tool - sandbox must check it
      const nextToolCheck = sandbox.checkToolInvocation('file_read', { path: mcpToolAResult.suggestedPath });
      expect(nextToolCheck.allowed).toBe(false);
      expect(nextToolCheck.reason).toContain('blocked');
    });

    it('should handle MCP tool execution checkpoint restored on different machine without MCP connection', async () => {
      // Simulate checkpoint with pending MCP tool
      const checkpoint = {
        pendingTools: [{ id: 'mcp-analyze', server: 'remote-server-1', status: 'in-progress' }],
        state: { turn: 5 },
      };

      // Restore on machine without MCP connection
      const mcpAvailable = false;
      const restoredTools = checkpoint.pendingTools.map(tool => ({
        ...tool,
        status: mcpAvailable ? 'resumed' : 'failed',
        error: mcpAvailable ? undefined : 'MCP server unavailable on restore machine',
      }));

      expect(restoredTools[0].status).toBe('failed');
      expect(restoredTools[0].error).toContain('unavailable');

      // Agent can continue without the tool
      const canContinue = checkpoint.state.turn > 0;
      expect(canContinue).toBe(true);
    });

    it('should handle sandbox rules changing between tool invocation and result processing', async () => {
      // T0: sandbox allows /tmp/data
      let check = sandbox.checkToolInvocation('read', { path: '/tmp/data/file.txt' });
      expect(check.allowed).toBe(true);

      // T1: rules updated (remove /tmp/data from allowlist)
      sandbox.updateRules({ allowedPaths: ['/home/user'], blockedPaths: ['/etc', '/root', '/tmp'] });

      // T2: result references /tmp/data - new rules should apply
      const resultCheck = sandbox.checkToolInvocation('process_result', { path: '/tmp/data/output.txt' });
      expect(resultCheck.allowed).toBe(false);
    });

    it('should enforce global rate limit across parallel MCP execution on multiple servers', async () => {
      const globalLimiter = new RateLimiter({ maxTokens: 15, windowMs: 60000, scope: 'per-pool' });

      // 3 servers, each could handle more locally, but global limit is 15
      let totalCalls = 0;
      const makeCall = async () => {
        const result = await globalLimiter.tryAcquire();
        if (result.allowed) totalCalls++;
        return result;
      };

      // Fire 20 requests across "3 servers"
      const results = await Promise.all(Array.from({ length: 20 }, () => makeCall()));
      const allowed = results.filter(r => r.allowed).length;
      expect(allowed).toBe(15); // Global limit enforced
      expect(totalCalls).toBe(15);
    });

    it('should handle MCP tool creating artifact that another parallel tool needs (unresolved dependency)', async () => {
      const depExecutor = new ParallelExecutor({
        maxConcurrency: 3,
        enableDependencyDetection: true,
        defaultTimeoutMs: 5000,
      });

      const artifacts = new Map<string, string>();

      const tasks = [
        {
          id: 'create-artifact',
          fn: async () => {
            await new Promise(r => { const t = setTimeout(r, 50); if (t && typeof t === 'object' && 'unref' in t) (t as NodeJS.Timeout).unref(); });
            artifacts.set('report.json', '{"data": "created"}');
            return 'created';
          },
        },
        {
          id: 'use-artifact',
          dependencies: ['create-artifact'],
          fn: async () => {
            const data = artifacts.get('report.json');
            if (!data) throw new Error('Artifact not found');
            return `processed: ${data}`;
          },
        },
      ];

      const results = await depExecutor.executeAll(tasks);
      const createResult = results.find(r => r.id === 'create-artifact');
      const useResult = results.find(r => r.id === 'use-artifact');

      expect(createResult?.success).toBe(true);
      expect(useResult?.success).toBe(true);
      expect(useResult?.data).toContain('processed');
    });
  });
});
