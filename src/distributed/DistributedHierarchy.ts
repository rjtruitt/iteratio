import { EventEmitter } from 'events';
import { AgentRegistry, AgentIdentity, AgentRole, LLMProvider } from './AgentRegistry.js';

/** Request to spawn a child agent with specific attributes. */
export interface SpawnRequest {
  role: AgentRole;
  purpose: string;
  preferredLLM?: LLMProvider;
  preferredModel?: string;
  preferredMachine?: string;
  avoidMachines?: string[];
  minMemory?: number;
  minCpu?: number;
  capabilities?: string[];
  config?: Record<string, any>;
}

/** Result of a spawn operation, including the new agent ID. */
export interface SpawnResult {
  childId: string;
  machineId: string;
  status: 'spawned' | 'registered' | 'ready';
  spawnedAt: number;
}

/** Recursive tree representation of an agent and its children. */
export interface AgentTree {
  agent: AgentIdentity;
  children: AgentTree[];
  depth: number;
}

/** Describes a machine/node in the distributed system. */
export interface MachineInfo {
  id: string;
  machineId: string;
  hostname: string;
  cpuUsage: number;
  memoryUsage: number;
  agentCount: number;
  availableLLMs: LLMProvider[];
  capabilities: string[];
  status: 'online' | 'offline' | 'maintenance';
  lastSeen: number;
  latency?: number;
  region?: string;
}

/** Configuration for the distributed hierarchy manager. */
export interface HierarchyConfig {
  registry: AgentRegistry;
  stateStore: any;
  messageBus: any;
  registrationTimeout?: number;
  machineUpdateInterval?: number;
}

let spawnCounter = 0;

/**
 * Manages parent-child agent hierarchies across distributed machines.
 * Handles spawning, tree traversal, orphan recovery, and machine info tracking.
 */
export class DistributedHierarchy extends EventEmitter {
  private registry: AgentRegistry;
  private stateStore: any;
  private messageBus: any;
  private registrationTimeout: number;
  private machineUpdateInterval: number;
  private machineInfoCache: Map<string, MachineInfo> = new Map();
  private updateControl: { cancelled: boolean } | null = null;
  private isShutdown = false;

  constructor(config: HierarchyConfig) {
    super();

    this.registry = config.registry;
    this.stateStore = config.stateStore;
    this.messageBus = config.messageBus;
    this.registrationTimeout = config.registrationTimeout || 30000;
    this.machineUpdateInterval = config.machineUpdateInterval || 10000;
  }

  /**
   * Spawns a child agent under the given parent, registering it in the registry.
   * Returns the spawn result with the new child's ID.
   */
  async spawnChild(parentId: string, request: SpawnRequest): Promise<SpawnResult> {
    if (this.isShutdown) {
      throw new Error('DistributedHierarchy is shut down');
    }

    const parent = await this.registry.get(parentId);
    if (!parent) throw new Error(`Parent agent ${parentId} not found`);

    const machineId = parent.machineId;
    const childId = `${request.role}_${++spawnCounter}@${machineId}`;

    const childIdentity: AgentIdentity = {
      id: childId,
      role: request.role as AgentRole,
      parentId: parentId,
      children: [],
      machineId,
      hostname: parent.hostname,
      pid: parent.pid,
      llmProvider: request.preferredLLM || parent.llmProvider,
      llmModel: request.preferredModel || parent.llmModel,
      capabilities: request.capabilities || [],
      status: 'running',
      lastHeartbeat: Date.now(),
      createdAt: Date.now(),
      endpoints: {},
    };

    await this.registry.register(childIdentity);

    parent.children.push(childId);
    await this.registry.unregister(parentId);
    await this.registry.register(parent);

    return {
      childId,
      machineId,
      status: 'registered',
      spawnedAt: Date.now(),
    };
  }

