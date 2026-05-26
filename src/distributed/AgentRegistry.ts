import { EventEmitter } from 'events';


/** Role an agent can fulfil in the distributed system. */
export type AgentRole = 'overseer' | 'orchestrator' | 'worker' | 'task';
/** Current operational status of an agent. */
export type AgentStatus = 'starting' | 'idle' | 'running' | 'paused' | 'stopped' | 'crashed';
/** Supported LLM provider identifiers. */
export type LLMProvider = 'anthropic' | 'openai' | 'bedrock' | 'local' | 'ollama' | 'azure';
/** Supported backends for the registry storage. */
export type RegistryBackend = 'etcd' | 'redis' | 'consul';

/** Complete identity record for a registered agent. */
export interface AgentIdentity {
  id: string;
  role: AgentRole;
  parentId?: string;
  children: string[];
  machineId: string;
  hostname: string;
  pid: number;
  llmProvider: LLMProvider;
  llmModel: string;
  capabilities: string[];
  status: AgentStatus;
  lastHeartbeat: number;
  createdAt: number;
  endpoints: {
    rpc?: string;
    ws?: string;
    http?: string;
  };
  metadata?: Record<string, any>;
}

/** Query filters for discovering agents by attributes. */
export interface DiscoveryQuery {
  role?: AgentRole | string;
  parentId?: string;
  capability?: string;
  llmProvider?: LLMProvider;
  machineId?: string;
  status?: AgentStatus;
}

/** Configuration for the agent registry backend. */
export interface RegistryConfig {
  backend: RegistryBackend;
  backendUrl: string;
  ttl?: number;
  heartbeatInterval?: number;
  healthCheckInterval?: number;
}

/** Pluggable backend abstraction for registry key-value storage. */
export interface IRegistryBackend {
  /** Sets a key to the given value with an optional TTL. */
  set(key: string, value: string, options?: { ttl?: number }): Promise<void>;
  /** Sets a key only if it does not already exist (atomic create). */
  setNX(key: string, value: string, options?: { ttl?: number }): Promise<boolean>;
  /** Gets the value for a key, or null if missing/expired. */
  get(key: string): Promise<string | null>;
  /** Deletes a key. */
  delete(key: string): Promise<void>;
  /** Scans for keys matching the given glob pattern. */
  scan(pattern: string): Promise<string[]>;
  /** Closes the backend and releases resources. */
  close(): Promise<void>;
}


/** In-memory implementation of IRegistryBackend with optional TTL support. */
class InMemoryRegistryBackend implements IRegistryBackend {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async set(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    const entry: { value: string; expiresAt?: number } = { value };
    if (options?.ttl) {
      entry.expiresAt = Date.now() + options.ttl;
    }
    this.store.set(key, entry);
  }

  async setNX(key: string, value: string, options?: { ttl?: number }): Promise<boolean> {
    const existing = this.store.get(key);
    if (existing) {
      if (existing.expiresAt && Date.now() > existing.expiresAt) {
        this.store.delete(key);
      } else {
        return false;
      }
    }
    const entry: { value: string; expiresAt?: number } = { value };
    if (options?.ttl) {
      entry.expiresAt = Date.now() + options.ttl;
    }
    this.store.set(key, entry);
    return true;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async scan(pattern: string): Promise<string[]> {
    const prefix = pattern.replace('*', '');
    const keys: string[] = [];
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
          this.store.delete(key);
          continue;
        }
        keys.push(key);
      }
    }
    return keys;
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

const globalBackendRegistry = new Map<string, InMemoryRegistryBackend>();

function getOrCreateSharedBackend(backendUrl: string): InMemoryRegistryBackend {
  if (!globalBackendRegistry.has(backendUrl)) {
    globalBackendRegistry.set(backendUrl, new InMemoryRegistryBackend());
  }
  return globalBackendRegistry.get(backendUrl)!;
}

/** Resets all shared in-memory backends (for test isolation). */
export function resetSharedBackends(): void {
  globalBackendRegistry.clear();
}


