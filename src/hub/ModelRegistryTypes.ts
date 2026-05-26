/**
 * Describes an LLM provider's capabilities, limits, and current usage.
 */
export interface ProviderInfo {
  /** Provider name (e.g., 'claude-sonnet-4', 'gpt-4', 'gemini-pro'). */
  name: string;

  /** Whether this provider is configured and ready for requests. */
  available: boolean;

  /** Whether other instances may use this provider. */
  shareable: boolean;

  /** RBAC roles required for access (empty means unrestricted). */
  rbac?: string[];

  /** Rate limits enforced by the hub. */
  limits?: {
    tpm?: number;
    rpm?: number;
    tpd?: number;
    rpd?: number;
    concurrent?: number;
  };

  /** Current usage tracked by the hub. */
  usage?: {
    tpm: number;
    rpm: number;
    tpd: number;
    rpd: number;
    concurrent: number;
  };

  /** Cost per million tokens (USD). */
  cost?: {
    inputTokens: number;
    outputTokens: number;
  };

  /** Model capabilities. */
  capabilities?: {
    contextWindow: number;
    vision: boolean;
    functionCalling: boolean;
    streaming?: boolean;
    systemMessages?: boolean;
  };
}

/**
 * A registered model linking to its owning instance and provider details.
 */
export interface ModelInfo {
  /** Model name. */
  name: string;

  /** Instance ID that owns this model. */
  ownedBy: string;

  /** Whether this model is shareable across instances. */
  shareable: boolean;

  /** RBAC roles required for access. */
  rbac: string[];

  /** RPC endpoint to reach this model. */
  endpoint: string;

  /** Full provider details. */
  provider: ProviderInfo;

  /** Last health check timestamp. */
  lastHealthCheck?: number;

  /** Whether the provider is currently responding. */
  healthy?: boolean;
}

/**
 * Routing information for directing a request to the correct instance.
 */
export interface RouteInfo {
  /** Target instance ID. */
  instanceId: string;

  /** Model name on the target instance. */
  modelName: string;

  /** RPC endpoint. */
  endpoint: string;

  /** Estimated latency in milliseconds. */
  latency?: number;

  /** Current pending request count. */
  queueDepth?: number;
}

/**
 * A model inference request with identity and routing metadata.
 */
export interface ModelRequest {
  /** Requesting instance ID. */
  requesterId: string;

  /** Model name being requested. */
  model: string;

  /** Request messages. */
  messages: any[];

  /** Inference options. */
  options?: {
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    [key: string]: any;
  };

  /** RBAC context (team IDs, roles, etc). */
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
 * Result of a rate limit check against a model's configured limits.
 */
export interface RateLimitResult {
  /** Whether the request is permitted. */
  allowed: boolean;

  /** Reason for rejection (present when allowed is false). */
  reason?: string;

  /** Current usage metrics. */
  usage: {
    tpm: number;
    rpm: number;
    tpd: number;
    rpd: number;
    concurrent: number;
  };

  /** Configured limits. */
  limits: {
    tpm?: number;
    rpm?: number;
    tpd?: number;
    rpd?: number;
    concurrent?: number;
  };

  /** When the exceeded limit will reset (timestamp). */
  resetAt?: number;

  /** Suggested fallback models if rejected. */
  fallback?: string[];
}
