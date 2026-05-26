import { EventEmitter } from 'events';
import { TaskQueue, Task, QueueStats } from './TaskQueue.js';
import { WorkerPoolBuilder } from './WorkerPoolBuilder.js';

export type { Task, QueueStats } from './TaskQueue.js';
export { TaskQueue } from './TaskQueue.js';
export { WorkerPoolBuilder } from './WorkerPoolBuilder.js';

/** Configuration options for constructing a WorkerPool. */
export interface WorkerPoolConfig {
  /** Maximum number of tasks to pull from the loader. */
  totalTasks: number;
  /** Maximum number of workers executing simultaneously. */
  maxConcurrent: number;
  /** Async function that provides the initial batch of tasks. */
  taskLoader: () => Promise<Task[]>;
  /** Optional shared registry for worker state or context. */
  registry?: Record<string, unknown>;
  /** Maximum conversation turns allowed per task. */
  maxTurnsPerTask?: number;
  /** Timeout (ms) for a single task execution. */
  taskTimeout?: number;
  /** Number of times to retry a failed task. */
  retryAttempts?: number;
  /** Interval (ms) between health checks on workers. */
  healthCheckInterval?: number;
  /** System prompt injected into each worker's context. */
  systemPrompt?: string;
  /** Custom function to build a prompt string from a task. */
  taskPrompt?: (task: Task) => string;
  /** Called whenever queue stats change. */
  onProgress?: (stats: QueueStats) => void;
  /** Called when a single task completes successfully. */
  onTaskComplete?: (task: Task, result: unknown) => void;
  /** Called when a single task fails permanently. */
  onTaskFailed?: (task: Task, error: Error | string) => void;
  /** Called when all tasks have been processed. */
  onComplete?: (stats: QueueStats) => void;
  /** Internal queue capacity before backpressure kicks in. */
  queueCapacity?: number;
  /** LLM provider used to execute tasks. */
  llmProvider?: import('../interfaces/ILLMProvider.js').ILLMProvider;
  /** Distributed-execution options. */
  distributed?: {
    /** External work coordinator for distributed runs. */
    workCoordinator?: import('../distributed/WorkCoordinator.js').WorkCoordinator;
    /** Message bus for inter-worker communication. */
    messageBus?: import('../distributed/AgentMessageBus.js').AgentMessageBus;
  };
}

/** Internal representation of a single worker's runtime state. */
interface WorkerState {
  /** Unique worker identifier. */
  id: string;
  /** The agent instance driving this worker. */
  agent: any;
  /** Current lifecycle status of the worker. */
  status: 'idle' | 'working' | 'stopping' | 'dead';
  /** The task currently assigned to this worker, if any. */
  currentTask: Task | null;
  /** Number of conversation turns completed by this worker. */
  turnsCompleted?: number;
  /** Number of tasks completed by this worker. */
  tasksCompleted?: number;
}

/** Orchestrates multiple workers processing tasks from a shared queue. */
export class WorkerPool extends EventEmitter {
  private config: WorkerPoolConfig;
  private queue!: TaskQueue;
  private workers: Map<string, WorkerState> = new Map();
  private running: boolean = false;
  private healthCheckTimer?: NodeJS.Timeout;

  private paused: boolean = false;
  private completionResolvers: Array<(stats: QueueStats) => void> = [];
  private stopped: boolean = false;

  /**
   * @param config - Full configuration for the pool.
   */
  private constructor(config: WorkerPoolConfig) {
    super();
    this.config = config;
  }

  /**
   * Loads tasks, initialises workers, and begins processing.
   * Emits `pool:started`, `queue:backpressure`, and eventually `pool:complete`.
   */
  async start(): Promise<void> {
    const allTasks = await this.config.taskLoader();
    const tasks = allTasks.slice(0, this.config.totalTasks);
    this.queue = new TaskQueue(tasks);

    for (let i = 1; i <= this.config.maxConcurrent; i++) {
      const workerId = `Worker-${i}`;
      this.workers.set(workerId, { id: workerId, agent: null, status: 'idle', currentTask: null });
    }

    this.running = true;
    this.stopped = false;
    this.emit('pool:started');

    if (tasks.length > this.config.maxConcurrent * 2) {
      this.emit('queue:backpressure', { queued: tasks.length, workers: this.config.maxConcurrent });
    }

    this.queue.on('queue:drained', () => {
      this.running = false;
      if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
      const stats = this.queue.getStats();
      if (this.config.onComplete) this.config.onComplete(stats);
      this.emit('pool:complete', stats);
      for (const resolver of this.completionResolvers) {
        resolver(stats);
      }
      this.completionResolvers = [];
    });

    if (this.config.healthCheckInterval) {
      this.healthCheckTimer = setInterval(() => this.checkWorkerHealth(), this.config.healthCheckInterval);
    }

    for (const [id] of this.workers) {
      this.assignNextTask(id);
    }
  }

  /**
   * Gracefully stops all workers. Waits for in-flight tasks to finish
   * before setting all worker statuses to idle.
   * Emits `pool:stopped`.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }

    const inProgressPromises: Promise<void>[] = [];
    for (const [, worker] of this.workers) {
      if (worker.status === 'working') {
        inProgressPromises.push(
          new Promise<void>(resolve => {
            const interval = setInterval(() => {
              if (worker.status !== 'working') {
                clearInterval(interval);
                resolve();
              }
            }, 10);
          })
        );
      }
    }
    await Promise.all(inProgressPromises);

    for (const [, worker] of this.workers) {
      worker.status = 'idle';
    }

    this.emit('pool:stopped');
  }

  /**
   * Returns a snapshot of queue statistics.
   * @returns Current queue stats (all zeros if queue not yet initialised).
   */
  getStats(): QueueStats {
    if (!this.queue) {
      return { queued: 0, inProgress: 0, completed: 0, failed: 0, total: 0 };
    }
    return this.queue.getStats();
  }

