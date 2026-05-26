import { EventEmitter } from 'events';
import { AgentRegistry, AgentIdentity, AgentRole } from './AgentRegistry.js';
import { AgentMessageBus } from './AgentMessageBus.js';
import { WorkCoordinator } from './WorkCoordinator.js';

/** Health status levels for an agent. */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'dead' | 'unknown';

/** Snapshot of an agent's health at a point in time. */
export interface HealthCheck {
  agentId: string;
  status: HealthStatus;
  lastHeartbeat: number;
  lastCheck: number;
  responseTime?: number;
  errorCount: number;
  metadata?: Record<string, any>;
}

/** Details of a detected agent failure event. */
export interface FailureEvent {
  agentId: string;
  agent: AgentIdentity;
  detectedAt: number;
  lastSeen: number;
  reason: 'heartbeat_timeout' | 'crash' | 'unresponsive' | 'network_partition';
  recoveryAction: string;
}

/** Defines how to recover from an agent failure based on its role. */
export interface RecoveryStrategy {
  role: AgentRole;
  action: 'restart' | 'reassign' | 'notify_parent' | 'elect_new_leader' | 'abandon';
  notifyParent?: boolean;
  releaseWork?: boolean;
  respawn?: boolean;
}

/** Configuration for the health monitor, including check intervals and recovery settings. */
export interface HealthMonitorConfig {
  registry: AgentRegistry;
  messageBus: AgentMessageBus;
  workCoordinator?: WorkCoordinator;

  checkInterval?: number;
  heartbeatTimeout?: number;

  autoRecover?: boolean;
  recoveryStrategies?: Map<AgentRole, RecoveryStrategy>;

  enableProbes?: boolean;
  probeTimeout?: number;
}

/** Aggregate health metrics across all agents. */
export interface HealthMetrics {
  totalAgents: number;
  healthyAgents: number;
  degradedAgents: number;
  unhealthyAgents: number;
  deadAgents: number;
  failureRate: number;
  avgResponseTime: number;
  byRole: Record<string, {
    total: number;
    healthy: number;
    dead: number;
  }>;
}

/**
 * Monitors agent health through heartbeat analysis, failure detection,
 * and automatic recovery. Emits events for dead, recovered, and quorum-lost scenarios.
 */
export class HealthMonitor extends EventEmitter {
  private registry: AgentRegistry;
  private messageBus: AgentMessageBus;
  private workCoordinator?: WorkCoordinator;
  private checkInterval: number;
  private heartbeatTimeout: number;
  private autoRecover: boolean;
  private enableProbes: boolean;
  private probeTimeout: number;

  private healthChecks: Map<string, HealthCheck> = new Map();
  private failureHistory: FailureEvent[] = [];
  private monitorControl: { cancelled: boolean } | null = null;
  private watchCallback?: (deadAgent: AgentIdentity) => void;
  private customRecoveryStrategy?: (agent: AgentIdentity) => Promise<any>;
  private isShutdown = false;

  constructor(config: HealthMonitorConfig) {
    super();

    this.registry = config.registry;
    this.messageBus = config.messageBus;
    this.workCoordinator = config.workCoordinator;
    this.checkInterval = config.checkInterval || 10000;
    this.heartbeatTimeout = config.heartbeatTimeout || 60000;
    this.autoRecover = config.autoRecover !== false;
    this.enableProbes = config.enableProbes || false;
    this.probeTimeout = config.probeTimeout || 5000;
  }

  /**
   * Starts watching all agents for health failures.
   * When a dead agent is detected, the optional callback is invoked.
   */
  async watchAgents(callback?: (deadAgent: AgentIdentity) => void): Promise<void> {
    this.stopWatching();
    this.watchCallback = callback;

    const control = { cancelled: false };
    this.monitorControl = control;

    const scheduleCheck = () => {
      setTimeout(async () => {
        if (control.cancelled) return;
        try {
          await this.checkAllAgents();
        } catch (error) {
          this.emit('monitor:error', error);
        }
        if (!control.cancelled) {
          scheduleCheck();
        }
      }, this.checkInterval);
    };

    scheduleCheck();
    this.emit('monitor:started');
  }

