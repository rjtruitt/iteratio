import { AgentConfig, ThreadingConfig } from '../interfaces/IAgentConfig.js';
import { IAgentLoop } from '../interfaces/IAgentLoop.js';
import { WorkerThreadRunner } from './WorkerThreadRunner.js';
import { WebWorkerRunner } from './WebWorkerRunner.js';
import { ChildProcessRunner } from './ChildProcessRunner.js';
import { BroadcastChannelCoordinator } from './BroadcastChannelCoordinator.js';
import { EventEmitter } from 'events';
import {
  RuntimeEnvironment,
  RunnerType,
  RunnerPoolConfig,
  RunnerInfo,
  ThreadingManagerOptions,
} from './ThreadingManagerTypes.js';

export {
  RuntimeEnvironment,
  RunnerType,
  type RunnerPoolConfig,
  type RunnerInfo,
  type ThreadingManagerOptions,
} from './ThreadingManagerTypes.js';

/** Manages threading runners with environment auto-detection and pool lifecycle. */
export class ThreadingManager extends EventEmitter {
  private options: ThreadingManagerOptions;
  private runners = new Map<string, IAgentLoop>();
  private runnerInfo = new Map<string, RunnerInfo>();
  private runnerIdCounter = 0;
  private environment: RuntimeEnvironment;
  private poolConfig: RunnerPoolConfig;
  private healthCheckInterval?: NodeJS.Timeout;

  /**
   * Create a new ThreadingManager with optional configuration.
   * Auto-detects the runtime environment unless disabled in options.
   *
   * @param options - Configuration options for the threading manager
   */
  constructor(options: ThreadingManagerOptions = {}) {
    super();
    this.options = options;
    this.environment = options.autoDetectEnvironment !== false
      ? this.detectEnvironment()
      : RuntimeEnvironment.UNKNOWN;
    this.poolConfig = options.poolConfig || {
      minSize: 0,
      maxSize: 10,
      idleTimeout: 60000,
      strategy: 'least-loaded',
      healthCheckInterval: 10000
    };

    this.startHealthMonitoring();
  }

  /** Create a runner based on configuration. */
  async createRunner(
    agentConfig: AgentConfig,
    threadingConfig?: ThreadingConfig
  ): Promise<IAgentLoop> {
    const config = threadingConfig || this.options.defaultThreadingConfig || {
      mode: 'main'
    };

    const runnerId = this.generateRunnerId();
    let runner: IAgentLoop;
    let runnerType: RunnerType;

    try {
      switch (config.mode) {
        case 'main':
          throw new Error('Main thread runner not yet implemented. Create AgentLoop directly.');

        case 'worker':
          if (this.environment === RuntimeEnvironment.NODE) {
            runner = await this.createWorkerThreadRunner(agentConfig, config);
            runnerType = RunnerType.WORKER_THREAD;
          } else if (this.environment === RuntimeEnvironment.BROWSER) {
            runner = await this.createWebWorkerRunner(agentConfig, config);
            runnerType = RunnerType.WEB_WORKER;
          } else {
            throw new Error(`Worker mode not supported in ${this.environment} environment`);
          }
          break;

        case 'process':
          if (this.environment !== RuntimeEnvironment.NODE) {
            throw new Error('Process mode only supported in Node.js environment');
          }
          runner = await this.createChildProcessRunner(agentConfig, config);
          runnerType = RunnerType.CHILD_PROCESS;
          break;

        default:
          throw new Error(`Unknown threading mode: ${config.mode}`);
      }

      this.runners.set(runnerId, runner);
      this.runnerInfo.set(runnerId, {
        id: runnerId,
        type: runnerType,
        status: 'idle',
        workload: 0,
        uptime: 0,
        totalTasks: 0,
        errors: 0,
        lastActivity: Date.now()
      });

      this.emit('runner-created', { runnerId, runnerType });

      return runner;
    } catch (error) {
      this.emit('runner-error', { runnerId, error });
      throw error;
    }
  }