  /**
   * Submits a new task to the queue for processing.
   * @param task - The task to enqueue.
   * @throws If the task is null, the pool is stopped, or not yet running.
   */
  submitTask(task: Task): void {
    if (!task) throw new Error('Task cannot be null');
    if (this.stopped) throw new Error('Cannot submit task: pool is stopped');
    if (!this.running) throw new Error('Cannot submit task: pool is not running');
    (this.queue as any).queue.push(task);
  }

  /**
   * Pauses the pool so that idle workers do not pick up new tasks.
   * Optionally auto-resumes after a given timeout.
   * Emits `pool:paused`.
   * @param options - Optional timeout after which to auto-resume.
   */
  async pause(options?: { timeout?: number }): Promise<void> {
    if (this.paused) return;
    this.paused = true;

    await this.waitForIdle();

    this.emit('pool:paused');

    if (options?.timeout) {
      setTimeout(() => {
        if (this.paused) {
          this.resume();
        }
      }, options.timeout);
    }
  }

  /**
   * Resumes processing after a pause. Idle workers will be assigned
   * the next available task.
   * Emits `pool:resumed`.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emit('pool:resumed');

    for (const [id, worker] of this.workers) {
      if (worker.status === 'idle' && this.running) {
        this.assignNextTask(id);
      }
    }
  }

  /**
   * Safely reconfigures the pool by pausing, applying a mutation
   * function to the config, then resuming.
   * @param fn - Mutation function that receives the current config.
   */
  async reconfigure(fn: (config: WorkerPoolConfig) => void): Promise<void> {
    await this.pause();
    try {
      fn(this.config);
    } catch (error) {
      this.resume();
      throw error;
    }
    this.resume();
  }

  /** Polls until every worker is idle. */
  private async waitForIdle(): Promise<void> {
    while (true) {
      let anyWorking = false;
      for (const [, worker] of this.workers) {
        if (worker.status === 'working') {
          anyWorking = true;
          break;
        }
      }
      if (!anyWorking) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  /**
   * Returns a promise that resolves when all tasks have been processed.
   * @returns The final queue stats at completion.
   */
  async waitForCompletion(): Promise<QueueStats> {
    if (this.queue && this.queue.isDrained()) {
      return this.queue.getStats();
    }
    return new Promise<QueueStats>(resolve => {
      this.completionResolvers.push(resolve);
    });
  }

  /**
   * Dequeues the next task and assigns it to the identified worker.
   * If an LLM provider is configured the task is executed through it;
   * otherwise the task is completed with no result.
   * On completion or failure the worker automatically picks up the
   * next task if the pool is still running.
   * @param workerId - ID of the worker to assign to.
   */
  private async assignNextTask(workerId: string): Promise<void> {
    if (!this.running || this.paused) {
      const worker = this.workers.get(workerId);
      if (worker) worker.status = 'idle';
      return;
    }

    const task = this.queue.dequeue();
    if (!task) {
      const worker = this.workers.get(workerId);
      if (worker) worker.status = 'idle';
      return;
    }

    task.assignedTo = workerId;
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.status = 'working';
    worker.currentTask = task;

    try {
      let result: any;
      const taskTimeout = this.config.taskTimeout;

      if (this.config.llmProvider) {
        const prompt = this.config.taskPrompt
          ? this.config.taskPrompt(task)
          : `Process: ${task.title}`;

        const executeTask = async () => {
          const messages = [{ role: 'user' as const, content: prompt }];
          return await this.config.llmProvider!.invoke(messages);
        };

        if (taskTimeout && taskTimeout > 0) {
          result = await Promise.race([
            executeTask(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Task timeout')), taskTimeout)
            )
          ]);
        } else {
          result = await executeTask();
        }
      }

      this.queue.complete(task.id, result);
      worker.currentTask = null;
      worker.status = 'idle';
      worker.tasksCompleted = (worker.tasksCompleted || 0) + 1;
      if (this.config.onTaskComplete) this.config.onTaskComplete(task, result);
      if (this.config.onProgress) this.config.onProgress(this.queue.getStats());

      if (this.running && !this.paused) {
        await this.assignNextTask(workerId);
      }
    } catch (error) {
      worker.currentTask = null;
      worker.status = 'idle';
      this.queue.fail(task.id, error, this.config.retryAttempts ?? 3);
      if (this.config.onTaskFailed) this.config.onTaskFailed(task, error instanceof Error ? error : String(error));
      if (this.config.onProgress) this.config.onProgress(this.queue.getStats());

      if (this.running && !this.paused) {
        await this.assignNextTask(workerId);
      }
    }
  }

  /** Periodic health check (currently a no-op placeholder). */
  private checkWorkerHealth(): void {
  }

  /**
   * Creates a new WorkerPoolBuilder for fluent configuration.
   * @returns A new WorkerPoolBuilder instance.
   */
  static builder(): WorkerPoolBuilder {
    return new WorkerPoolBuilder();
  }
}