  /** Stops the health monitoring loop. */
  stopWatching(): void {
    if (this.monitorControl) {
      this.monitorControl.cancelled = true;
      this.monitorControl = null;
    }
    this.emit('monitor:stopped');
  }

  private async checkAllAgents(): Promise<void> {
    const agents = await this.registry.discover();
    const now = Date.now();

    let deadCount = 0;
    let totalCount = agents.length;

    for (const agent of agents) {
      const previousHealth = this.healthChecks.get(agent.id);
      const health = this.computeHealth(agent, now);
      this.healthChecks.set(agent.id, health);

      if (health.status === 'dead') {
        deadCount++;

        if (!previousHealth || previousHealth.status !== 'dead') {
          const failure: FailureEvent = {
            agentId: agent.id,
            agent,
            detectedAt: now,
            lastSeen: agent.lastHeartbeat,
            reason: 'heartbeat_timeout',
            recoveryAction: 'pending',
          };
          this.failureHistory.push(failure);
          this.emit('agent:dead', failure);

          if (this.watchCallback) {
            this.watchCallback(agent);
          }

          if (this.autoRecover) {
            try {
              await this.recoverFromFailure(agent);
            } catch {
            }
          }
        }
      } else if (previousHealth && previousHealth.status === 'dead') {
        this.emit('agent:recovered', { agentId: agent.id, agent, recoveredAt: now });
      }
    }

    if (totalCount > 0 && deadCount > totalCount / 2) {
      this.emit('system:quorum-lost', {
        deadCount,
        totalCount,
        timestamp: now,
      });
    }
  }

  private computeHealth(agent: AgentIdentity, now: number): HealthCheck {
    const timeSinceHeartbeat = now - agent.lastHeartbeat;

    let status: HealthStatus;
    if (timeSinceHeartbeat > this.heartbeatTimeout) {
      status = 'dead';
    } else if (timeSinceHeartbeat > this.heartbeatTimeout / 2) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    const previous = this.healthChecks.get(agent.id);

    return {
      agentId: agent.id,
      status,
      lastHeartbeat: agent.lastHeartbeat,
      lastCheck: now,
      errorCount: previous?.errorCount || 0,
    };
  }

  /**
   * Attempts to recover from an agent failure by reassigning work and notifying the parent.
   * Uses a custom recovery strategy if one has been registered.
   */
  async recoverFromFailure(agent: AgentIdentity | string): Promise<any> {
    let agentIdentity: AgentIdentity | null;

    if (typeof agent === 'string') {
      agentIdentity = await this.registry.get(agent);
      if (!agentIdentity) {
        return { recovered: false, reason: 'agent not found' };
      }
    } else {
      agentIdentity = agent;
    }

    if (this.customRecoveryStrategy) {
      const result = await this.customRecoveryStrategy(agentIdentity);
      this.emit('agent:recovered', { agentId: agentIdentity.id, ...result });
      return result;
    }

    if (this.workCoordinator) {
      await this.workCoordinator.recoverWorkFromDeadAgent(agentIdentity.id);
    }

    if (agentIdentity.parentId) {
      try {
        await this.messageBus.sendTo(agentIdentity.parentId, {
          type: 'child_died',
          childId: agentIdentity.id,
          childRole: agentIdentity.role,
          timestamp: Date.now(),
        });
      } catch {
      }
    }

    this.emit('agent:recovered', { agentId: agentIdentity.id, recovered: true });
    return { recovered: true };
  }

  /** Returns the latest health check for a specific agent, or null. */
  async getAgentHealth(agentId: string): Promise<HealthCheck | null> {
    if (this.isShutdown) return null;
    return this.healthChecks.get(agentId) || null;
  }

