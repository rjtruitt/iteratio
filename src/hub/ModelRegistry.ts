import { EventEmitter } from 'events';
import type {
  ProviderInfo,
  ModelInfo,
  RouteInfo,
  ModelRequest,
  RateLimitResult,
} from './ModelRegistryTypes.js';

export type { ProviderInfo, ModelInfo, RouteInfo, ModelRequest, RateLimitResult } from './ModelRegistryTypes.js';

/**
 * Distributed registry of LLM providers across Iteratio instances.
 *
 * Handles provider registration, RBAC permission checks, rate limit
 * enforcement, request routing, and health monitoring.
 *
 * Events emitted:
 * - `provider-registered` - (modelName: string, provider: ProviderInfo)
 * - `provider-unregistered` - (modelName: string)
 * - `provider-discovered` - (modelName: string, provider: ProviderInfo)
 * - `provider-unavailable` - (modelName: string, reason: string)
 * - `rate-limit-exceeded` - (modelName: string, usage: any)
 * - `route-updated` - (modelName: string, route: RouteInfo)
 */
export class ModelRegistry extends EventEmitter {
  private models: Map<string, ModelInfo> = new Map();
  private instanceProviders: Map<string, ProviderInfo[]> = new Map();
  private routes: Map<string, RouteInfo> = new Map();
  private instanceId: string;
  private isHub: boolean;

  constructor(instanceId: string, isHub: boolean = false) {
    super();
    this.instanceId = instanceId;
    this.isHub = isHub;
  }

  /**
   * Register a local LLM provider in the registry.
   *
   * Creates the model entry, route, and emits a registration event.
   * If this is the hub, the provider becomes discoverable by other instances.
   *
   * @param provider - Provider information to register
   * @throws Error if provider.name is empty
   */
  registerProvider(provider: ProviderInfo): void {
    console.log(`[ModelRegistry] Registering provider: ${provider.name}`);

    if (!provider.name) {
      throw new Error('Provider name is required');
    }

    const modelInfo: ModelInfo = {
      name: provider.name,
      ownedBy: this.instanceId,
      shareable: provider.shareable,
      rbac: provider.rbac ?? [],
      endpoint: this.getEndpoint(),
      provider: { ...provider },
      lastHealthCheck: Date.now(),
      healthy: true,
    };

    this.models.set(provider.name, modelInfo);

    const instanceProviders = this.instanceProviders.get(this.instanceId) ?? [];
    instanceProviders.push(provider);
    this.instanceProviders.set(this.instanceId, instanceProviders);

    this.routes.set(provider.name, {
      instanceId: this.instanceId,
      modelName: provider.name,
      endpoint: this.getEndpoint(),
    });

    this.emit('provider-registered', provider.name, provider);
  }

  /**
   * Unregister a local provider from the registry.
   *
   * @param modelName - Model name to unregister
   * @throws Error if model not found or not owned by this instance
   */
  unregisterProvider(modelName: string): void {
    console.log(`[ModelRegistry] Unregistering provider: ${modelName}`);

    const modelInfo = this.models.get(modelName);
    if (!modelInfo || modelInfo.ownedBy !== this.instanceId) {
      throw new Error(`Cannot unregister provider ${modelName} - not owned by this instance`);
    }

    this.models.delete(modelName);
    this.routes.delete(modelName);

    const instanceProviders = this.instanceProviders.get(this.instanceId) ?? [];
    const filtered = instanceProviders.filter(p => p.name !== modelName);
    this.instanceProviders.set(this.instanceId, filtered);

    this.emit('provider-unregistered', modelName);
  }

  /**
   * Discover providers available across all connected instances.
   *
   * @returns Array of discovered ProviderInfo
   */
  async discoverProviders(): Promise<ProviderInfo[]> {
    console.log('[ModelRegistry] Discovering providers from other instances...');

    const discovered: ProviderInfo[] = [];
    for (const modelInfo of this.models.values()) {
      discovered.push(modelInfo.provider);
    }

    return discovered;
  }

  /**
   * Look up a specific provider by model name.
   *
   * @param modelName - Model name to look up
   * @returns ModelInfo or null if not found
   */
  getProvider(modelName: string): ModelInfo | null {
    return this.models.get(modelName) ?? null;
  }

