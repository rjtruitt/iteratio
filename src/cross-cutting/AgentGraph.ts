export interface GraphNode {
  id: string;
  type: 'task' | 'condition' | 'spawn' | 'merge' | 'human-input';
  execute?: (context: GraphContext) => Promise<GraphContext>;
  condition?: (context: GraphContext) => string; // returns target node id
  timeoutMs?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface GraphContext {
  data: Record<string, unknown>;
  path: string[]; // nodes visited
  spawned: string[]; // sub-agent IDs spawned
  errors: Array<{ nodeId: string; error: Error }>;
  iteration?: number;
}

export interface GraphConfig {
  maxIterations?: number;
  maxSpawnedAgents?: number;
  defaultNodeTimeoutMs?: number;
}

export interface SubAgent {
  id: string;
  parentNodeId: string;
  status: 'running' | 'completed' | 'failed' | 'timed-out';
  result?: unknown;
  error?: Error;
  startedAt: number;
  completedAt?: number;
}

export class AgentGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private config: Required<GraphConfig>;
  private subAgents = new Map<string, SubAgent>();
  private _executionLog: Array<{ nodeId: string; timestamp: number; result?: string }> = [];
  private paused = false;
  private pauseResolver?: () => void;

  constructor(config: GraphConfig = {}) {
    this.config = {
      maxIterations: config.maxIterations ?? 100,
      maxSpawnedAgents: config.maxSpawnedAgents ?? 10,
      defaultNodeTimeoutMs: config.defaultNodeTimeoutMs ?? 30000,
    };
  }

  get executionLog() { return this._executionLog; }
  get nodeCount() { return this.nodes.size; }
  get edgeCount() { return this.edges.length; }
  get activeSubAgents() { return [...this.subAgents.values()].filter(a => a.status === 'running'); }

  /** Add a node to the graph. */
  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  /** Remove a node and all edges connected to it. */
  removeNode(id: string): boolean {
    if (!this.nodes.delete(id)) return false;
    this.edges = this.edges.filter(e => e.from !== id && e.to !== id);
    return true;
  }

  /** Add a directed edge. Returns false if it would create a cycle. */
  addEdge(from: string, to: string, label?: string): { added: boolean; cycleDetected?: boolean } {
    if (this.wouldCreateCycle(from, to)) {
      return { added: false, cycleDetected: true };
    }
    this.edges.push({ from, to, label });
    return { added: true, cycleDetected: false };
  }

  /** Remove a directed edge between two nodes. */
  removeEdge(from: string, to: string): boolean {
    const idx = this.edges.findIndex(e => e.from === from && e.to === to);
    if (idx === -1) return false;
    this.edges.splice(idx, 1);
    return true;
  }

  /** Execute the graph starting from entryNodeId, following edges until termination. */
  async execute(entryNodeId: string, initialContext: GraphContext): Promise<GraphContext> {
    let context = { ...initialContext, path: [], spawned: [], errors: [], iteration: 0 };
    let currentNodeId: string | null = entryNodeId;

    while (currentNodeId && context.iteration! < this.config.maxIterations) {
      if (this.paused) {
        await new Promise<void>(resolve => { this.pauseResolver = resolve; });
      }

      const node = this.nodes.get(currentNodeId);
      if (!node) {
        context.errors.push({ nodeId: currentNodeId, error: new Error(`Node ${currentNodeId} not found`) });
        break;
      }

      context.path.push(currentNodeId);
      context.iteration = (context.iteration || 0) + 1;
      this._executionLog.push({ nodeId: currentNodeId, timestamp: Date.now() });

      if (node.type === 'spawn') {
        const spawnResult = await this.handleSpawn(node, context);
        context = spawnResult;
      } else if (node.type === 'condition') {
        if (node.condition) {
          currentNodeId = node.condition(context);
          continue;
        }
      } else if (node.type === 'human-input') {
        this.paused = true;
        await new Promise<void>(resolve => { this.pauseResolver = resolve; });
        this.paused = false;
      } else if (node.execute) {
        try {
          const result = await this.executeWithTimeout(node, context);
          context = result;
        } catch (error) {
          context.errors.push({ nodeId: currentNodeId, error: error as Error });
          const errorEdge = this.edges.find(e => e.from === currentNodeId && e.label === 'error');
          if (errorEdge) {
            currentNodeId = errorEdge.to;
            continue;
          }
          break;
        }
      }

      const outgoing = this.edges.filter(e => e.from === currentNodeId && e.label !== 'error');
      if (outgoing.length === 0) break;

      if (outgoing.length === 1) {
        currentNodeId = outgoing[0].to;
      } else {
        const results = await Promise.allSettled(
          outgoing.map(edge => this.execute(edge.to, { ...context }))
        );
        for (const result of results) {
          if (result.status === 'fulfilled') {
            context.data = { ...context.data, ...result.value.data };
            context.errors.push(...result.value.errors);
          }
        }
        break;
      }
    }

    return context;
  }

  /** Resume paused execution (e.g., after human-input node). */
  resume(data?: Record<string, unknown>): void {
    this.paused = false;
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = undefined;
    }
  }

  /** Spawn a sub-agent for a node. Enforces maxSpawnedAgents limit. */
  async spawnSubAgent(nodeId: string, fn: () => Promise<unknown>): Promise<SubAgent> {
    if (this.activeSubAgents.length >= this.config.maxSpawnedAgents) {
      throw new Error(`Max spawned agents (${this.config.maxSpawnedAgents}) reached`);
    }

    const id = `sub-${nodeId}-${Date.now()}`;
    const agent: SubAgent = {
      id,
      parentNodeId: nodeId,
      status: 'running',
      startedAt: Date.now(),
    };
    this.subAgents.set(id, agent);

    try {
      const result = await fn();
      agent.status = 'completed';
      agent.result = result;
      agent.completedAt = Date.now();
    } catch (error) {
      agent.status = 'failed';
      agent.error = error as Error;
      agent.completedAt = Date.now();
    }

    return agent;
  }

  /** Terminate a running sub-agent by ID. */
  terminateSubAgent(id: string): boolean {
    const agent = this.subAgents.get(id);
    if (!agent || agent.status !== 'running') return false;
    agent.status = 'timed-out';
    agent.completedAt = Date.now();
    return true;
  }

  /** Check if adding an edge from -> to would create a cycle (DFS reachability). */
  wouldCreateCycle(from: string, to: string): boolean {
    const visited = new Set<string>();
    const stack = [to];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === from) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      for (const edge of this.edges) {
        if (edge.from === current) {
          stack.push(edge.to);
        }
      }
    }

    return false;
  }

  /** Get all nodes reachable via direct outgoing edges. */
  getDownstream(nodeId: string): string[] {
    return this.edges.filter(e => e.from === nodeId).map(e => e.to);
  }

  /** Get all nodes with direct incoming edges to this node. */
  getUpstream(nodeId: string): string[] {
    return this.edges.filter(e => e.to === nodeId).map(e => e.from);
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Handle a spawn node by creating a sub-agent and executing it with the given context.
   *
   * @param node - The spawn graph node
   * @param context - The current graph execution context
   * @returns Updated context after spawn execution
   */
  private async handleSpawn(node: GraphNode, context: GraphContext): Promise<GraphContext> {
    if (this.activeSubAgents.length >= this.config.maxSpawnedAgents) {
      context.errors.push({ nodeId: node.id, error: new Error('Max spawned agents reached') });
      return context;
    }

    if (node.execute) {
      const agent = await this.spawnSubAgent(node.id, async () => {
        const result = await node.execute!(context);
        return result.data;
      });

      if (agent.status === 'completed') {
        context.spawned.push(agent.id);
        if (agent.result && typeof agent.result === 'object') {
          context.data = { ...context.data, ...(agent.result as Record<string, unknown>) };
        }
      } else {
        context.errors.push({ nodeId: node.id, error: agent.error || new Error('Sub-agent failed') });
      }
    }

    return context;
  }

  /**
   * Execute a graph node with a timeout guard.
   *
   * @param node - The graph node to execute
   * @param context - The current graph context
   * @returns Updated context after node execution
   */
  private async executeWithTimeout(node: GraphNode, context: GraphContext): Promise<GraphContext> {
    const timeout = node.timeoutMs || this.config.defaultNodeTimeoutMs;
    return Promise.race([
      node.execute!(context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Node ${node.id} timed out after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  reset(): void {
    this.nodes.clear();
    this.edges = [];
    this.subAgents.clear();
    this._executionLog = [];
    this.paused = false;
  }
}
