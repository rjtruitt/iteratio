import { EventEmitter } from 'events';

/** Represents a single unit of work to be processed by a worker. */
export interface Task {
  /** Unique identifier for the task. */
  id: string;
  /** Human-readable title / description of the task. */
  title: string;
  /** Priority level (higher = processed first). */
  priority: number;
  /** Arbitrary metadata attached to the task. */
  metadata?: Record<string, any>;
  /** Timestamp (epoch ms) when the task was dequeued. */
  startedAt?: number;
  /** Timestamp (epoch ms) when the task completed. */
  completedAt?: number;
  /** ID of the worker the task was assigned to. */
  assignedTo?: string;
  /** Number of retries attempted so far. */
  retries?: number;
  /** Result payload produced by the worker. */
  result?: any;
  /** Error message if the task failed permanently. */
  error?: string;
}

/** Snapshot of current queue metrics. */
export interface QueueStats {
  /** Number of tasks waiting to be processed. */
  queued: number;
  /** Number of tasks currently being processed. */
  inProgress: number;
  /** Number of tasks that completed successfully. */
  completed: number;
  /** Number of tasks that have permanently failed. */
  failed: number;
  /** Total number of tasks across all states. */
  total: number;
}

/** In-memory priority task queue with retry support. */
export class TaskQueue extends EventEmitter {
  private queue: Task[] = [];
  private inProgress: Map<string, Task> = new Map();
  private completed: Task[] = [];
  private failed: Task[] = [];

  /**
   * Creates a new TaskQueue from an array of tasks.
   * Tasks are sorted by priority (descending) on initialization.
   * @param tasks - Initial set of tasks to enqueue.
   */
  constructor(tasks: Task[]) {
    super();
    this.queue = [...tasks].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Removes and returns the highest-priority task from the queue,
   * marking it as in-progress.
   * Emits `task:dequeued` with the task.
   * @returns The dequeued task, or null if the queue is empty.
   */
  dequeue(): Task | null {
    if (this.queue.length === 0) return null;

    const task = this.queue.shift()!;
    task.startedAt = Date.now();
    this.inProgress.set(task.id, task);

    this.emit('task:dequeued', task);
    return task;
  }

  /**
   * Marks an in-progress task as completed, records its result,
   * and moves it to the completed list.
   * Emits `task:completed` and potentially `queue:drained`.
   * @param taskId - ID of the task to complete.
   * @param result - Optional result data from the worker.
   * @throws If the task is not currently in progress.
   */
  complete(taskId: string, result?: any): void {
    const task = this.inProgress.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not in progress`);

    task.completedAt = Date.now();
    task.result = result;
    this.completed.push(task);
    this.inProgress.delete(taskId);

    this.emit('task:completed', task);

    if (this.queue.length === 0 && this.inProgress.size === 0) {
      this.emit('queue:drained');
    }
  }

  /**
   * Marks an in-progress task as failed. If retries remain, it is
   * re-enqueued for another attempt; otherwise it goes to the failed list.
   * Emits `task:retrying`, `task:failed`, or `queue:drained`.
   * @param taskId - ID of the task that failed.
   * @param error - The error or error message.
   * @param maxRetries - Maximum number of retry attempts (default: 3).
   * @throws If the task is not currently in progress.
   */
  fail(taskId: string, error: any, maxRetries: number = 3): void {
    const task = this.inProgress.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not in progress`);

    task.retries = (task.retries || 0) + 1;
    task.error = error?.message || String(error);
    this.inProgress.delete(taskId);

    if (task.retries < maxRetries) {
      task.startedAt = undefined;
      task.assignedTo = undefined;
      this.queue.push(task);
      this.emit('task:retrying', task);
    } else {
      this.failed.push(task);
      this.emit('task:failed', task);

      if (this.queue.length === 0 && this.inProgress.size === 0) {
        this.emit('queue:drained');
      }
    }
  }

  /**
   * Returns a snapshot of the current queue state counts.
   * @returns QueueStats with queued, in-progress, completed, failed, and total counts.
   */
  getStats(): QueueStats {
    return {
      queued: this.queue.length,
      inProgress: this.inProgress.size,
      completed: this.completed.length,
      failed: this.failed.length,
      total: this.queue.length + this.inProgress.size + this.completed.length + this.failed.length,
    };
  }

  /**
   * Checks whether the queue is fully drained (no queued or in-progress tasks).
   * @returns true if no tasks remain.
   */
  isDrained(): boolean {
    return this.queue.length === 0 && this.inProgress.size === 0;
  }
}
