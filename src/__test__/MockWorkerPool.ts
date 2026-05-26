/**
 * MockWorkerPool - Simulates a worker pool with pause/resume/reconfigure capabilities
 * Used by hot-reconfiguration and related scenario tests.
 */

type TaskHandler = (task: any) => void;

export class MockWorkerPool {
  private _state: 'running' | 'pausing' | 'paused' = 'running';
  private _maxConcurrent = 4;
  private _systemPrompt = 'Default system prompt';
  private _tasks = new Map<string, { id: string; input: string; active: boolean }>();
  private _queue: Array<{ id: string; input: string }> = [];
  private _completed: string[] = [];
  private _handlers = new Map<string, Set<Function>>();
  private _reconfigureQueue: Array<{ config: any; resolve: Function; reject: Function }> = [];
  private _reconfigureMode: 'immediate' | 'batch' = 'immediate';
  private _pauseResolve: Function | null = null;
  private _eventBus: any;
  private _config: Record<string, any> = {};
  private _workers: Array<{ systemPrompt: string }> = [];

  constructor(eventBus?: any) {
    this._eventBus = eventBus;
    this._syncWorkers();
  }

  get state() { return this._state; }
  get maxConcurrent() { return this._maxConcurrent; }
  get queuedCount() { return this._queue.length; }
  get completedCount() { return this._completed.length; }

  get activeWorkerCount() {
    return Array.from(this._tasks.values()).filter(t => t.active).length;
  }

  setMaxConcurrent(n: number): void {
    this._maxConcurrent = n;
    this._config.maxConcurrent = n;
    this._syncWorkers();
  }

  submit(task: { id: string; input: string }): { rejected: boolean; reason?: string } {
    if (this._state === 'paused') {
      return { rejected: true, reason: 'Pool is paused' };
    }
    if (this._state === 'pausing') {
      this._queue.push(task);
      return { rejected: false };
    }

    const activeCount = this.activeWorkerCount;
    if (activeCount < this._maxConcurrent) {
      this._tasks.set(task.id, { ...task, active: true });
      return { rejected: false };
    } else {
      this._queue.push(task);
      return { rejected: false };
    }
  }

  async pause(): Promise<void> {
    if (this.activeWorkerCount === 0) {
      this._state = 'paused';
      this._emit('pool:paused');
      return;
    }
    this._state = 'pausing';
    return new Promise<void>(resolve => {
      this._pauseResolve = resolve;
    });
  }

  resume(): void {
    this._state = 'running';
    this._emit('pool:resumed');
    this._processQueue();
  }

  completeTask(id: string): void {
    const task = this._tasks.get(id);
    if (task) {
      task.active = false;
      this._tasks.delete(id);
      this._completed.push(id);
      this._emitHandler('task:complete', { id });

      if ((this._state === 'pausing') && this.activeWorkerCount === 0) {
        this._state = 'paused';
        this._emit('pool:paused');
        if (this._pauseResolve) {
          this._pauseResolve();
          this._pauseResolve = null;
        }
      }
      // Do NOT auto-promote from queue on task completion.
      // Queue processing is explicit via startProcessing() or resume().
    }
  }

  reconfigure(config: any): Promise<void> {
    if (this._state === 'pausing') {
      return Promise.reject(new Error('Cannot reconfigure during pausing transition'));
    }

    if (config._forceFailure) {
      this._emit('reconfigure:failed');
      throw new Error('Reconfiguration forced failure');
    }

    const oldConfig = this.getConfig();

    try {
      if (config.maxConcurrent !== undefined) {
        if (config.maxConcurrent === this._maxConcurrent) {
          // No-op: same value
          return Promise.resolve();
        }
        this._maxConcurrent = config.maxConcurrent;
        this._config.maxConcurrent = config.maxConcurrent;
      }
      if (config.systemPrompt !== undefined) {
        this._systemPrompt = config.systemPrompt;
        this._config.systemPrompt = config.systemPrompt;
      }
      this._syncWorkers();
      this._emit('reconfigure:applied', config);
      return Promise.resolve();
    } catch (e) {
      // Rollback
      this._maxConcurrent = oldConfig.maxConcurrent ?? this._maxConcurrent;
      this._systemPrompt = oldConfig.systemPrompt ?? this._systemPrompt;
      this._syncWorkers();
      throw e;
    }
  }

