import type { Task, QueueStats } from './TaskQueue.js';
import type { WorkerPoolConfig } from './WorkerPool.js';
import type { WorkerPool } from './WorkerPool.js';

/** Fluent builder for WorkerPool configuration. */
export class WorkerPoolBuilder {
  private config: Partial<WorkerPoolConfig> = {};

  /**
   * Sets the total number of tasks to process.
   * @param count - Maximum number of tasks to pull from the loader.
   * @returns this (for chaining).
   */
  totalTasks(count: number): this {
    this.config.totalTasks = count;
    return this;
  }

  /**
   * Sets the maximum number of concurrent workers.
   * @param count - Number of workers.
   * @returns this (for chaining).
   */
  maxConcurrent(count: number): this {
    this.config.maxConcurrent = count;
    return this;
  }

  /**
   * Assigns a shared registry object for worker state.
   * @param registry - Shared key-value store for worker state.
   * @returns this (for chaining).
   */
  registry(registry: Record<string, unknown>): this {
    this.config.registry = registry;
    return this;
  }

  /**
   * Sets a custom async function that returns the tasks to process.
   * @param loader - Async function returning Task[].
   * @returns this (for chaining).
   */
  taskLoader(loader: () => Promise<Task[]>): this {
    this.config.taskLoader = loader;
    return this;
  }

  /**
   * Reads tasks from a text file (one task title per line).
   * @param filePath - Path to the text file.
   * @returns this (for chaining).
   */
  fromFile(filePath: string): this {
    this.config.taskLoader = async () => {
      const { readFile } = await import('fs/promises');
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      return lines.map((title, i) => ({
        id: `task-${String(i + 1).padStart(3, '0')}`,
        title: title.trim(),
        priority: 1,
      }));
    };
    return this;
  }

  /**
   * Provides a static array of tasks directly.
   * @param tasks - Array of Task objects.
   * @returns this (for chaining).
   */
  tasks(tasks: Task[]): this {
    this.config.taskLoader = async () => tasks;
    return this;
  }

  /**
   * Creates a task for each search term (each term becomes a task title).
   * @param terms - Array of search-term strings.
   * @returns this (for chaining).
   */
  withSearchTerms(terms: string[]): this {
    this.config.taskLoader = async () =>
      terms.map((title, i) => ({
        id: `task-${String(i + 1).padStart(3, '0')}`,
        title,
        priority: 1,
      }));
    return this;
  }

  /**
   * Sets a base instruction prepended to every task prompt.
   * @param prompt - Instruction string.
   * @returns this (for chaining).
   */
  instructions(prompt: string): this {
    this.config.taskPrompt = (task: Task) => `${prompt}\n\nCurrent task: ${task.title}`;
    return this;
  }

  /**
   * Repeats the same instruction N times as separate tasks.
   * @param count - Number of identical tasks to create.
   * @param instruction - The instruction / title for each task.
   * @returns this (for chaining).
   */
  repeat(count: number, instruction: string): this {
    this.config.totalTasks = count;
    this.config.taskLoader = async () =>
      Array.from({ length: count }, (_, i) => ({
        id: `task-${String(i + 1).padStart(3, '0')}`,
        title: instruction,
        priority: 1,
      }));
    return this;
  }

  /**
   * Maximum conversation turns per task.
   * @param turns - Turn limit.
   * @returns this (for chaining).
   */
  maxTurnsPerTask(turns: number): this {
    this.config.maxTurnsPerTask = turns;
    return this;
  }

  /**
   * Timeout in milliseconds for a single task.
   * @param ms - Timeout in milliseconds.
   * @returns this (for chaining).
   */
  taskTimeout(ms: number): this {
    this.config.taskTimeout = ms;
    return this;
  }

  /**
   * Number of times to retry a failed task.
   * @param count - Retry count.
   * @returns this (for chaining).
   */
  retryAttempts(count: number): this {
    this.config.retryAttempts = count;
    return this;
  }

  /**
   * Interval between worker health checks.
   * @param ms - Interval in milliseconds.
   * @returns this (for chaining).
   */
  healthCheckInterval(ms: number): this {
    this.config.healthCheckInterval = ms;
    return this;
  }

  /**
   * Sets the system prompt injected into each worker.
   * @param prompt - System prompt string.
   * @returns this (for chaining).
   */
  systemPrompt(prompt: string): this {
    this.config.systemPrompt = prompt;
    return this;
  }

  /**
   * Custom function to build a prompt string from a Task.
   * @param fn - Function receiving a Task and returning a prompt.
   * @returns this (for chaining).
   */
  taskPrompt(fn: (task: Task) => string): this {
    this.config.taskPrompt = fn;
    return this;
  }

  /**
   * Sets the LLM provider used to execute tasks.
   * @param provider - An LLM provider implementing `invoke()`.
   * @returns this (for chaining).
   */
  llmProvider(provider: import('../interfaces/ILLMProvider.js').ILLMProvider): this {
    this.config.llmProvider = provider;
    return this;
  }

  /**
   * Callback invoked whenever queue statistics change.
   * @param callback - Progress handler.
   * @returns this (for chaining).
   */
  onProgress(callback: (stats: QueueStats) => void): this {
    this.config.onProgress = callback;
    return this;
  }

  /**
   * Callback invoked when a task completes successfully.
   * @param callback - Completion handler receiving (task, result).
   * @returns this (for chaining).
   */
  onTaskComplete(callback: (task: Task, result: unknown) => void): this {
    this.config.onTaskComplete = callback;
    return this;
  }

  /**
   * Callback invoked when a task fails permanently.
   * @param callback - Failure handler receiving (task, error).
   * @returns this (for chaining).
   */
  onTaskFailed(callback: (task: Task, error: Error | string) => void): this {
    this.config.onTaskFailed = callback;
    return this;
  }

  /**
   * Callback invoked when all tasks have been processed.
   * @param callback - Completion handler receiving final stats.
   * @returns this (for chaining).
   */
  onComplete(callback: (stats: QueueStats) => void): this {
    this.config.onComplete = callback;
    return this;
  }

  /**
   * Sets the internal queue capacity.
   * @param capacity - Maximum queue size.
   * @returns this (for chaining).
   */
  queueCapacity(capacity: number): this {
    this.config.queueCapacity = capacity;
    return this;
  }

  /**
   * Enables distributed execution by providing a work coordinator
   * and/or message bus.
   * @param options - Distributed execution options.
   * @returns this (for chaining).
   */
  distributed(options: {
    workCoordinator?: import('../distributed/WorkCoordinator.js').WorkCoordinator;
    messageBus?: import('../distributed/AgentMessageBus.js').AgentMessageBus;
  }): this {
    this.config.distributed = options;
    return this;
  }

  /**
   * Validates the configuration and constructs a WorkerPool instance.
   * @returns A new WorkerPool configured with the accumulated settings.
   * @throws If totalTasks, maxConcurrent, or taskLoader are missing.
   */
  build(): WorkerPool {
    if (!this.config.totalTasks) throw new Error('totalTasks is required');
    if (!this.config.maxConcurrent) throw new Error('maxConcurrent is required');
    if (!this.config.taskLoader) throw new Error('taskLoader is required (use .fromFile(), .tasks(), .withSearchTerms(), or .taskLoader())');

    // Dynamic import to avoid circular dependency
    const { WorkerPool: WP } = require('./WorkerPool.js');
    return new WP(this.config as WorkerPoolConfig);
  }
}