/**
 * Central registry for agent identity, discovery, health tracking, and lifecycle events.
 * Supports pluggable backends (in-memory, Redis, etc.) with TTL-based heartbeats.
 */
export class AgentRegistry extends EventEmitter {
  private backend: IRegistryBackend;
  private config: Required<RegistryConfig>;
  private heartbeatCancellers: Map<string, { cancelled: boolean }> = new Map();
  private healthWatchControl: { cancelled: boolean } | null = null;
  private healthCallback: ((agent: AgentIdentity) => void) | null = null;
  private messageBus?: any;
  private isShutdown = false;

  constructor(config: RegistryConfig) {
    super();

    this.config = {
      ...config,
      ttl: config.ttl || 30000,
      heartbeatInterval: config.heartbeatInterval || (config.ttl || 30000) / 2,
      healthCheckInterval: config.healthCheckInterval || (config.ttl || 30000),
    };

    this.backend = getOrCreateSharedBackend(config.backendUrl);
  }

  /**
   * Registers a new agent in the registry.
   * Throws if the agent ID is already registered.
   */
  async register(identity: AgentIdentity): Promise<void> {
    if (this.isShutdown) {
      throw new Error('Registry is shut down');
    }

    if (!identity.id) {
      throw new Error('Agent ID is required');
    }

    const acquired = await this.backend.setNX(
      `agents/${identity.id}`,
      JSON.stringify(identity),
      { ttl: this.config.ttl }
    );

    if (!acquired) {
      throw new Error(`Agent ${identity.id} already registered`);
    }

    this.startHeartbeat(identity.id);

    if (this.messageBus) {
      await this.messageBus.publish('agent.joined', identity);
    }

    this.emit('agent:registered', identity);
  }

  /** Unregisters an agent and stops its heartbeat. */
  async unregister(agentId: string): Promise<void> {
    this.stopHeartbeat(agentId);

    await this.backend.delete(`agents/${agentId}`);

    if (this.messageBus) {
      await this.messageBus.publish('agent.left', { agentId });
    }

    this.emit('agent:unregistered', agentId);
  }

  /**
   * Discovers agents matching the given query filters.
   * Returns all agents if no filters are provided.
   */
  async discover(query: DiscoveryQuery = {}): Promise<AgentIdentity[]> {
    const keys = await this.backend.scan('agents/*');

    const agents: AgentIdentity[] = [];
    for (const key of keys) {
      const data = await this.backend.get(key);
      if (data) {
        agents.push(JSON.parse(data));
      }
    }

    return agents.filter(agent => {
      if (query.role && agent.role !== query.role) return false;
      if (query.parentId && agent.parentId !== query.parentId) return false;
      if (query.capability && (!agent.capabilities || !agent.capabilities.includes(query.capability))) return false;
      if (query.llmProvider && agent.llmProvider !== query.llmProvider) return false;
      if (query.machineId && agent.machineId !== query.machineId) return false;
      if (query.status && agent.status !== query.status) return false;
      return true;
    });
  }

  /** Gets the full identity record for a single agent, or null if not found. */
  async get(agentId: string): Promise<AgentIdentity | null> {
    const data = await this.backend.get(`agents/${agentId}`);
    if (!data) return null;
    return JSON.parse(data) as AgentIdentity;
  }

  /** Checks whether an agent ID exists in the registry. */
  async exists(agentId: string): Promise<boolean> {
    const data = await this.backend.get(`agents/${agentId}`);
    return data !== null;
  }

  /** Updates the status of a registered agent and refreshes its heartbeat timestamp. */
  async updateStatus(agentId: string, status: AgentStatus): Promise<void> {
    const agent = await this.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    agent.status = status;
    agent.lastHeartbeat = Date.now();

    await this.backend.set(
      `agents/${agentId}`,
      JSON.stringify(agent),
      { ttl: this.config.ttl }
    );

    this.emit('agent:status_changed', { agentId, status });
  }

