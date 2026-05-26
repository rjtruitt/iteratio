import { EventEmitter } from 'events';
import type {
  JSONSchema,
  MCPToolInfo,
  ToolInfo,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolRoute,
} from './ToolRegistryTypes.js';

export type { JSONSchema, MCPToolInfo, ToolInfo, ToolExecutionRequest, ToolExecutionResult, ToolRoute } from './ToolRegistryTypes.js';

/**
 * Distributed registry of MCP tools across Iteratio instances.
 *
 * Applies namespacing for context-dependent tools (tool@hostname),
 * enforces RBAC permissions, and routes tool calls to the owning instance.
 *
 * Events emitted:
 * - `tool-registered` - (toolName: string, tool: ToolInfo)
 * - `tool-unregistered` - (toolName: string)
 * - `tool-discovered` - (toolName: string, tool: ToolInfo)
 * - `tool-unavailable` - (toolName: string, reason: string)
 * - `tool-conflict` - (toolName: string, instances: string[])
 * - `route-updated` - (toolName: string, route: ToolRoute)
 */
export class ToolRegistry extends EventEmitter {
  private tools: Map<string, ToolInfo> = new Map();
  private instanceTools: Map<string, ToolInfo[]> = new Map();
  private routes: Map<string, ToolRoute> = new Map();
  private instanceId: string;
  private hostname: string;
  private isHub: boolean;

  constructor(instanceId: string, hostname: string, isHub: boolean = false) {
    super();
    this.instanceId = instanceId;
    this.hostname = hostname;
    this.isHub = isHub;
  }

  /**
   * Register a local MCP tool.
   *
   * Context-dependent tools are namespaced as `toolName@hostname` to avoid
   * conflicts across instances with different filesystem contexts.
   *
   * @param tool - MCP tool information to register
   * @throws Error if tool.name is empty
   */
  registerTool(tool: MCPToolInfo): void {
    console.log(`[ToolRegistry] Registering tool: ${tool.name}`);

    if (!tool.name) {
      throw new Error('Tool name is required');
    }

    const namespacedName = tool.contextDependent
      ? `${tool.name}@${this.hostname}`
      : tool.name;

    const toolInfo: ToolInfo = {
      name: namespacedName,
      ownedBy: this.instanceId,
      description: tool.description,
      shareable: tool.shareable,
      contextDependent: tool.contextDependent,
      requiresArtifacts: tool.requiresArtifacts,
      rbac: tool.rbac ?? [],
      metadata: tool.metadata,
      inputSchema: tool.inputSchema,
      endpoint: this.getEndpoint(),
      lastHealthCheck: Date.now(),
      healthy: true,
    };

    this.tools.set(namespacedName, toolInfo);

    const instanceTools = this.instanceTools.get(this.instanceId) ?? [];
    instanceTools.push(toolInfo);
    this.instanceTools.set(this.instanceId, instanceTools);

    this.routes.set(namespacedName, {
      instanceId: this.instanceId,
      toolName: tool.name,
      endpoint: this.getEndpoint(),
    });

    this.emit('tool-registered', namespacedName, toolInfo);
  }

  /**
   * Unregister a local tool by its (possibly namespaced) name.
   *
   * @param toolName - Tool name to unregister
   * @throws Error if tool not found or not owned by this instance
   */
  unregisterTool(toolName: string): void {
    console.log(`[ToolRegistry] Unregistering tool: ${toolName}`);

    const toolInfo = this.tools.get(toolName);
    if (!toolInfo || toolInfo.ownedBy !== this.instanceId) {
      throw new Error(`Cannot unregister tool ${toolName} - not owned by this instance`);
    }

    this.tools.delete(toolName);
    this.routes.delete(toolName);

    const instanceTools = this.instanceTools.get(this.instanceId) ?? [];
    const filtered = instanceTools.filter(t => t.name !== toolName);
    this.instanceTools.set(this.instanceId, filtered);

    this.emit('tool-unregistered', toolName);
  }

  /**
   * Discover tools available across all connected instances.
   *
   * @returns Array of discovered ToolInfo
   */
  async discoverTools(): Promise<ToolInfo[]> {
    console.log('[ToolRegistry] Discovering tools from other instances...');
    return Array.from(this.tools.values());
  }

