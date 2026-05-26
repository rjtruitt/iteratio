/**
 * Scenario Family 6: Full Tool Ecosystem
 * Tests file tools, shell tools, tool composition, custom tools,
 * versioning, sandboxing, parallel execution, timeouts, and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockToolExecutor,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  TestAgentFactory,
  TestClock,
  createMockTool,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { ToolRegistry } from '../../hub/ToolRegistry';
import { ToolSandbox } from '../../tools/ToolSandbox';
import { ToolPipeline } from '../../tools/ToolPipeline';

describe('Tool Ecosystem - E2E', () => {
  let llm: MockLLMProvider;
  let toolExecutor: MockToolExecutor;
  let eventBus: MockEventBus;
  let clock: TestClock;

  beforeEach(() => {
    llm = new MockLLMProvider();
    toolExecutor = new MockToolExecutor();
    eventBus = new MockEventBus();
    clock = new TestClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('file read/write tools', () => {
    it('should read a file and return its contents to the agent', async () => {
      toolExecutor.setResult('read_file', { success: true, data: { content: 'hello world' } });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'read_file', arguments: '{"path": "/tmp/test.txt"}' }
        ]),
        MockLLMProvider.simpleResponse('The file contains: hello world'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
      });

      const result = await agent.runTurn('Read /tmp/test.txt');
      expect(result.content).toContain('hello world');
      expect(toolExecutor.wasCalledWith('read_file')).toBe(true);
    });

    it('should write a file and confirm success', async () => {
      toolExecutor.setResult('write_file', { success: true, data: { bytesWritten: 11 } });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'write_file', arguments: '{"path": "/tmp/out.txt", "content": "hello world"}' }
        ]),
        MockLLMProvider.simpleResponse('File written successfully'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
      });

      const result = await agent.runTurn('Write hello world to /tmp/out.txt');
      expect(result.content).toContain('written');
      expect(toolExecutor.wasCalledWith('write_file')).toBe(true);
    });

    it('should handle file not found error gracefully', async () => {
      toolExecutor.setResult('read_file', { success: false, error: 'ENOENT: no such file' });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'read_file', arguments: '{"path": "/nonexistent"}' }
        ]),
        MockLLMProvider.simpleResponse('The file does not exist'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
      });

      const result = await agent.runTurn('Read /nonexistent');
      expect(result.content).toContain('does not exist');
    });
  });

  describe('shell command tool', () => {
    it('should execute a shell command and return output', async () => {
      toolExecutor.setResult('shell_exec', {
        success: true,
        data: { stdout: 'file1.txt\nfile2.txt\n', stderr: '', exitCode: 0 },
      });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'shell_exec', arguments: '{"command": "ls /tmp"}' }
        ]),
        MockLLMProvider.simpleResponse('The directory contains file1.txt and file2.txt'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
      });

      const result = await agent.runTurn('List files in /tmp');
      expect(toolExecutor.wasCalledWith('shell_exec')).toBe(true);
    });

    it('should handle non-zero exit code as tool error', async () => {
      toolExecutor.setResult('shell_exec', {
        success: false,
        error: 'Command failed with exit code 1',
        data: { stdout: '', stderr: 'Permission denied', exitCode: 1 },
      });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'shell_exec', arguments: '{"command": "rm /protected"}' }
        ]),
        MockLLMProvider.simpleResponse('Permission denied for that operation'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
      });

      const result = await agent.runTurn('Delete /protected');
      expect(result.content).toContain('denied');
    });
  });

  describe('tool composition', () => {
    it('should chain tool outputs: output of tool A becomes input of tool B', async () => {
      toolExecutor.setResult('search', { success: true, data: { results: ['file1.txt', 'file2.txt'] } });
      toolExecutor.setResult('read_file', { success: true, data: { content: 'important data' } });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'search', arguments: '{"query": "important"}' }
        ]),
        MockLLMProvider.toolCallResponse([
          { id: 'tc2', name: 'read_file', arguments: '{"path": "file1.txt"}' }
        ]),
        MockLLMProvider.simpleResponse('Found and read the file: important data'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
      });

      const result = await agent.runTurn('Find and read the important file');
      expect(toolExecutor.callCount).toBe(2);
      expect(result.content).toContain('important data');
    });

    it('should support declarative tool pipelines', async () => {
      const pipeline = new ToolPipeline({
        steps: [
          { tool: 'search', transform: (input: any) => ({ query: input.keyword }) },
          { tool: 'read_file', transform: (searchResult: any) => ({ path: searchResult.results[0] }) },
          { tool: 'summarize', transform: (fileContent: any) => ({ text: fileContent.content }) },
        ],
        toolExecutor,
      });

      toolExecutor.setResult('search', { success: true, data: { results: ['doc.txt'] } });
      toolExecutor.setResult('read_file', { success: true, data: { content: 'Long document...' } });
      toolExecutor.setResult('summarize', { success: true, data: { summary: 'Brief summary' } });

      const result = await pipeline.execute({ keyword: 'report' });
      expect(result.data.summary).toBe('Brief summary');
      expect(toolExecutor.callCount).toBe(3);
    });
  });

  describe('custom user-defined tools', () => {
    it('should register and execute a custom tool', async () => {
      const registry = new ToolRegistry();

      registry.register({
        name: 'calculate_roi',
        description: 'Calculate return on investment',
        schema: { type: 'object', properties: { investment: { type: 'number' }, return: { type: 'number' } } },
        execute: async (args: any) => ({
          success: true,
          data: { roi: ((args.return - args.investment) / args.investment * 100).toFixed(2) + '%' },
        }),
      });

      const tool = registry.getTool('calculate_roi');
      expect(tool).toBeDefined();

      const result = await tool!.execute({ investment: 1000, return: 1500 });
      expect(result.data.roi).toBe('50.00%');
    });

    it('should validate custom tool input against schema', async () => {
      const registry = new ToolRegistry();

      registry.register({
        name: 'typed_tool',
        description: 'A strongly typed tool',
        schema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
        execute: async (args: any) => ({ success: true, data: args }),
      });

      const validation = registry.validate('typed_tool', { name: 'Test' }); // Missing 'age'
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('age');
    });

    it('should list all registered tools with definitions', async () => {
      const registry = new ToolRegistry();
      registry.register({ name: 'tool_a', description: 'Tool A', schema: {}, execute: async () => ({ success: true, data: {} }) });
      registry.register({ name: 'tool_b', description: 'Tool B', schema: {}, execute: async () => ({ success: true, data: {} }) });

      const definitions = registry.getDefinitions();
      expect(definitions).toHaveLength(2);
      expect(definitions.map(d => d.name)).toContain('tool_a');
      expect(definitions.map(d => d.name)).toContain('tool_b');
    });
  });

  describe('tool versioning', () => {
    it('should support v1 and v2 of a tool coexisting', async () => {
      const registry = new ToolRegistry();

      registry.register({
        name: 'search',
        version: '1.0',
        description: 'Search v1',
        schema: {},
        execute: async () => ({ success: true, data: { version: 'v1', results: [] } }),
      });

      registry.register({
        name: 'search',
        version: '2.0',
        description: 'Search v2 with filters',
        schema: {},
        execute: async () => ({ success: true, data: { version: 'v2', results: [], filters: true } }),
      });

      const v1 = await registry.executeTool('search', {}, { version: '1.0' });
      const v2 = await registry.executeTool('search', {}, { version: '2.0' });

      expect(v1.data.version).toBe('v1');
      expect(v2.data.version).toBe('v2');
    });

    it('should default to latest version when no version specified', async () => {
      const registry = new ToolRegistry();

      registry.register({ name: 'api', version: '1.0', description: '', schema: {}, execute: async () => ({ success: true, data: { v: 1 } }) });
      registry.register({ name: 'api', version: '2.0', description: '', schema: {}, execute: async () => ({ success: true, data: { v: 2 } }) });

      const result = await registry.executeTool('api', {});
      expect(result.data.v).toBe(2);
    });
  });

  describe('tool sandboxing', () => {
    it('should block path traversal attempts', async () => {
      const sandbox = new ToolSandbox({
        allowedPaths: ['/project/', '/tmp/'],
        blockedCommands: ['rm -rf', 'sudo'],
      });

      const result = sandbox.validateToolCall('read_file', { path: '/etc/passwd' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('path');
    });

    it('should block dangerous shell commands', async () => {
      const sandbox = new ToolSandbox({
        allowedPaths: ['/project/'],
        blockedCommands: ['rm -rf', 'sudo', 'chmod 777'],
      });

      const result = sandbox.validateToolCall('shell_exec', { command: 'sudo rm -rf /' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('blocked');
    });

    it('should allow safe operations within sandbox', async () => {
      const sandbox = new ToolSandbox({
        allowedPaths: ['/project/', '/tmp/'],
        blockedCommands: ['rm -rf'],
      });

      const result = sandbox.validateToolCall('read_file', { path: '/project/src/index.ts' });
      expect(result.allowed).toBe(true);
    });

    it('should enforce resource limits (file size, memory)', async () => {
      const sandbox = new ToolSandbox({
        allowedPaths: ['/project/'],
        maxFileSize: 1024 * 1024, // 1MB
        maxMemoryMB: 256,
      });

      const result = sandbox.validateToolCall('write_file', {
        path: '/project/big.bin',
        content: 'x'.repeat(2 * 1024 * 1024), // 2MB
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('size');
    });
  });

  describe('parallel tool execution', () => {
    it('should execute 3 independent tools simultaneously', async () => {
      toolExecutor.setResult('tool_a', { success: true, data: { a: 1 } });
      toolExecutor.setResult('tool_b', { success: true, data: { b: 2 } });
      toolExecutor.setResult('tool_c', { success: true, data: { c: 3 } });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'tool_a', arguments: '{}' },
          { id: 'tc2', name: 'tool_b', arguments: '{}' },
          { id: 'tc3', name: 'tool_c', arguments: '{}' },
        ]),
        MockLLMProvider.simpleResponse('All three tools returned results'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
        toolExecutionMode: 'parallel',
      });

      const result = await agent.runTurn('Run all three tools');
      expect(toolExecutor.callCount).toBe(3);
    });

    it('should collect all parallel results before continuing', async () => {
      const slowExecutor = new MockToolExecutor({ delayMs: 100 });
      slowExecutor.setResult('slow_a', { success: true, data: { done: 'a' } });
      slowExecutor.setResult('slow_b', { success: true, data: { done: 'b' } });

      const results = await slowExecutor.executeTools(
        [
          { id: 'tc1', name: 'slow_a', arguments: {} },
          { id: 'tc2', name: 'slow_b', arguments: {} },
        ],
        { agentId: 'test' },
        'parallel',
      );

      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe('tool timeout', () => {
    it('should timeout a tool that exceeds the deadline', async () => {
      const slowExecutor = new MockToolExecutor({ delayMs: 5000 });

      const registry = new ToolRegistry({ defaultTimeout: 1000 });
      registry.registerExecutor(slowExecutor);

      const resultPromise = registry.executeTool('slow_tool', {});
      clock.advance(1500);

      await expect(resultPromise).rejects.toThrow(/timeout/i);
    });

    it('should allow per-tool timeout configuration', async () => {
      const registry = new ToolRegistry({ defaultTimeout: 1000 });

      registry.register({
        name: 'long_running',
        description: 'A tool that takes a while',
        schema: {},
        timeout: 30000, // 30 second timeout for this specific tool
        execute: async () => {
          // Simulates long work
          return { success: true, data: { result: 'done' } };
        },
      });

      const tool = registry.getTool('long_running');
      expect(tool!.timeout).toBe(30000);
    });
  });

  describe('tool error handling', () => {
    it('should continue with other tools when one fails', async () => {
      toolExecutor.setResult('good_tool', { success: true, data: { ok: true } });
      // bad_tool will throw because of the MockToolExecutor option
      const executor = new MockToolExecutor({ throwOnTool: 'bad_tool' });
      executor.setResult('good_tool', { success: true, data: { ok: true } });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'bad_tool', arguments: '{}' },
          { id: 'tc2', name: 'good_tool', arguments: '{}' },
        ]),
        MockLLMProvider.simpleResponse('One tool failed but the other succeeded'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor: executor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
        toolExecutionMode: 'parallel',
        continueOnToolError: true,
      });

      const result = await agent.runTurn('Run both tools');
      expect(result.content).toContain('succeeded');
    });

    it('should include error details in tool result message', async () => {
      const executor = new MockToolExecutor({
        throwOnTool: 'failing_tool',
        throwError: new Error('Database connection failed'),
      });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'failing_tool', arguments: '{}' }
        ]),
        MockLLMProvider.simpleResponse('The tool failed due to database error'),
      );

      const messageManager = new MockMessageManager();
      const agent = new AgentLoop({
        llm,
        toolExecutor: executor,
        stateManager: new MockStateManager(),
        messageManager,
        eventBus,
        continueOnToolError: true,
      });

      await agent.runTurn('Use failing_tool');

      // The error should be present in the conversation as a tool result
      const messages = messageManager.getMessages();
      const errorMsg = messages.find(m => m.role === 'tool' && m.content?.includes('Database connection'));
      expect(errorMsg).toBeDefined();
    });

    it('should retry failed tools up to configured max', async () => {
      let attempts = 0;
      const registry = new ToolRegistry({ retryOnError: { maxRetries: 3 } });
      registry.register({
        name: 'flaky_tool',
        description: 'Sometimes fails',
        schema: {},
        execute: async () => {
          attempts++;
          if (attempts < 3) throw new Error('Transient error');
          return { success: true, data: { attempt: attempts } };
        },
      });

      const result = await registry.executeTool('flaky_tool', {});
      expect(result.success).toBe(true);
      expect(result.data.attempt).toBe(3);
    });
  });

  describe('Edge Cases', () => {
    it('should handle tool returning result after being cancelled', async () => {
      const registry = new ToolRegistry({ defaultTimeout: 1000 });
      let resolveToolExecution: ((value: any) => void) | null = null;

      registry.register({
        name: 'slow_cancelled_tool',
        description: 'Returns result after cancellation',
        schema: {},
        execute: async () => {
          return new Promise((resolve) => {
            resolveToolExecution = resolve;
          });
        },
      });

      const resultPromise = registry.executeTool('slow_cancelled_tool', {});
      clock.advance(1500); // Timeout fires

      // Tool eventually returns (after being cancelled)
      resolveToolExecution!({ success: true, data: { late: true } });

      // Should have timed out, late result should be discarded
      await expect(resultPromise).rejects.toThrow(/timeout/i);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle tool that writes to file deleted during execution', async () => {
      toolExecutor.setResult('write_file', {
        success: false,
        error: 'ENOENT: target directory was removed during write',
      });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'write_file', arguments: '{"path": "/tmp/vanishing/file.txt", "content": "data"}' }
        ]),
        MockLLMProvider.simpleResponse('The write failed because the directory disappeared'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
        continueOnToolError: true,
      });

      const result = await agent.runTurn('Write to the file');
      expect(result.content).toContain('failed');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle tool execution with 0-byte input', async () => {
      toolExecutor.setResult('process_data', { success: true, data: { processed: 0 } });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'process_data', arguments: '{}' } // Empty input
        ]),
        MockLLMProvider.simpleResponse('Processed empty input'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
      });

      const result = await agent.runTurn('Process nothing');
      expect(toolExecutor.wasCalledWith('process_data')).toBe(true);
      expect(result).toBeDefined();
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle tool that spawns subprocess outliving the tool timeout', async () => {
      const registry = new ToolRegistry({ defaultTimeout: 2000 });

      registry.register({
        name: 'spawn_tool',
        description: 'Spawns a subprocess',
        schema: {},
        execute: async () => {
          // Tool "starts" a background process but returns quickly
          return { success: true, data: { pid: 12345, note: 'subprocess still running' } };
        },
      });

      const result = await registry.executeTool('spawn_tool', {});

      // Tool succeeded but subprocess outlives it
      // Framework should track orphaned processes or at least not crash
      expect(result.success).toBe(true);
      expect(result.data.pid).toBeDefined();
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle tool composition where inner tool modifies outer tool input', async () => {
      const pipeline = new ToolPipeline({
        steps: [
          { tool: 'fetch_data', transform: (input: any) => ({ url: input.url }) },
          { tool: 'transform_data', transform: (prev: any) => ({ data: prev.data, mutate: true }) },
        ],
        toolExecutor,
      });

      toolExecutor.setResult('fetch_data', { success: true, data: { data: { original: true } } });
      // transform_data modifies the original input object (mutation)
      toolExecutor.setResult('transform_data', { success: true, data: { data: { original: true, mutated: true } } });

      const result = await pipeline.execute({ url: 'http://example.com' });

      // Pipeline should isolate inputs between steps (no mutation leakage)
      expect(result.data.data.mutated).toBe(true);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle parallel tool execution where tools share a resource (lock contention)', async () => {
      const sharedResource = { locked: false, value: 0 };
      const executor = new MockToolExecutor();

      // Two tools that both try to access the same shared resource
      executor.setResult('tool_x', { success: true, data: { value: 1 } });
      executor.setResult('tool_y', { success: true, data: { value: 2 } });

      llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'tool_x', arguments: '{}' },
          { id: 'tc2', name: 'tool_y', arguments: '{}' },
        ]),
        MockLLMProvider.simpleResponse('Both tools competed for the resource'),
      );

      const agent = new AgentLoop({
        llm,
        toolExecutor: executor,
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        eventBus,
        toolExecutionMode: 'parallel',
      });

      const result = await agent.runTurn('Run competing tools');

      // Both should complete without deadlock or data corruption
      expect(executor.callCount).toBe(2);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle tool that returns streaming result (partial data)', async () => {
      const registry = new ToolRegistry();

      registry.register({
        name: 'streaming_tool',
        description: 'Returns results incrementally',
        schema: {},
        execute: async function* () {
          yield { chunk: 'part1' };
          yield { chunk: 'part2' };
          yield { chunk: 'part3' };
        } as any,
      });

      const result = await registry.executeTool('streaming_tool', {});

      // Should collect all chunks or handle streaming protocol
      expect(result.success).toBe(true);
      expect(result.data.chunks).toHaveLength(3);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle tool with circular dependency (A needs B, B needs A)', async () => {
      const pipeline = new ToolPipeline({
        steps: [
          { tool: 'tool_a', transform: (input: any) => ({ needsB: true }) },
          { tool: 'tool_b', transform: (prev: any) => ({ needsA: true }) },
        ],
        toolExecutor,
        dependencyGraph: {
          'tool_a': ['tool_b'],
          'tool_b': ['tool_a'], // Circular!
        },
      });

      // Should detect circular dependency and error clearly
      await expect(pipeline.validate()).rejects.toThrow(/circular|cycle|dependency/i);
      expect(true).toBe(false); // RED: not implemented
    });
  });
});