  /** Create BroadcastChannel coordinator (browser multi-tab). */
  async createBroadcastChannelCoordinator(
    agentConfig: AgentConfig,
    agentLoop: IAgentLoop
  ): Promise<IAgentLoop> {
    if (this.environment !== RuntimeEnvironment.BROWSER) {
      throw new Error('BroadcastChannel only supported in browser environment');
    }

    const coordinator = new BroadcastChannelCoordinator({
      agentConfig,
      agentLoop,
      channelName: `agent-${agentConfig.name || 'default'}`
    });

    await coordinator.initialize();

    const runnerId = this.generateRunnerId();
    this.runners.set(runnerId, coordinator);
    this.runnerInfo.set(runnerId, {
      id: runnerId,
      type: RunnerType.BROADCAST_CHANNEL,
      status: 'idle',
      workload: 0,
      uptime: 0,
      totalTasks: 0,
      errors: 0,
      lastActivity: Date.now()
    });

    return coordinator;
  }

  /** Get an available runner from the pool (least-loaded strategy). */
  async getRunner(): Promise<{ runner: IAgentLoop; runnerId: string }> {
    let selectedId: string | undefined;
    let minWorkload = Infinity;

    for (const [id, info] of this.runnerInfo) {
      if (info.status === 'idle' && info.workload < minWorkload) {
        selectedId = id;
        minWorkload = info.workload;
      }
    }

    if (!selectedId) {
      throw new Error('No available runners in pool');
    }

    const runner = this.runners.get(selectedId)!;
    const info = this.runnerInfo.get(selectedId)!;
    info.status = 'busy';
    info.workload++;
    info.lastActivity = Date.now();

    return { runner, runnerId: selectedId };
  }

  /**
   * Release a runner back to the pool after task completion.
   * Decrements workload and sets status to idle if no remaining tasks.
   *
   * @param runnerId - ID of the runner to release
   */
  releaseRunner(runnerId: string): void {
    const info = this.runnerInfo.get(runnerId);
    if (info) {
      info.workload = Math.max(0, info.workload - 1);
      info.status = info.workload === 0 ? 'idle' : 'busy';
      info.lastActivity = Date.now();
      info.totalTasks++;
    }
  }

  /**
   * Shutdown a specific runner by ID.
   * Sets status to 'shutdown', calls runner.shutdown(), and removes from pool.
   *
   * @param runnerId - ID of the runner to shut down
   */
  async shutdownRunner(runnerId: string): Promise<void> {
    const runner = this.runners.get(runnerId);
    const info = this.runnerInfo.get(runnerId);

    if (runner && info) {
      info.status = 'shutdown';
      await runner.shutdown();
      this.runners.delete(runnerId);
      this.runnerInfo.delete(runnerId);
      this.emit('runner-shutdown', { runnerId });
    }
  }

  /**
   * Shutdown all runners and stop health monitoring.
   * Waits for all shutdown operations to complete before stopping the health check interval.
   */
  async shutdownAll(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];

    for (const runnerId of this.runners.keys()) {
      shutdownPromises.push(this.shutdownRunner(runnerId));
    }