  /**
   * Look up a tool by name, supporting both namespaced and base-name lookups.
   *
   * @param toolName - Tool name (possibly namespaced with @hostname)
   * @returns ToolInfo or null if not found
   */
  getTool(toolName: string): ToolInfo | null {
    const tool = this.tools.get(toolName);
    if (tool) {
      return tool;
    }

    if (toolName.includes('@')) {
      const baseName = toolName.split('@')[0];
      for (const [name, info] of this.tools.entries()) {
        if (name.startsWith(baseName)) {
          return info;
        }
      }
    }

    return null;
  }

  /**
   * List all registered tools, optionally filtered by criteria.
   *
   * @param filter - Optional filter by shareability, context-dependence, RBAC, tags, or instance
   * @returns Array of matching ToolInfo
   */
  listTools(filter?: {
    shareable?: boolean;
    contextDependent?: boolean;
    requiresArtifacts?: boolean;
    rbac?: string[];
    tags?: string[];
    instanceId?: string;
  }): ToolInfo[] {
    const tools = Array.from(this.tools.values());

    if (!filter) {
      return tools;
    }

    return tools.filter(tool => {
      if (filter.shareable !== undefined && tool.shareable !== filter.shareable) {
        return false;
      }

      if (filter.contextDependent !== undefined && tool.contextDependent !== filter.contextDependent) {
        return false;
      }

      if (filter.requiresArtifacts !== undefined && tool.requiresArtifacts !== filter.requiresArtifacts) {
        return false;
      }

      if (filter.rbac && filter.rbac.length > 0) {
        const hasAccess = filter.rbac.some(ctx => tool.rbac.includes(ctx));
        if (!hasAccess && tool.rbac.length > 0) {
          return false;
        }
      }

      if (filter.tags && filter.tags.length > 0) {
        const toolTags = tool.metadata?.tags ?? [];
        const hasTag = filter.tags.some(tag => toolTags.includes(tag));
        if (!hasTag) {
          return false;
        }
      }

      if (filter.instanceId && tool.ownedBy !== filter.instanceId) {
        return false;
      }

      return true;
    });
  }

  /**
   * Check whether a requester has RBAC permission to invoke a tool.
   *
   * @param toolName - Tool being requested
   * @param rbacContext - Requester's RBAC roles/contexts
   * @returns true if access is permitted
   */
  checkPermission(toolName: string, rbacContext: string[] = []): boolean {
    const toolInfo = this.tools.get(toolName);

    if (!toolInfo) {
      return false;
    }

    if (!toolInfo.shareable && toolInfo.ownedBy !== this.instanceId) {
      return false;
    }

    if (toolInfo.rbac.length === 0) {
      return true;
    }

    return rbacContext.some(ctx => toolInfo.rbac.includes(ctx));
  }

  /**
   * Route a tool call to the owning instance after permission checks.
   *
   * @param request - Tool execution request
   * @returns ToolRoute for the target instance
   * @throws Error if tool not found, permission denied, or no route available
   */
  async routeToolCall(request: ToolExecutionRequest): Promise<ToolRoute> {
    const { toolName, rbacContext = [] } = request;

    console.log(`[ToolRegistry] Routing tool call: ${toolName}`);

    const toolInfo = this.tools.get(toolName);
    if (!toolInfo) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    if (!this.checkPermission(toolName, rbacContext)) {
      throw new Error(`Permission denied for tool: ${toolName}`);
    }

    const route = this.routes.get(toolName);
    if (!route) {
      throw new Error(`No route found for tool: ${toolName}`);
    }

    return route;
  }

  /**
   * Search tools by keyword across names, descriptions, and tags.
   *
   * @param query - Search query string
   * @param filter - Optional additional filter criteria
   * @returns Array of matching ToolInfo
   */
  searchTools(query: string, filter?: any): ToolInfo[] {
    const lowerQuery = query.toLowerCase();

    return this.listTools(filter).filter(tool => {
      if (tool.name.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      if (tool.description.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      const tags = tool.metadata?.tags ?? [];
      if (tags.some(tag => tag.toLowerCase().includes(lowerQuery))) {
        return true;
      }

      return false;
    });
  }

  /**
   * Get all tools owned by a specific instance.
   *
   * @param instanceId - Instance ID to query
   * @returns Array of ToolInfo
   */
  getToolsByInstance(instanceId: string): ToolInfo[] {
    return this.instanceTools.get(instanceId) ?? [];
  }


  /**
   * Get the RPC endpoint URL for this instance.
   *
   * @returns The endpoint URL string
   */
  private getEndpoint(): string {
    return `nats://localhost:4222/instances/${this.instanceId}`;
  }
}