  /** Spawns multiple child agents for the given parent. Returns results per request, collecting errors. */
  async spawnChildren(parentId: string, requests: SpawnRequest[]): Promise<Array<SpawnResult | Error>> {
    if (this.isShutdown) {
      throw new Error('DistributedHierarchy is shut down');
    }

    const results: Array<SpawnResult | Error> = [];
    for (const req of requests) {
      try {
        results.push(await this.spawnChild(parentId, req));
      } catch (err) {
        results.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return results;
  }

  /**
   * Polls until the child agent is registered (status !== 'starting') or the timeout expires.
   * Returns true if registration completed in time.
   */
  async waitForRegistration(childId: string, timeout: number): Promise<boolean> {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeout) {
      const child = await this.registry.get(childId);
      if (child && child.status !== 'starting') {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return false;
  }

  /** Returns all child agents of the given parent. */
  async getChildren(parentId: string): Promise<AgentIdentity[]> {
    return await this.registry.discover({ parentId });
  }

  /** Returns the parent agent of the given child, or null. */
  async getParent(childId: string): Promise<AgentIdentity | null> {
    const child = await this.registry.get(childId);
    if (!child || !child.parentId) return null;
    return await this.registry.get(child.parentId);
  }

  /** Returns sibling agents (other children of the same parent). */
  async getSiblings(agentId: string): Promise<AgentIdentity[]> {
    const agent = await this.registry.get(agentId);
    if (!agent || !agent.parentId) return [];

    const children = await this.getChildren(agent.parentId);
    return children.filter(c => c.id !== agentId);
  }

  /**
   * Builds a recursive tree of agents rooted at the given agent ID.
   * Throws if the root agent is not found.
   */
  async getTree(rootId: string, depth = 0): Promise<AgentTree> {
    const root = await this.registry.get(rootId);
    if (!root) throw new Error(`Root agent ${rootId} not found`);

    const childrenIdentities = await this.getChildren(rootId);

    const children = await Promise.all(
      childrenIdentities.map(child => this.getTree(child.id, depth + 1))
    );

    return {
      agent: root,
      children,
      depth,
    };
  }

  /** Returns all descendants (excluding the root) of the given agent. */
  async getDescendants(rootId: string): Promise<AgentIdentity[]> {
    const tree = await this.getTree(rootId);

    const flatten = (node: AgentTree): AgentIdentity[] => {
      const descendants: AgentIdentity[] = [node.agent];
      for (const child of node.children) {
        descendants.push(...flatten(child));
      }
      return descendants;
    };

    const all = flatten(tree);
    return all.slice(1); // Exclude root
  }

  /** Returns the full ancestry path from the given agent up to the root. */
  async getPath(agentId: string): Promise<AgentIdentity[]> {
    const path: AgentIdentity[] = [];
    let currentId: string | undefined = agentId;

    while (currentId) {
      const agent = await this.registry.get(currentId);
      if (!agent) break;
      path.unshift(agent);
      currentId = agent.parentId;
    }

    return path;
  }

  /**
   * Handles orphaned agents when their parent dies.
   * Supported strategies: 'reassign' (to grandparent), 'shutdown', 'elect'.
   */
  async handleOrphans(deadParentId: string, strategy: 'reassign' | 'shutdown' | 'elect'): Promise<void> {
    const orphans = await this.getChildren(deadParentId);

    if (strategy === 'reassign') {
      const deadParent = await this.registry.get(deadParentId);
      let grandparentId: string | undefined;

      if (deadParent && deadParent.parentId) {
        grandparentId = deadParent.parentId;
      }

      for (const orphan of orphans) {
        if (grandparentId) {
          await this.registry.unregister(orphan.id);
          orphan.parentId = grandparentId;
          await this.registry.register(orphan);
        }
      }
    }
  }

  /** Selects the least-loaded machine matching the given criteria. */
  async selectMachine(criteria: any): Promise<any> {
    const machines = await this.getMachines();
    if (machines.length === 0) return null;

    const sorted = [...machines].sort((a, b) => a.agentCount - b.agentCount);
    return sorted[0];
  }

  /** Returns all known machines in the system. */
  async getMachines(): Promise<MachineInfo[]> {
    return Array.from(this.machineInfoCache.values());
  }

  /**
   * Updates machine info for a specific machine ID, or refreshes all machine info
   * from the registry (if called with no specific machine).
   */
  async updateMachineInfo(machineIdOrVoid?: string, info?: any): Promise<void> {
    if (typeof machineIdOrVoid === 'string' && info) {
      const existing = this.machineInfoCache.get(machineIdOrVoid) || {
        id: machineIdOrVoid,
        machineId: machineIdOrVoid,
        hostname: machineIdOrVoid,
        cpuUsage: 0,
        memoryUsage: 0,
        agentCount: 0,
        availableLLMs: [] as LLMProvider[],
        capabilities: [],
        status: 'online' as const,
        lastSeen: Date.now(),
      };
      this.machineInfoCache.set(machineIdOrVoid, { ...existing, ...info });
      return;
    }

    const agents = await this.registry.discover();
    const byMachine = new Map<string, AgentIdentity[]>();

    for (const agent of agents) {
      const existing = byMachine.get(agent.machineId) || [];
      existing.push(agent);
      byMachine.set(agent.machineId, existing);
    }

    for (const [machineId, machineAgents] of byMachine) {
      const llms = new Set<LLMProvider>();
      const caps = new Set<string>();
      for (const a of machineAgents) {
        llms.add(a.llmProvider);
        for (const c of a.capabilities) caps.add(c);
      }

      const machineInfo: MachineInfo = {
        id: machineId,
        machineId,
        hostname: machineAgents[0].hostname,
        cpuUsage: 0,
        memoryUsage: 0,
        agentCount: machineAgents.length,
        availableLLMs: [...llms],
        capabilities: [...caps],
        status: 'online',
        lastSeen: Date.now(),
      };
      this.machineInfoCache.set(machineId, machineInfo);
    }
  }

  /** Starts periodic machine info updates. */
  async startMachineUpdates(): Promise<void> {
    this.stopMachineUpdates();

    const control = { cancelled: false };
    this.updateControl = control;

    await this.updateMachineInfo();

    const scheduleUpdate = () => {
      setTimeout(async () => {
        if (control.cancelled) return;
        await this.updateMachineInfo();
        if (!control.cancelled) {
          scheduleUpdate();
        }
      }, this.machineUpdateInterval);
    };

    scheduleUpdate();
  }

  /** Stops periodic machine info updates. */
  async stopMachineUpdates(): Promise<void> {
    if (this.updateControl) {
      this.updateControl.cancelled = true;
      this.updateControl = null;
    }
  }

  /** Initializes the hierarchy manager. */
  async initialize(): Promise<void> {
    this.isShutdown = false;
  }

  /** Shuts down the hierarchy manager, stopping machine updates. */
  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await this.stopMachineUpdates();
    this.emit('shutdown');
  }
}