  /**
   * List all registered providers, optionally filtered.
   *
   * @param filter - Optional filter by shareability or RBAC context
   * @returns Array of matching ModelInfo
   */
  listProviders(filter?: {
    shareable?: boolean;
    rbac?: string[];
    capabilities?: string[];
  }): ModelInfo[] {
    const providers = Array.from(this.models.values());

    if (!filter) {
      return providers;
    }

    return providers.filter(model => {
      if (filter.shareable !== undefined && model.shareable !== filter.shareable) {
        return false;
      }

      if (filter.rbac && filter.rbac.length > 0) {
        const hasAccess = filter.rbac.some(ctx => model.rbac.includes(ctx));
        if (!hasAccess && model.rbac.length > 0) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Check whether a requester has RBAC permission to use a model.
   *
   * @param modelName - Model being requested
   * @param rbacContext - Requester's RBAC roles/contexts
   * @returns true if access is permitted
   */
  checkPermission(modelName: string, rbacContext: string[] = []): boolean {
    const modelInfo = this.models.get(modelName);

    if (!modelInfo) {
      return false;
    }

    if (!modelInfo.shareable && modelInfo.ownedBy !== this.instanceId) {
      return false;
    }

    if (modelInfo.rbac.length === 0) {
      return true;
    }

    return rbacContext.some(ctx => modelInfo.rbac.includes(ctx));
  }

  /**
   * Route a model request to the appropriate instance.
   *
   * Validates permissions and rate limits before returning routing info.
   *
   * @param request - Model request with identity and arguments
   * @returns RouteInfo for the target instance
   * @throws Error if model not found, permission denied, unhealthy, or rate limited
   */
  async routeRequest(request: ModelRequest): Promise<RouteInfo> {
    const { model, rbacContext = [] } = request;

    console.log(`[ModelRegistry] Routing request for model: ${model}`);

    const modelInfo = this.models.get(model);
    if (!modelInfo) {
      throw new Error(`Model not found: ${model}`);
    }

    if (!this.checkPermission(model, rbacContext)) {
      throw new Error(`Permission denied for model: ${model}`);
    }

    if (modelInfo.healthy === false) {
      const fallback = this.findFallbackModel(model, rbacContext);
      if (fallback) {
        return fallback;
      }
      throw new Error(`Model unhealthy and no fallback available: ${model}`);
    }

    if (modelInfo.provider.limits && modelInfo.provider.usage) {
      const limits = modelInfo.provider.limits;
      const usage = modelInfo.provider.usage;
      if (limits.tpm !== undefined && usage.tpm >= limits.tpm) {
        throw new Error(`Rate limit exceeded for model: ${model}`);
      }
      if (limits.rpm !== undefined && usage.rpm >= limits.rpm) {
        throw new Error(`Rate limit exceeded for model: ${model}`);
      }
    }

    const route = this.routes.get(model);
    if (!route) {
      throw new Error(`No route found for model: ${model}`);
    }

    return route;
  }

  /**
   * Record usage metrics for a completed model request.
   *
   * @param modelName - Model that was used
   * @param usage - Token and request counts
   */
  trackUsage(
    modelName: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      requestCount: number;
      duration: number;
    }
  ): void {
    const modelInfo = this.models.get(modelName);
    if (!modelInfo) {
      return;
    }

    if (!modelInfo.provider.usage) {
      modelInfo.provider.usage = {
        tpm: 0,
        rpm: 0,
        tpd: 0,
        rpd: 0,
        concurrent: 0,
      };
    }

    console.log(`[ModelRegistry] Tracked usage for ${modelName}: ${usage.inputTokens + usage.outputTokens} tokens`);
  }

  /**
   * Get current usage metrics for a model.
   *
   * @param modelName - Model to query
   * @returns Usage metrics or null if model not found
   */
  getUsage(modelName: string): any {
    const modelInfo = this.models.get(modelName);
    return modelInfo?.provider.usage ?? null;
  }

  /**
   * Find an alternate healthy, shareable model with matching RBAC as a fallback.
   *
   * @param modelName - The original model name to find a fallback for
   * @param rbacContext - Requester's RBAC roles/contexts
   * @returns RouteInfo for the fallback model, or null if none available
   */
  private findFallbackModel(modelName: string, rbacContext: string[]): RouteInfo | null {
    for (const [name, info] of this.models.entries()) {
      if (name === modelName) continue;
      if (info.healthy === false) continue;
      if (!info.shareable) continue;

      if (info.rbac.length > 0) {
        const hasAccess = rbacContext.some(ctx => info.rbac.includes(ctx));
        if (!hasAccess) continue;
      }

      const route = this.routes.get(name);
      if (route) return route;
    }
    return null;
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