  /** Merges metadata into an existing agent's record. */
  async updateMetadata(agentId: string, metadata: Record<string, any>): Promise<void> {
    const agent = await this.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    agent.metadata = { ...agent.metadata, ...metadata };
    agent.lastHeartbeat = Date.now();

    await this.backend.set(
      `agents/${agentId}`,
      JSON.stringify(agent),
      { ttl: this.config.ttl }
    );
  }

  private startHeartbeat(agentId: string): void {
    this.stopHeartbeat(agentId);

    const control = { cancelled: false };
    this.heartbeatCancellers.set(agentId, control);

    const scheduleHeartbeat = () => {
      setTimeout(async () => {
        if (control.cancelled) return;

        try {
          const agent = await this.get(agentId);
          if (agent && !control.cancelled) {
            agent.lastHeartbeat = Date.now();
            await this.backend.set(
              `agents/${agentId}`,
              JSON.stringify(agent),
              { ttl: this.config.ttl }
            );
            if (!control.cancelled) {
              scheduleHeartbeat();
            }
          }
        } catch (error) {
        }
      }, this.config.heartbeatInterval);
    };

    scheduleHeartbeat();
  }

  private stopHeartbeat(agentId: string): void {
    const control = this.heartbeatCancellers.get(agentId);
    if (control) {
      control.cancelled = true;
      this.heartbeatCancellers.delete(agentId);
    }
  }

  /**
   * Watches for dead agents by polling all heartbeats.
   * Calls the callback with any agent whose heartbeat has expired beyond 2× TTL.
   */
  async watchHealth(callback: (deadAgent: AgentIdentity) => void): Promise<void> {
    this.stopHealthWatch();

    this.healthCallback = callback;
    const control = { cancelled: false };
    this.healthWatchControl = control;

    const scheduleCheck = () => {
      setTimeout(async () => {
        if (control.cancelled) return;

        try {
          const allAgents = await this.discover();
          const now = Date.now();

          for (const agent of allAgents) {
            if (now - agent.lastHeartbeat > this.config.ttl * 2) {
              callback(agent);
              await this.unregister(agent.id);
            }
          }

          if (!control.cancelled) {
            scheduleCheck();
          }
        } catch (error) {
        }
      }, this.config.healthCheckInterval);
    };

    scheduleCheck();
  }

  /** Stops the health watch polling loop. */
  stopHealthWatch(): void {
    if (this.healthWatchControl) {
      this.healthWatchControl.cancelled = true;
      this.healthWatchControl = null;
    }
    this.healthCallback = null;
  }

  /** Returns aggregate statistics about registered agents grouped by role, status, provider, and machine. */
  async getStats(): Promise<{
    totalAgents: number;
    byRole: Record<string, number>;
    byStatus: Record<string, number>;
    byProvider: Record<string, number>;
    byMachine: Record<string, number>;
  }> {
    const agents = await this.discover();

    const stats = {
      totalAgents: agents.length,
      byRole: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
      byProvider: {} as Record<string, number>,
      byMachine: {} as Record<string, number>,
    };

    for (const agent of agents) {
      stats.byRole[agent.role] = (stats.byRole[agent.role] || 0) + 1;
      stats.byStatus[agent.status] = (stats.byStatus[agent.status] || 0) + 1;
      stats.byProvider[agent.llmProvider] = (stats.byProvider[agent.llmProvider] || 0) + 1;
      stats.byMachine[agent.machineId] = (stats.byMachine[agent.machineId] || 0) + 1;
    }

    return stats;
  }

  /** Initializes the registry to an active state. */
  async initialize(): Promise<void> {
    this.isShutdown = false;
  }

  /** Shuts down the registry, stopping all heartbeats and health watches. */
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    for (const agentId of this.heartbeatCancellers.keys()) {
      this.stopHeartbeat(agentId);
    }

    this.stopHealthWatch();

    this.emit('shutdown');
  }

  /** Attaches a message bus for broadcasting agent lifecycle events. */
  setMessageBus(messageBus: any): void {
    this.messageBus = messageBus;
  }
}