  /** Returns all health checks, optionally filtered by status. */
  getAllHealth(filter?: { status?: HealthStatus }): HealthCheck[] {
    let checks = Array.from(this.healthChecks.values());
    if (filter?.status) {
      checks = checks.filter(c => c.status === filter.status);
    }
    return checks;
  }

  /**
   * Returns the failure history, optionally filtered by agent, role, time range, or limit.
   * Results are sorted newest-first.
   */
  getFailureHistory(options?: {
    agentId?: string;
    role?: AgentRole;
    since?: number;
    limit?: number;
  }): FailureEvent[] {
    let filtered = [...this.failureHistory];

    if (options?.agentId) {
      filtered = filtered.filter(f => f.agentId === options.agentId);
    }
    if (options?.role) {
      filtered = filtered.filter(f => f.agent.role === options.role);
    }
    if (options?.since) {
      filtered = filtered.filter(f => f.detectedAt >= options.since!);
    }

    filtered.sort((a, b) => b.detectedAt - a.detectedAt);

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /** Returns aggregate health metrics (counts by status, failure rate, average response time). */
  getMetrics(): any {
    const allHealth = Array.from(this.healthChecks.values());
    const totalAgents = allHealth.length;
    const healthyAgents = allHealth.filter(h => h.status === 'healthy').length;
    const degradedAgents = allHealth.filter(h => h.status === 'degraded').length;
    const unhealthyAgents = allHealth.filter(h => h.status === 'unhealthy').length;
    const deadAgents = allHealth.filter(h => h.status === 'dead').length;

    const oneHourAgo = Date.now() - 3600000;
    const recentFailures = this.failureHistory.filter(f => f.detectedAt > oneHourAgo);
    const failureRate = recentFailures.length;

    const responseTimes = allHealth
      .map(h => h.responseTime)
      .filter((t): t is number => t !== undefined);
    const avgResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;

    return {
      totalAgents,
      healthyAgents,
      healthyCount: healthyAgents,
      degradedAgents,
      unhealthyAgents,
      deadAgents,
      deadCount: deadAgents,
      failureRate,
      avgResponseTime,
      checkCount: allHealth.length,
    };
  }

  /** Returns a high-level system health assessment ('healthy', 'degraded', or 'critical'). */
  getSystemHealth(): any {
    const metrics = this.getMetrics();
    const totalAgents = metrics.totalAgents;

    let status: 'healthy' | 'degraded' | 'critical';
    let message: string;

    if (totalAgents === 0) {
      status = 'healthy';
      message = 'No agents registered';
    } else if (metrics.deadAgents > totalAgents * 0.5) {
      status = 'critical';
      message = `More than 50% of agents are dead (${metrics.deadAgents}/${totalAgents})`;
    } else if (metrics.unhealthyAgents + metrics.degradedAgents > totalAgents * 0.2) {
      status = 'degraded';
      message = `Some agents are unhealthy or degraded`;
    } else {
      status = 'healthy';
      message = `System is healthy (${metrics.healthyAgents}/${totalAgents} agents healthy)`;
    }

    return { status, message, metrics, agentCount: totalAgents };
  }

  /**
   * Sets a custom recovery strategy, either per-role or a global callback function.
   * When a function is provided, it overrides the default recovery behavior entirely.
   */
  setRecoveryStrategy(strategyOrRole: AgentRole | ((agent: AgentIdentity) => Promise<any>), strategy?: RecoveryStrategy): void {
    if (typeof strategyOrRole === 'function') {
      this.customRecoveryStrategy = strategyOrRole;
    }
  }

  /** Initializes the monitor to an active state. */
  async initialize(): Promise<void> {
    this.isShutdown = false;
  }

  /** Shuts down the monitor, stopping all watches and clearing health state. */
  async shutdown(): Promise<void> {
    this.isShutdown = true;
    this.stopWatching();
    this.healthChecks.clear();
    this.emit('shutdown');
  }
}