    await Promise.all(shutdownPromises);

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }

  /**
   * Get array of all runner info objects for monitoring and debugging.
   *
   * @returns Array of RunnerInfo for all registered runners
   */
  getRunnerInfo(): RunnerInfo[] {
    return Array.from(this.runnerInfo.values());
  }

  /**
   * Get aggregated runner statistics grouped by status.
   *
   * @returns Record with counts for total, idle, busy, error, and shutdown runners
   */
  getRunnerStats(): Record<string, number> {
    const stats: Record<string, number> = {
      total: 0,
      idle: 0,
      busy: 0,
      error: 0,
      shutdown: 0
    };

    for (const info of this.runnerInfo.values()) {
      stats.total++;
      stats[info.status]++;
    }

    return stats;
  }

  /**
   * Detect the current runtime environment (Node.js, browser, or worker).
   *
   * @returns The detected RuntimeEnvironment enum value
   */
  private detectEnvironment(): RuntimeEnvironment {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      return RuntimeEnvironment.NODE;
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      return RuntimeEnvironment.BROWSER;
    }

    if (typeof self !== 'undefined' && typeof importScripts === 'function') {
      return RuntimeEnvironment.WEB_WORKER;
    }

    if (typeof process !== 'undefined' && !process.versions.node) {
      return RuntimeEnvironment.WORKER_THREAD;
    }

    return RuntimeEnvironment.UNKNOWN;
  }

  /**
   * Create a Worker Thread runner for Node.js environments.
   *
   * @param agentConfig - Agent configuration
   * @param threadingConfig - Threading configuration
   * @returns Initialized WorkerThreadRunner instance
   */
  private async createWorkerThreadRunner(
    agentConfig: AgentConfig,
    threadingConfig: ThreadingConfig
  ): Promise<IAgentLoop> {
    const workerScriptPath = this.options.workerScriptPath || './worker-entry.js';

    const runner = new WorkerThreadRunner({
      agentConfig,
      threadingConfig,
      workerScriptPath
    });

    await runner.initialize();
    return runner;
  }

  /**
   * Create a Web Worker runner for browser environments.
   *
   * @param agentConfig - Agent configuration
   * @param threadingConfig - Threading configuration
   * @returns Initialized WebWorkerRunner instance
   */
  private async createWebWorkerRunner(
    agentConfig: AgentConfig,
    threadingConfig: ThreadingConfig
  ): Promise<IAgentLoop> {
    const workerScriptUrl = this.options.webWorkerScriptUrl ||
      threadingConfig.workerScript ||
      '/agent-worker.js';

    const runner = new WebWorkerRunner({
      agentConfig,
      threadingConfig,
      workerScriptUrl
    });

    await runner.initialize();
    return runner;
  }

  /**
   * Create a Child Process runner for Node.js environments.
   *
   * @param agentConfig - Agent configuration
   * @param threadingConfig - Threading configuration
   * @returns Initialized ChildProcessRunner instance
   */
  private async createChildProcessRunner(
    agentConfig: AgentConfig,
    threadingConfig: ThreadingConfig
  ): Promise<IAgentLoop> {
    const processScriptPath = this.options.processScriptPath || './process-entry.js';

    const runner = new ChildProcessRunner({
      agentConfig,
      threadingConfig,
      processScriptPath
    });

    await runner.initialize();
    return runner;
  }

  /**
   * Start periodic health monitoring for all runners.
   * Performs health checks at the configured interval.
   */
  private startHealthMonitoring(): void {
    const interval = this.poolConfig.healthCheckInterval || 10000;

    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, interval);
  }

  /**
   * Perform a health check on all runners, updating uptime and detecting idle timeouts.
   * Emits 'health-check' and 'runner-idle-timeout' events as appropriate.
   */
  private performHealthCheck(): void {
    const now = Date.now();

    for (const [runnerId, info] of this.runnerInfo) {
      info.uptime = now - (info.lastActivity || now);

      if (
        info.status === 'idle' &&
        info.lastActivity &&
        now - info.lastActivity > (this.poolConfig.idleTimeout || 60000)
      ) {
          this.emit('runner-idle-timeout', { runnerId });
      }

    }

    this.emit('health-check', {
      stats: this.getRunnerStats(),
      runners: this.getRunnerInfo()
    });
  }

  /**
   * Generate a unique runner ID string.
   *
   * @returns A unique runner ID in the format 'runner_{counter}_{timestamp}'
   */
  private generateRunnerId(): string {
    return `runner_${++this.runnerIdCounter}_${Date.now()}`;
  }

  /**
   * Get the detected runtime environment.
   *
   * @returns The current RuntimeEnvironment
   */
  getEnvironment(): RuntimeEnvironment {
    return this.environment;
  }

  /**
   * Check if a threading mode is supported in the current environment.
   *
   * @param mode - The threading mode to check ('main', 'worker', or 'process')
   * @returns true if the mode is supported in the detected environment
   */
  isSupported(mode: 'main' | 'worker' | 'process'): boolean {
    switch (mode) {
      case 'main':
        return true;

      case 'worker':
        return this.environment === RuntimeEnvironment.NODE ||
               this.environment === RuntimeEnvironment.BROWSER;

      case 'process':
        return this.environment === RuntimeEnvironment.NODE;

      default:
        return false;
    }
  }
}

/** Singleton instance for global use. */
let globalThreadingManager: ThreadingManager | undefined;

/** Get or create the global ThreadingManager singleton. */
export function getThreadingManager(options?: ThreadingManagerOptions): ThreadingManager {
  if (!globalThreadingManager) {
    globalThreadingManager = new ThreadingManager(options);
  }
  return globalThreadingManager;
}
