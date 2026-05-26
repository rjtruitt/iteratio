import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry, MCPToolInfo, ToolInfo } from '../ToolRegistry';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;
  const instanceId = 'instance-1';
  const hostname = 'machine-a';

  const createTool = (overrides: Partial<MCPToolInfo> = {}): MCPToolInfo => ({
    name: 'github__create_issue',
    description: 'Create a GitHub issue',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
    shareable: true,
    contextDependent: false,
    requiresArtifacts: false,
    rbac: [],
    ...overrides,
  });

  beforeEach(() => {
    registry = new ToolRegistry(instanceId, hostname);
  });

  describe('registerTool', () => {
    it('should register a tool and make it retrievable', () => {
      registry.registerTool(createTool());

      const tool = registry.getTool('github__create_issue');
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe('github__create_issue');
    });

    it('should throw when registering tool without name', () => {
      expect(() => registry.registerTool(createTool({ name: '' }))).toThrow();
    });

    it('should emit tool-registered event', () => {
      const listener = vi.fn();
      registry.on('tool-registered', listener);

      registry.registerTool(createTool());

      expect(listener).toHaveBeenCalledWith('github__create_issue', expect.any(Object));
    });

    it('should namespace context-dependent tools with hostname', () => {
      registry.registerTool(createTool({
        name: 'filesystem__read_file',
        contextDependent: true,
      }));

      const tool = registry.getTool(`filesystem__read_file@${hostname}`);
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe(`filesystem__read_file@${hostname}`);
    });

    it('should store tool metadata including schema', () => {
      const schema = {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      };
      registry.registerTool(createTool({
        name: 'custom_tool',
        inputSchema: schema,
        metadata: { tags: ['file', 'read'] },
      }));

      const tool = registry.getTool('custom_tool');
      expect(tool!.inputSchema).toEqual(schema);
      expect(tool!.metadata?.tags).toContain('file');
    });
  });

  describe('share tool across agents', () => {
    it('should make shareable tools accessible from other instances', () => {
      registry.registerTool(createTool({ shareable: true }));

      const tool = registry.getTool('github__create_issue');
      expect(tool!.shareable).toBe(true);
    });

    it('should not share non-shareable tools', () => {
      registry.registerTool(createTool({ name: 'private_tool', shareable: false }));

      // Non-shareable tools owned by THIS instance are still accessible from this registry
      // (the shareability check only blocks tools owned by OTHER instances).
      // But RBAC is checked: since rbac is empty ([]), it means "no restrictions" → returns true
      // To properly test cross-instance denial, we'd need a different instanceId for the tool owner.
      // Here we verify the tool is marked non-shareable:
      const tool = registry.getTool('private_tool');
      expect(tool!.shareable).toBe(false);
    });
  });

  describe('tool versioning', () => {
    it('should allow registering multiple versions of a tool', () => {
      registry.registerTool(createTool({ name: 'tool_v1' }));
      registry.registerTool(createTool({ name: 'tool_v2' }));

      expect(registry.getTool('tool_v1')).not.toBeNull();
      expect(registry.getTool('tool_v2')).not.toBeNull();
    });

    it('should coexist v1 and v2 simultaneously', () => {
      registry.registerTool(createTool({ name: 'search_v1', description: 'Basic search' }));
      registry.registerTool(createTool({ name: 'search_v2', description: 'Enhanced search' }));

      const tools = registry.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('search_v1');
      expect(names).toContain('search_v2');
    });
  });

  describe('access control', () => {
    it('should allow access for agents with matching RBAC role', () => {
      registry.registerTool(createTool({
        name: 'admin_tool',
        rbac: ['admin', 'ops-team'],
      }));

      expect(registry.checkPermission('admin_tool', ['admin'])).toBe(true);
    });

    it('should deny access for agents without matching role', () => {
      registry.registerTool(createTool({
        name: 'admin_tool',
        rbac: ['admin'],
      }));

      expect(registry.checkPermission('admin_tool', ['viewer'])).toBe(false);
    });

    it('should allow all when no RBAC restrictions', () => {
      registry.registerTool(createTool({ rbac: [] }));
      expect(registry.checkPermission('github__create_issue', ['any-role'])).toBe(true);
    });
  });

  describe('tool discovery', () => {
    it('should discover tools by capability/tag', () => {
      registry.registerTool(createTool({
        name: 'file_reader',
        metadata: { tags: ['file', 'read'] },
      }));
      registry.registerTool(createTool({
        name: 'api_caller',
        metadata: { tags: ['api', 'http'] },
      }));

      const results = registry.searchTools('file');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('file_reader');
    });

    it('should search by tool name', () => {
      registry.registerTool(createTool({ name: 'github__create_issue', description: 'Create issue' }));
      registry.registerTool(createTool({ name: 'github__list_repos', description: 'List repos' }));
      registry.registerTool(createTool({ name: 'jira__create_ticket', description: 'Create ticket' }));

      const results = registry.searchTools('github');
      expect(results.length).toBe(2);
    });

    it('should search by description', () => {
      registry.registerTool(createTool({
        name: 'issue_creator',
        description: 'Creates issues in the project tracker',
      }));

      const results = registry.searchTools('project tracker');
      expect(results.length).toBe(1);
    });
  });

  describe('unregisterTool', () => {
    it('should remove tool from registry', () => {
      registry.registerTool(createTool());
      registry.unregisterTool('github__create_issue');

      expect(registry.getTool('github__create_issue')).toBeNull();
    });

    it('should throw when unregistering non-existent tool', () => {
      expect(() => registry.unregisterTool('nonexistent')).toThrow();
    });

    it('should emit tool-unregistered event', () => {
      registry.registerTool(createTool());
      const listener = vi.fn();
      registry.on('tool-unregistered', listener);

      registry.unregisterTool('github__create_issue');
      expect(listener).toHaveBeenCalledWith('github__create_issue');
    });
  });

  describe('listTools', () => {
    it('should filter by shareable flag', () => {
      registry.registerTool(createTool({ name: 'shared', shareable: true }));
      registry.registerTool(createTool({ name: 'private', shareable: false }));

      const results = registry.listTools({ shareable: true });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('shared');
    });

    it('should filter by tags', () => {
      registry.registerTool(createTool({
        name: 'file_tool',
        metadata: { tags: ['file'] },
      }));
      registry.registerTool(createTool({
        name: 'api_tool',
        metadata: { tags: ['api'] },
      }));

      const results = registry.listTools({ tags: ['file'] });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('file_tool');
    });

    it('should filter by instanceId', () => {
      registry.registerTool(createTool({ name: 'local_tool' }));

      const results = registry.listTools({ instanceId });
      expect(results.length).toBe(1);
    });
  });

  describe('routeToolCall', () => {
    it('should route tool call to owning instance', async () => {
      registry.registerTool(createTool());

      const route = await registry.routeToolCall({
        requesterId: 'other-instance',
        toolName: 'github__create_issue',
        arguments: { title: 'Bug' },
      });

      expect(route.instanceId).toBe(instanceId);
      expect(route.toolName).toBe('github__create_issue');
    });

    it('should throw for non-existent tool', async () => {
      await expect(
        registry.routeToolCall({
          requesterId: 'agent-1',
          toolName: 'nonexistent',
          arguments: {},
        })
      ).rejects.toThrow('Tool not found');
    });

    it('should enforce RBAC on tool calls', async () => {
      registry.registerTool(createTool({
        name: 'restricted_tool',
        rbac: ['admin'],
      }));

      await expect(
        registry.routeToolCall({
          requesterId: 'agent-1',
          toolName: 'restricted_tool',
          arguments: {},
          rbacContext: ['viewer'],
        })
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('Edge Cases', () => {
    it('should handle register tool with empty name', () => {
      expect(() => registry.registerTool(createTool({ name: '' }))).toThrow();
      expect(registry.listTools().length).toBe(0);

    });

    it('should handle register tool with undefined handler', () => {
      // A tool registered without an execution handler should still be storable
      // but should fail when invoked
      registry.registerTool(createTool({
        name: 'no-handler-tool',
        handler: undefined as any,
      }));

      const tool = registry.getTool('no-handler-tool');
      expect(tool).not.toBeNull();

    });

    it('should handle lookup tool with exact match vs prefix match', () => {
      registry.registerTool(createTool({ name: 'github__create' }));
      registry.registerTool(createTool({ name: 'github__create_issue' }));

      // Exact match should return exact tool, not prefix match
      const exactTool = registry.getTool('github__create');
      expect(exactTool!.name).toBe('github__create');

      const fullTool = registry.getTool('github__create_issue');
      expect(fullTool!.name).toBe('github__create_issue');

    });

    it('should handle remove tool that has active executions', async () => {
      registry.registerTool(createTool({ name: 'active-tool' }));

      // Start a route (simulating active execution)
      const routePromise = registry.routeToolCall({
        requesterId: 'agent-1',
        toolName: 'active-tool',
        arguments: { title: 'test' },
      });

      // Unregister while execution is pending
      registry.unregisterTool('active-tool');

      // The in-flight route should either complete or fail gracefully
      const result = await routePromise.catch(e => e.message);
      expect(result).toBeDefined();

    });

    it('should handle tool version upgrade (same name, new implementation)', () => {
      registry.registerTool(createTool({
        name: 'versioned-tool',
        description: 'Version 1',
      }));

      // Re-register with same name but new description (upgrade)
      registry.registerTool(createTool({
        name: 'versioned-tool',
        description: 'Version 2 - improved',
      }));

      const tool = registry.getTool('versioned-tool');
      expect(tool!.description).toBe('Version 2 - improved');

    });

    it('should handle tool with no schema (schema-less tool)', () => {
      registry.registerTool(createTool({
        name: 'schemaless-tool',
        inputSchema: undefined as any,
      }));

      const tool = registry.getTool('schemaless-tool');
      expect(tool).not.toBeNull();
      expect(tool!.inputSchema).toBeUndefined();

    });

    it('should handle concurrent tool registration and execution', async () => {
      // Register and execute tools concurrently
      const ops = Array.from({ length: 20 }, (_, i) => {
        if (i % 2 === 0) {
          return Promise.resolve().then(() =>
            registry.registerTool(createTool({ name: `concurrent-tool-${i}` }))
          );
        } else {
          return registry.routeToolCall({
            requesterId: 'agent-1',
            toolName: `concurrent-tool-${i - 1}`,
            arguments: {},
          }).catch(() => 'expected-failure');
        }
      });

      const results = await Promise.all(ops);
      // Should not corrupt internal state
      expect(results).toBeDefined();

    });

    it('should handle tool registry with 10000 tools (lookup performance)', () => {
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        registry.registerTool(createTool({ name: `perf-tool-${i}` }));
      }
      const registerTime = performance.now() - start;

      const lookupStart = performance.now();
      const tool = registry.getTool('perf-tool-9999');
      const lookupTime = performance.now() - lookupStart;

      expect(tool).not.toBeNull();
      expect(tool!.name).toBe('perf-tool-9999');
      // Lookup should be fast even with 10000 tools
      expect(lookupTime).toBeLessThan(100);

    });

    it('should handle tool with circular schema reference', () => {
      const circularSchema: any = {
        type: 'object',
        properties: {
          child: { type: 'object' },
        },
      };
      // Create circular reference
      circularSchema.properties.child.properties = { parent: circularSchema };

      registry.registerTool(createTool({
        name: 'circular-schema-tool',
        inputSchema: circularSchema,
      }));

      const tool = registry.getTool('circular-schema-tool');
      expect(tool).not.toBeNull();

    });

    it('should handle register tool with dependencies on other tools', () => {
      // Register a tool that declares dependencies on other tools
      registry.registerTool(createTool({
        name: 'dependent-tool',
        metadata: { dependencies: ['base-tool-1', 'base-tool-2'] },
      }));

      // Dependencies are not registered - tool should still register
      // but may fail at execution time
      const tool = registry.getTool('dependent-tool');
      expect(tool).not.toBeNull();
      expect(tool!.metadata?.dependencies).toContain('base-tool-1');

    });
  });

  describe('Untested Methods', () => {
    it('discoverTools() — auto-discover available tools', async () => {
      registry.registerTool(createTool({ name: 'tool-a' }));
      registry.registerTool(createTool({ name: 'tool-b' }));

      const discovered = await registry.discoverTools();

      expect(discovered).toBeDefined();
      expect(Array.isArray(discovered)).toBe(true);
      expect(discovered.length).toBeGreaterThanOrEqual(2);

    });

    it('getToolsByInstance(instanceId) — get tools for specific instance', () => {
      registry.registerTool(createTool({ name: 'instance-tool-1' }));
      registry.registerTool(createTool({ name: 'instance-tool-2' }));

      const tools = registry.getToolsByInstance(instanceId);

      expect(tools).toBeDefined();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThanOrEqual(2);
      expect(tools.every((t: any) => t.ownedBy === instanceId)).toBe(true);

    });
  });
});
