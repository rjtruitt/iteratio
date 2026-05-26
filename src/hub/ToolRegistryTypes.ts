/**
 * Loose JSON Schema type for tool input schemas.
 */
export type JSONSchema = {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  [key: string]: any;
};

/**
 * Describes an MCP tool's signature, shareability, and context metadata.
 */
export interface MCPToolInfo {
  /** Tool name (e.g., 'github__create_issue', 'filesystem__read_file'). */
  name: string;

  /** Human-readable description. */
  description: string;

  /** JSON Schema for input parameters. */
  inputSchema: JSONSchema;

  /** Whether other instances may invoke this tool. */
  shareable: boolean;

  /** Whether this tool depends on local context (filesystem, env). */
  contextDependent: boolean;

  /** Whether this tool produces file artifacts. */
  requiresArtifacts: boolean;

  /** RBAC roles required for access. */
  rbac?: string[];

  /** Context metadata for remote instances to understand environment. */
  metadata?: {
    filesystem?: {
      rootPath: string;
      hostname: string;
      platform: string;
      availablePaths?: string[];
    };
    network?: {
      baseUrl?: string;
      region?: string;
    };
    tags?: string[];
  };
}

/**
 * A registered tool linked to its owning instance with routing info.
 */
export interface ToolInfo {
  /** Tool name (may be namespaced: tool@hostname). */
  name: string;

  /** Instance ID that owns this tool. */
  ownedBy: string;

  /** Tool description. */
  description: string;

  /** Whether this tool is shareable. */
  shareable: boolean;

  /** Whether this tool is context-dependent. */
  contextDependent: boolean;

  /** Whether this tool produces artifacts. */
  requiresArtifacts: boolean;

  /** RBAC roles required for access. */
  rbac: string[];

  /** Context metadata. */
  metadata?: MCPToolInfo['metadata'];

  /** Input schema. */
  inputSchema: JSONSchema;

  /** RPC endpoint. */
  endpoint: string;

  /** Last health check timestamp. */
  lastHealthCheck?: number;

  /** Whether the tool is currently responding. */
  healthy?: boolean;
}

/**
 * Request to execute a remote tool.
 */
export interface ToolExecutionRequest {
  /** Requesting instance ID. */
  requesterId: string;

  /** Tool name (possibly namespaced). */
  toolName: string;

  /** Tool arguments. */
  arguments: Record<string, any>;

  /** RBAC context of the requester. */
  rbacContext?: string[];

  /** Request metadata for tracing. */
  metadata?: {
    traceId?: string;
    userId?: string;
    appId?: string;
    [key: string]: any;
  };
}

/**
 * Result of a remote tool execution.
 */
export interface ToolExecutionResult {
  /** Whether execution completed successfully. */
  success: boolean;

  /** Result data. */
  data?: any;

  /** Error message (present on failure). */
  error?: string;

  /** Artifacts produced by the tool. */
  artifacts?: Array<{
    id: string;
    name: string;
    type: string;
    path?: string;
    url?: string;
  }>;

  /** Execution metadata. */
  metadata?: {
    duration: number;
    instanceId: string;
    [key: string]: any;
  };
}

/**
 * Routing information for directing a tool call to the correct instance.
 */
export interface ToolRoute {
  /** Target instance ID. */
  instanceId: string;

  /** Tool name on the target instance (original, not namespaced). */
  toolName: string;

  /** RPC endpoint. */
  endpoint: string;

  /** Estimated latency in milliseconds. */
  latency?: number;
}
