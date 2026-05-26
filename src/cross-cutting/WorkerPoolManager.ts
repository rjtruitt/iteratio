export interface PoolTask {
  id: string;
  priority: number;
  data: unknown;
  retries?: number;
  maxRetries?: number;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'dlq';
  result?: unknown;
  error?: string;
  assignedTo?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkerInfo {
  id: string;
  status: 'idle' | 'working' | 'paused' | 'stopped' | 'draining';
  currentTask?: PoolTask;
  version?: number;
  tasksCompleted: number;
}

export interface PoolConfig {
  maxWorkers: number;
  maxRetries?: number;
  enableDLQ?: boolean;
}

/**
 * Manages a pool of workers for processing prioritized tasks with retry logic,
 * dead-letter queue support, rolling updates, and pause/resume capabilities.
 */
export class WorkerPoolManager {
  private config: PoolConfig;
  private workers = new Map<string, WorkerInfo>();
  private queue: PoolTask[] = [];
  private dlq: PoolTask[] = [];
  private completed: PoolTask[] = [];
  private paused = false;
  private _events: Array<{ type: string; data: unknown; timestamp: number }> = [];
  private taskProcessor?: (task: PoolTask, worker: WorkerInfo) => Promise<unknown>;

  /**
   * Create a new WorkerPoolManager.
   *
   * @param config - Pool configuration including max workers, retries, and DLQ settings
   */
  constructor(config: PoolConfig) {
    this.config = { maxRetries: 3, enableDLQ: true, ...config };
  }

  get events() { return this._events; }
  get isPaused() { return this.paused; }
  get workerCount() { return this.workers.size; }
  get queueSize() { return this.queue.length; }
  get dlqSize() { return this.dlq.length; }
  get completedCount() { return this.completed.length; }

  /**
   * Set the task processor function
   */
  setProcessor(fn: (task: PoolTask, worker: WorkerInfo) => Promise<unknown>): void {
    this.taskProcessor = fn;
  }

  /**
   * Add workers
   */
  addWorkers(count: number, startVersion?: number): void {
    for (let i = 0; i < count; i++) {
      const id = `worker-${this.workers.size + 1}`;
      this.workers.set(id, {
        id,
        status: 'idle',
        version: startVersion,
        tasksCompleted: 0,
      });
      this._events.push({ type: 'worker:added', data: { id }, timestamp: Date.now() });
    }
  }

  /**
   * Submit a task to the queue
   */
  submit(task: Omit<PoolTask, 'status' | 'retries'>): void {
    const fullTask: PoolTask = { ...task, status: 'queued', retries: 0 };
    this.queue.push(fullTask);
    this.queue.sort((a, b) => b.priority - a.priority);
    this._events.push({ type: 'task:submitted', data: { id: task.id, priority: task.priority }, timestamp: Date.now() });
  }

  /**
   * Process the next available task
   */
  async processNext(): Promise<PoolTask | null> {
    if (this.paused) return null;
    if (this.queue.length === 0) return null;

    const worker = this.getIdleWorker();
    if (!worker) return null;

    const task = this.queue.shift()!;
    task.status = 'processing';
    task.assignedTo = worker.id;
    task.startedAt = Date.now();
    worker.status = 'working';
    worker.currentTask = task;

    try {
      if (this.taskProcessor) {
        task.result = await this.taskProcessor(task, worker);
      }
      task.status = 'completed';
      task.completedAt = Date.now();
      this.completed.push(task);
      worker.tasksCompleted++;
      this._events.push({ type: 'task:completed', data: { id: task.id, workerId: worker.id }, timestamp: Date.now() });
    } catch (error) {
      task.retries = (task.retries || 0) + 1;
      task.error = (error as Error).message;

      if (task.retries >= (task.maxRetries || this.config.maxRetries!)) {
        if (this.config.enableDLQ) {
          task.status = 'dlq';
          this.dlq.push(task);
          this._events.push({ type: 'task:dlq', data: { id: task.id }, timestamp: Date.now() });
        } else {
          task.status = 'failed';
          this._events.push({ type: 'task:failed', data: { id: task.id }, timestamp: Date.now() });
        }
      } else {
        task.status = 'queued';
        task.assignedTo = undefined;
        task.startedAt = undefined;
        this.queue.push(task);
        this.queue.sort((a, b) => b.priority - a.priority);
        this._events.push({ type: 'task:retry', data: { id: task.id, retry: task.retries }, timestamp: Date.now() });
      }
    } finally {
      worker.status = worker.status === 'draining' ? 'stopped' : 'idle';
      worker.currentTask = undefined;
    }

    return task;
  }

  /**
   * Process all tasks until queue is empty
   */
  async processAll(): Promise<void> {
    while (this.queue.length > 0 && !this.paused) {
      const idle = this.getIdleWorker();
      if (!idle) break;
      await this.processNext();
    }
  }

  /**
   * Pause the pool
   */
  pause(): void {
    this.paused = true;
    this._events.push({ type: 'pool:paused', data: {}, timestamp: Date.now() });
  }

  /**
   * Resume the pool
   */
  resume(): void {
    this.paused = false;
    this._events.push({ type: 'pool:resumed', data: {}, timestamp: Date.now() });
  }

  /**
   * Pause a specific worker
   */
  pauseWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    if (worker.status === 'working') {
      worker.status = 'draining';
    } else {
      worker.status = 'paused';
    }
    return true;
  }

  /**
   * Resume a specific worker
   */
  resumeWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.status = 'idle';
    return true;
  }

  /**
   * Update worker version (rolling update)
   */
  updateWorkerVersion(workerId: string, newVersion: number): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.version = newVersion;
    this._events.push({ type: 'worker:updated', data: { id: workerId, version: newVersion }, timestamp: Date.now() });
    return true;
  }

  /**
   * Staggered rolling update
   */
  async rollingUpdate(newVersion: number, onUpdate?: (workerId: string) => Promise<void>): Promise<void> {
    for (const [id, worker] of this.workers) {
      if (worker.status === 'working') {
        worker.status = 'draining';
      }
      this.pauseWorker(id);
      this.updateWorkerVersion(id, newVersion);
      if (onUpdate) await onUpdate(id);
      this.resumeWorker(id);
    }
  }

  /**
   * Replay DLQ items back to main queue
   */
  replayDLQ(): number {
    const count = this.dlq.length;
    for (const task of this.dlq) {
      task.status = 'queued';
      task.retries = 0;
      task.error = undefined;
      this.queue.push(task);
    }
    this.queue.sort((a, b) => b.priority - a.priority);
    this.dlq = [];
    this._events.push({ type: 'dlq:replayed', data: { count }, timestamp: Date.now() });
    return count;
  }

  /**
   * Get queue snapshot (order preserved)
   */
  getQueueSnapshot(): PoolTask[] {
    return [...this.queue];
  }

  /**
   * Get all worker statuses
   */
  getWorkers(): WorkerInfo[] {
    return [...this.workers.values()];
  }

  /**
   * Get a specific worker
   */
  getWorker(id: string): WorkerInfo | undefined {
    return this.workers.get(id);
  }

  /**
   * Find the first idle worker available to take a task.
   *
   * @returns An idle WorkerInfo, or undefined if all workers are busy
   */
  private getIdleWorker(): WorkerInfo | undefined {
    for (const worker of this.workers.values()) {
      if (worker.status === 'idle') return worker;
    }
    return undefined;
  }

  reset(): void {
    this.workers.clear();
    this.queue = [];
    this.dlq = [];
    this.completed = [];
    this.paused = false;
    this._events = [];
  }
}
