export interface ExecutionTask<T = unknown> {
  id: string;
  fn: () => Promise<T>;
  timeoutMs?: number;
  priority?: number;
  dependencies?: string[]; // IDs of tasks that must complete first
  metadata?: Record<string, unknown>;
}

export interface ExecutionResult<T = unknown> {
  id: string;
  success: boolean;
  data?: T;
  error?: Error;
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface ParallelExecutorConfig {
  maxConcurrency: number;
  defaultTimeoutMs?: number;
  perTurnTimeoutMs?: number;
  /** Enable dependency detection and serialization */
  enableDependencyDetection?: boolean;
}

/**
 * Executes tasks in parallel with configurable concurrency limits,
 * individual and per-turn timeouts, and optional dependency resolution.
 */
export class ParallelExecutor {
  private config: ParallelExecutorConfig;
  private running = 0;
  private queue: ExecutionTask[] = [];
  private results = new Map<string, ExecutionResult>();
  private _executions: Array<{ taskId: string; startedAt: number; completedAt?: number }> = [];
  private cancelled = false;
  private turnStart?: number;

  /**
   * Create a new ParallelExecutor with the given configuration.
   *
   * @param config - Configuration for max concurrency, timeouts, and dependency detection
   */
  constructor(config: ParallelExecutorConfig) {
    this.config = config;
  }

  get executions() { return this._executions; }
  get pendingCount() { return this.queue.length; }
  get runningCount() { return this.running; }

  /**
   * Execute tasks with concurrency limit and timeouts
   */
  async executeAll<T>(tasks: ExecutionTask<T>[]): Promise<ExecutionResult<T>[]> {
    this.cancelled = false;
    this.turnStart = Date.now();

    const ordered = this.resolveDependencies(tasks);

    const results: ExecutionResult<T>[] = [];
    let executing: Set<Promise<void>> = new Set();

    for (const task of ordered) {
      if (this.cancelled) {
        results.push({
          id: task.id,
          success: false,
          error: new Error('Cancelled'),
          durationMs: 0,
          cancelled: true,
        });
        continue;
      }

      if (this.config.perTurnTimeoutMs && this.turnStart) {
        const elapsed = Date.now() - this.turnStart;
        if (elapsed >= this.config.perTurnTimeoutMs) {
          results.push({
            id: task.id,
            success: false,
            error: new Error('Turn timeout exceeded'),
            durationMs: 0,
            timedOut: true,
          });
          continue;
        }
      }

      if (task.dependencies && task.dependencies.length > 0) {
        const unmetDeps = task.dependencies.filter(d => !this.results.has(d));
        if (unmetDeps.length > 0) {
          await Promise.all(executing);
          executing.clear();
          const stillUnmet = task.dependencies.filter(d => !this.results.has(d));
          if (stillUnmet.length > 0) {
            results.push({
              id: task.id,
              success: false,
              error: new Error(`Unmet dependencies: ${stillUnmet.join(', ')}`),
              durationMs: 0,
            });
            continue;
          }
        }
      }

      while (this.running >= this.config.maxConcurrency) {
        await Promise.race(executing);
      }

      const promise = this.executeTask(task).then(result => {
        results.push(result as ExecutionResult<T>);
        this.results.set(task.id, result);
        executing.delete(promise);
      });
      executing.add(promise);
    }

    await Promise.allSettled(executing);
    return results;
  }

  /**
   * Execute a single task with timeout
   */
  /**
   * Execute a single task with timeout enforcement.
   *
   * @param task - The task to execute
   * @returns Promise resolving to the execution result
   */
  private async executeTask<T>(task: ExecutionTask<T>): Promise<ExecutionResult<T>> {
    this.running++;
    const startedAt = Date.now();
    this._executions.push({ taskId: task.id, startedAt });

    const timeoutMs = task.timeoutMs || this.config.defaultTimeoutMs || 30000;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        task.fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Task ${task.id} timed out after ${timeoutMs}ms`)), timeoutMs);
          if (timer && typeof timer === 'object' && 'unref' in timer) {
            (timer as NodeJS.Timeout).unref();
          }
        }),
      ]);

      if (timer !== undefined) clearTimeout(timer);

      const completedAt = Date.now();
      const exec = this._executions.find(e => e.taskId === task.id && !e.completedAt);
      if (exec) exec.completedAt = completedAt;

      this.running--;
      return {
        id: task.id,
        success: true,
        data: result,
        durationMs: completedAt - startedAt,
      };
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);

      const completedAt = Date.now();
      const exec = this._executions.find(e => e.taskId === task.id && !e.completedAt);
      if (exec) exec.completedAt = completedAt;

      this.running--;
      const timedOut = (error as Error).message.includes('timed out');
      return {
        id: task.id,
        success: false,
        error: error as Error,
        durationMs: completedAt - startedAt,
        timedOut,
      };
    }
  }

  /**
   * Cancel all pending/running tasks
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Resolve dependencies and return execution order
   */
  /**
   * Resolve task dependencies using topological sort (DFS-based).
   *
   * @param tasks - The tasks to order
   * @returns Tasks in execution order with dependencies first
   */
  private resolveDependencies<T>(tasks: ExecutionTask<T>[]): ExecutionTask<T>[] {
    if (!this.config.enableDependencyDetection) return tasks;

    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const visited = new Set<string>();
    const sorted: ExecutionTask<T>[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const task = taskMap.get(id);
      if (task?.dependencies) {
        for (const dep of task.dependencies) {
          if (taskMap.has(dep)) visit(dep);
        }
      }
      if (task) sorted.push(task);
    };

    for (const task of tasks) {
      visit(task.id);
    }

    return sorted;
  }

  reset(): void {
    this.queue = [];
    this.results.clear();
    this._executions = [];
    this.running = 0;
    this.cancelled = false;
  }
}
