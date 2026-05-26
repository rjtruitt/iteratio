/**
 * Scenario Family 1: MCP Server Integration
 * Tests the full MCP (Model Context Protocol) server lifecycle including
 * tool discovery, multi-server merging, crash recovery, resource access,
 * version updates, auth refresh, and timeout handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MockLLMProvider,
  MockToolExecutor,
  MockTransport,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  TestAgentFactory,
  TestClock,
  createMockTool,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { MCPClient } from '../../mcp/MCPClient';
import { MCPServerRegistry } from '../../mcp/MCPServerRegistry';
import { MCPToolAdapter } from '../../mcp/MCPToolAdapter';

describe('MCP Integration - E2E', () => {
  let ctx: ReturnType<typeof TestAgentFactory.create>;
  let clock: TestClock;

  beforeEach(() => {
    ctx = TestAgentFactory.create();
    clock = new TestClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('single server connection and tool discovery', () => {
    it('should connect to an MCP server and discover available tools', async () => {
      // MCP server exposes 3 tools: read_file, write_file, search
      const mcpClient = new MCPClient({ uri: 'stdio://test-server' });
      await mcpClient.connect();

      const tools = await mcpClient.listTools();
      expect(tools).toHaveLength(3);
      expect(tools.map(t => t.name)).toContain('read_file');
      expect(tools.map(t => t.name)).toContain('write_file');
      expect(tools.map(t => t.name)).toContain('search');
    });

    it('should use a discovered MCP tool during an agent turn', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://test-server' });
      const adapter = new MCPToolAdapter(mcpClient);

      ctx.llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'mcp:read_file', arguments: '{"path": "/tmp/test.txt"}' }
        ]),
        MockLLMProvider.simpleResponse('File contents are: hello world'),
      );

      const agent = new AgentLoop({
        llm: ctx.llm,
        toolExecutor: adapter,
        stateManager: ctx.stateManager,
        messageManager: ctx.messageManager,
        eventBus: ctx.eventBus,
      });

      const result = await agent.runTurn('Read the file /tmp/test.txt');
      expect(result.content).toContain('hello world');
      expect(adapter.callCount).toBe(1);
    });

    it('should propagate tool execution results back through the conversation', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://test-server' });
      const adapter = new MCPToolAdapter(mcpClient);

      ctx.llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'mcp:search', arguments: '{"query": "iteratio"}' }
        ]),
        MockLLMProvider.simpleResponse('Found 5 results for iteratio'),
      );

      const agent = new AgentLoop({
        llm: ctx.llm,
        toolExecutor: adapter,
        stateManager: ctx.stateManager,
        messageManager: ctx.messageManager,
        eventBus: ctx.eventBus,
      });

      const result = await agent.runTurn('Search for iteratio');
      // The tool result should be injected as a tool_result message
      const messages = ctx.messageManager.getMessages();
      const toolResultMsg = messages.find(m => m.role === 'tool');
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg!.content).toContain('iteratio');
    });

    it('should handle MCP server returning an error for a tool call', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://test-server' });
      const adapter = new MCPToolAdapter(mcpClient);
      // Simulate server returning an error
      adapter.setServerError('mcp:read_file', new Error('File not found'));

      ctx.llm = MockLLMProvider.sequencedResponses(
        MockLLMProvider.toolCallResponse([
          { id: 'tc1', name: 'mcp:read_file', arguments: '{"path": "/no/such/file"}' }
        ]),
        MockLLMProvider.simpleResponse('The file was not found.'),
      );

      const agent = new AgentLoop({
        llm: ctx.llm,
        toolExecutor: adapter,
        stateManager: ctx.stateManager,
        messageManager: ctx.messageManager,
        eventBus: ctx.eventBus,
      });

      const result = await agent.runTurn('Read /no/such/file');
      expect(result.content).toContain('not found');
    });
  });

  describe('multi-server management', () => {
    it('should connect to 3 MCP servers and merge their tool lists', async () => {
      const registry = new MCPServerRegistry();

      await registry.addServer({ uri: 'stdio://file-server', name: 'files' });
      await registry.addServer({ uri: 'stdio://git-server', name: 'git' });
      await registry.addServer({ uri: 'stdio://web-server', name: 'web' });

      const allTools = await registry.getAllTools();

      // Each server provides unique tools, all merged together
      expect(allTools.length).toBeGreaterThanOrEqual(6);
      // Tools are namespaced by server
      expect(allTools.some(t => t.name.startsWith('files:'))).toBe(true);
      expect(allTools.some(t => t.name.startsWith('git:'))).toBe(true);
      expect(allTools.some(t => t.name.startsWith('web:'))).toBe(true);
    });

    it('should handle name collisions across servers with namespacing', async () => {
      const registry = new MCPServerRegistry();

      // Both servers have a "search" tool
      await registry.addServer({ uri: 'stdio://server-a', name: 'a' });
      await registry.addServer({ uri: 'stdio://server-b', name: 'b' });

      const allTools = await registry.getAllTools();
      const searchTools = allTools.filter(t => t.name.includes('search'));

      // Should have both a:search and b:search, not overwritten
      expect(searchTools.length).toBe(2);
      expect(searchTools.map(t => t.name)).toContain('a:search');
      expect(searchTools.map(t => t.name)).toContain('b:search');
    });

    it('should route tool calls to the correct server based on namespace', async () => {
      const registry = new MCPServerRegistry();
      await registry.addServer({ uri: 'stdio://file-server', name: 'files' });
      await registry.addServer({ uri: 'stdio://git-server', name: 'git' });

      const result = await registry.executeTool('git:commit', { message: 'test' });
      expect(result.server).toBe('git');
      expect(result.success).toBe(true);
    });

    it('should report partial availability when one server is down', async () => {
      const registry = new MCPServerRegistry();
      await registry.addServer({ uri: 'stdio://file-server', name: 'files' });
      await registry.addServer({ uri: 'stdio://dead-server', name: 'dead' });

      const status = registry.getStatus();
      expect(status.servers.files.connected).toBe(true);
      expect(status.servers.dead.connected).toBe(false);
      expect(status.availableToolCount).toBeGreaterThan(0);
    });
  });

  describe('crash and reconnection', () => {
    it('should detect server crash mid-execution', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://unstable-server' });
      await mcpClient.connect();

      // Server crashes after tool call is sent but before response
      mcpClient.simulateCrash();

      await expect(mcpClient.callTool('search', { q: 'test' }))
        .rejects.toThrow(/server disconnected|connection lost/i);
    });

    it('should reconnect to server after crash and retry the tool call', async () => {
      const mcpClient = new MCPClient({
        uri: 'stdio://unstable-server',
        reconnect: { maxRetries: 3, backoffMs: 100 },
      });
      await mcpClient.connect();

      // First call crashes, second call should succeed after reconnect
      mcpClient.simulateCrashOnNextCall();

      const result = await mcpClient.callTool('search', { q: 'test' });
      expect(result.success).toBe(true);
      expect(mcpClient.reconnectCount).toBe(1);
    });

    it('should give up after max retries and propagate error', async () => {
      const mcpClient = new MCPClient({
        uri: 'stdio://permanently-dead',
        reconnect: { maxRetries: 2, backoffMs: 10 },
      });

      mcpClient.setPermanentlyUnavailable(true);

      await expect(mcpClient.connect()).rejects.toThrow(/max retries exceeded/i);
    });

    it('should emit events during reconnection cycle', async () => {
      const mcpClient = new MCPClient({
        uri: 'stdio://unstable-server',
        reconnect: { maxRetries: 3, backoffMs: 50 },
      });
      await mcpClient.connect();

      const events: string[] = [];
      mcpClient.on('disconnected', () => events.push('disconnected'));
      mcpClient.on('reconnecting', () => events.push('reconnecting'));
      mcpClient.on('reconnected', () => events.push('reconnected'));

      mcpClient.simulateCrashOnNextCall();
      await mcpClient.callTool('ping', {});

      expect(events).toEqual(['disconnected', 'reconnecting', 'reconnected']);
    });
  });

  describe('resource access', () => {
    it('should list resources exposed by an MCP server', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://resource-server' });
      await mcpClient.connect();

      const resources = await mcpClient.listResources();
      expect(resources.length).toBeGreaterThan(0);
      expect(resources[0]).toHaveProperty('uri');
      expect(resources[0]).toHaveProperty('name');
      expect(resources[0]).toHaveProperty('mimeType');
    });

    it('should read a resource by URI', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://resource-server' });
      await mcpClient.connect();

      const content = await mcpClient.readResource('file:///project/README.md');
      expect(content).toBeDefined();
      expect(content.mimeType).toBe('text/markdown');
      expect(content.text).toContain('# Project');
    });

    it('should inject resource content into agent context before tool use', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://resource-server' });
      const adapter = new MCPToolAdapter(mcpClient);

      const agent = new AgentLoop({
        llm: ctx.llm,
        toolExecutor: adapter,
        stateManager: ctx.stateManager,
        messageManager: ctx.messageManager,
        eventBus: ctx.eventBus,
        mcpResources: ['file:///project/config.json'],
      });

      await agent.runTurn('Check the project config');
      // Resource content should appear in system prompt or context
      const messages = ctx.messageManager.getMessages();
      const systemMsg = messages.find(m => m.role === 'system');
      expect(systemMsg?.content).toContain('config.json');
    });
  });

  describe('tool version updates', () => {
    it('should detect when a server updates tool definitions', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://evolving-server' });
      await mcpClient.connect();

      const toolsV1 = await mcpClient.listTools();
      expect(toolsV1.find(t => t.name === 'search')?.version).toBe('1.0');

      // Server pushes updated tool definition
      mcpClient.simulateToolUpdate('search', { version: '2.0', newParam: 'filter' });

      const toolsV2 = await mcpClient.listTools();
      expect(toolsV2.find(t => t.name === 'search')?.version).toBe('2.0');
    });

    it('should notify the agent when tool schemas change', async () => {
      const mcpClient = new MCPClient({ uri: 'stdio://evolving-server' });
      await mcpClient.connect();

      const updates: string[] = [];
      mcpClient.on('tools/updated', (data: any) => updates.push(data.toolName));

      mcpClient.simulateToolUpdate('search', { version: '2.0' });

      expect(updates).toContain('search');
    });
  });

  describe('auth token refresh', () => {
    it('should refresh auth token during long-running operation', async () => {
      const mcpClient = new MCPClient({
        uri: 'stdio://auth-server',
        auth: { token: 'initial-token', refreshFn: async () => 'refreshed-token' },
      });
      await mcpClient.connect();

      // Simulate token expiry during a long tool call
      mcpClient.simulateTokenExpiry();

      const result = await mcpClient.callTool('long_operation', { data: 'test' });
      expect(result.success).toBe(true);
      expect(mcpClient.currentToken).toBe('refreshed-token');
    });

    it('should fail gracefully when token refresh itself fails', async () => {
      const mcpClient = new MCPClient({
        uri: 'stdio://auth-server',
        auth: {
          token: 'initial-token',
          refreshFn: async () => { throw new Error('Refresh denied'); },
        },
      });
      await mcpClient.connect();
      mcpClient.simulateTokenExpiry();

      await expect(mcpClient.callTool('protected_op', {}))
        .rejects.toThrow(/auth|unauthorized|refresh denied/i);
    });
  });

  describe('server timeout and graceful degradation', () => {
    it('should timeout when server does not respond within deadline', async () => {
      const mcpClient = new MCPClient({
        uri: 'stdio://slow-server',
        timeout: 1000,
      });
      await mcpClient.connect();

      // Server will not respond, clock advances past timeout
      const callPromise = mcpClient.callTool('slow_tool', {});
      clock.advance(1500);

      await expect(callPromise).rejects.toThrow(/timeout/i);
    });

    it('should degrade gracefully when MCP server is unavailable', async () => {
      const registry = new MCPServerRegistry();
      await registry.addServer({ uri: 'stdio://main-server', name: 'main' });

      // Main server becomes unavailable
      registry.simulateServerDown('main');

      const adapter = registry.createAdapter();
      const agent = new AgentLoop({
        llm: ctx.llm,
        toolExecutor: adapter,
        stateManager: ctx.stateManager,
        messageManager: ctx.messageManager,
        eventBus: ctx.eventBus,
      });

      // Agent should still work, just without MCP tools
      ctx.llm = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('I cannot use external tools right now'),
      });

      const result = await agent.runTurn('Use the search tool');
      expect(result.content).toContain('cannot');
    });

    it('should emit degradation events when server becomes unresponsive', async () => {
      const mcpClient = new MCPClient({
        uri: 'stdio://flaky-server',
        timeout: 500,
      });
      await mcpClient.connect();

      const events: string[] = [];
      mcpClient.on('degraded', () => events.push('degraded'));

      // Three consecutive timeouts should trigger degradation
      for (let i = 0; i < 3; i++) {
        try {
          const p = mcpClient.callTool('flaky_tool', {});
          clock.advance(600);
          await p;
        } catch { /* expected */ }
      }

      expect(events).toContain('degraded');
    });

    it('should recover from degraded state when server responds again', async () => {
      const mcpClient = new MCPClient({
        uri: 'stdio://recovering-server',
        timeout: 500,
      });
      await mcpClient.connect();

      // Server goes degraded
      mcpClient.simulateDegradation();
      expect(mcpClient.status).toBe('degraded');

      // Server recovers
      mcpClient.simulateRecovery();
      const result = await mcpClient.callTool('ping', {});

      expect(result.success).toBe(true);
      expect(mcpClient.status).toBe('connected');
    });
  });

  describe('Edge Cases', () => {
    it('should handle server that accepts connection but never responds to tool discovery', async () => {
      // Server accepts TCP/stdio connection but never sends tool list response
      const mcpClient = new MCPClient({
        uri: 'stdio://silent-server',
        timeout: 2000,
      });
      await mcpClient.connect();

      const listPromise = mcpClient.listTools();
      clock.advance(2500);

      await expect(listPromise).rejects.toThrow(/timeout/i);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle tool discovery returning tools with identical names from different servers', async () => {
      // Two servers both expose a tool named "execute" with different schemas
      const registry = new MCPServerRegistry();
      await registry.addServer({ uri: 'stdio://server-x', name: 'x' });
      await registry.addServer({ uri: 'stdio://server-y', name: 'y' });

      // Both servers have a tool called "execute" with completely different semantics
      const allTools = await registry.getAllTools();
      const executeTools = allTools.filter(t => t.name.includes('execute'));

      // Should disambiguate without data loss
      expect(executeTools.length).toBe(2);
      expect(executeTools[0].schema).not.toEqual(executeTools[1].schema);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle MCP server rate limiting the client (429 response)', async () => {
      // Server returns HTTP 429 Too Many Requests
      const mcpClient = new MCPClient({ uri: 'stdio://rate-limited-server' });
      await mcpClient.connect();

      mcpClient.simulateRateLimit({ retryAfterMs: 1000 });

      const result = await mcpClient.callTool('search', { q: 'test' });

      // Should respect retry-after and eventually succeed
      expect(result.success).toBe(true);
      expect(mcpClient.retryCount).toBeGreaterThan(0);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle tool execution returning empty result (no error, no data)', async () => {
      // Tool returns success but with completely empty/null/undefined data
      const mcpClient = new MCPClient({ uri: 'stdio://empty-server' });
      await mcpClient.connect();

      const result = await mcpClient.callTool('void_tool', {});

      // Should not crash, should represent empty result cleanly
      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle concurrent tool executions exceeding server connection pool', async () => {
      // Server has a pool of 3 connections, but client fires 10 concurrent calls
      const mcpClient = new MCPClient({
        uri: 'stdio://pooled-server',
        maxConcurrent: 10,
      });
      await mcpClient.connect();

      const calls = Array.from({ length: 10 }, (_, i) =>
        mcpClient.callTool('compute', { id: i })
      );

      const results = await Promise.allSettled(calls);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // Some should succeed, excess should be queued or error gracefully
      expect(fulfilled.length + rejected.length).toBe(10);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle server sending malformed SSE events', async () => {
      // Server sends invalid SSE data (missing event field, broken JSON, etc.)
      const mcpClient = new MCPClient({ uri: 'sse://malformed-server' });
      await mcpClient.connect();

      mcpClient.simulateMalformedSSE('data: {broken json\n\n');

      // Should not crash the client, should log/emit error
      expect(mcpClient.status).not.toBe('crashed');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle auth token expiring during multi-turn tool usage session', async () => {
      // Token expires between the 2nd and 3rd tool call in a multi-tool turn
      const mcpClient = new MCPClient({
        uri: 'stdio://auth-server',
        auth: { token: 'short-lived-token', refreshFn: async () => 'new-token' },
      });
      await mcpClient.connect();

      // First call works
      await mcpClient.callTool('tool_a', {});

      // Token expires mid-session
      mcpClient.simulateTokenExpiry();

      // Second call should trigger refresh and succeed without user intervention
      const result = await mcpClient.callTool('tool_b', {});
      expect(result.success).toBe(true);
      expect(mcpClient.currentToken).toBe('new-token');
      expect(true).toBe(false); // RED: not implemented
    });
  });
});