  async requestReconfigure(config: any): Promise<void> {
    if (this._reconfigureMode === 'batch') {
      return new Promise<void>((resolve, reject) => {
        this._reconfigureQueue.push({ config, resolve, reject });
      });
    }

    // Immediate mode: apply config directly (hot reconfiguration without full pause)
    // This allows reconfiguration while tasks are active
    if (config.maxConcurrent !== undefined) {
      this._maxConcurrent = config.maxConcurrent;
      this._config.maxConcurrent = config.maxConcurrent;
    }
    if (config.systemPrompt !== undefined) {
      this._systemPrompt = config.systemPrompt;
      this._config.systemPrompt = config.systemPrompt;
    }
    this._syncWorkers();
    this._processQueue();
    this._emit('reconfigure:applied', config);
  }

  async flushReconfigureQueue(): Promise<void> {
    if (this._reconfigureQueue.length === 0) return;

    // Merge all queued configs into one
    const mergedConfig: any = {};
    for (const { config } of this._reconfigureQueue) {
      Object.assign(mergedConfig, config);
    }

    if (this._state === 'running') {
      await this.pause();
    }
    this.reconfigure(mergedConfig);
    this.resume();

    // Resolve all queued promises
    for (const { resolve } of this._reconfigureQueue) {
      resolve();
    }
    this._reconfigureQueue = [];
  }

  setReconfigureMode(mode: 'immediate' | 'batch'): void {
    this._reconfigureMode = mode;
  }

  getAllWorkers(): Array<{ systemPrompt: string }> {
    return this._workers;
  }

  getConfig(): Record<string, any> {
    return { ...this._config, maxConcurrent: this._maxConcurrent, systemPrompt: this._systemPrompt };
  }

  getSystemPrompt(): string {
    return this._systemPrompt;
  }

  processAll(): void {
    // Drain all tasks: complete active, promote from queue, repeat until empty
    while (this._tasks.size > 0 || this._queue.length > 0) {
      // Complete all active tasks
      const activeIds = [...this._tasks.keys()];
      for (const id of activeIds) {
        const task = this._tasks.get(id);
        if (task) {
          task.active = false;
          this._tasks.delete(id);
          this._completed.push(id);
          this._emitHandler('task:complete', { id });
        }
      }
      // Promote from queue
      while (this._queue.length > 0 && this._tasks.size < this._maxConcurrent) {
        const task = this._queue.shift()!;
        this._tasks.set(task.id, { ...task, active: true });
      }
    }
  }

  startProcessing(): void {
    this._processQueue();
  }

  on(event: string, handler: Function): void {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event)!.add(handler);
  }

  private _processQueue(): void {
    while (this._queue.length > 0 && this.activeWorkerCount < this._maxConcurrent) {
      const task = this._queue.shift()!;
      this._tasks.set(task.id, { ...task, active: true });
    }
  }

  private _syncWorkers(): void {
    this._workers = [];
    for (let i = 0; i < this._maxConcurrent; i++) {
      this._workers.push({ systemPrompt: this._systemPrompt });
    }
  }

  private _emit(event: string, data?: any): void {
    if (this._eventBus) {
      this._eventBus.emit(event, data);
    }
    this._emitHandler(event, data);
  }

  private _emitHandler(event: string, data?: any): void {
    const handlers = this._handlers.get(event);
    if (handlers) {
      for (const h of handlers) {
        h(data);
      }
    }
  }
}
