import { EventEmitter } from 'events';

/** Configuration for a single poller within the ExternalServicePoller. */
export interface PollerConfig {
  /** Unique poller identifier. */
  id: string;
  /** Optional human-readable name. */
  name?: string;
  /** Polling interval in milliseconds. */
  intervalMs: number;
  /** Async function that fetches data from the external service. */
  poll: (cursor?: unknown) => Promise<PollResult>;
  /** Max consecutive errors before the poller is disabled (default: 10). */
  maxErrors?: number;
  /** Whether to pass the cursor on each poll (default: true). */
  incremental?: boolean;
  /** Initial cursor value for incremental polling. */
  initialCursor?: unknown;
}

/** Result returned by a poll function. */
export interface PollResult {
  /** Items retrieved in this poll cycle. */
  items: unknown[];
  /** Cursor for the next incremental poll. */
  cursor?: unknown;
  /** Whether more items are available to fetch immediately. */
  hasMore?: boolean;
}

/** Runtime status of a single poller. */
export interface PollerStatus {
  /** Poller ID. */
  id: string;
  /** Optional human-readable name. */
  name?: string;
  /** Whether the poller is currently active. */
  running: boolean;
  /** Timestamp (epoch ms) of the last poll. */
  lastPollAt?: number;
  /** Message from the most recent error, if any. */
  lastError?: string;
  /** Number of consecutive errors since last success. */
  consecutiveErrors: number;
  /** Total number of poll cycles executed. */
  totalPolls: number;
  /** Total number of items retrieved across all polls. */
  totalItems: number;
  /** Current cursor position. */
  cursor?: unknown;
}

/** Top-level configuration for the ExternalServicePoller. */
export interface ExternalServicePollerConfig {
  /** Callback invoked when new items are found. */
  onItems?: (pollerId: string, items: unknown[]) => void;
  /** Callback invoked on poll error. */
  onError?: (pollerId: string, error: Error) => void;
}

/**
 * Manages multiple pollers that periodically fetch data from external
 * services and emit events when new items arrive.
 */
export class ExternalServicePoller extends EventEmitter {
  private config: ExternalServicePollerConfig;
  private pollers: Map<string, PollerConfig> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private statuses: Map<string, PollerStatus> = new Map();
  private running = false;

  /**
   * @param config - Optional top-level configuration.
   */
  constructor(config: ExternalServicePollerConfig = {}) {
    super();
    this.config = config;
  }

  /**
   * Registers a new poller. If the service is already running, the
   * poller starts immediately.
   * Emits `poller:registered`.
   * @param pollerConfig - Configuration for the poller.
   * @throws If the config lacks an id, or a poller with that id exists.
   */
  register(pollerConfig: PollerConfig): void {
    if (!pollerConfig || !pollerConfig.id) {
      throw new Error('Poller config must have an id');
    }
    if (this.pollers.has(pollerConfig.id)) {
      throw new Error(`Poller ${pollerConfig.id} already registered`);
    }

    this.pollers.set(pollerConfig.id, pollerConfig);
    this.statuses.set(pollerConfig.id, {
      id: pollerConfig.id,
      name: pollerConfig.name,
      running: false,
      consecutiveErrors: 0,
      totalPolls: 0,
      totalItems: 0,
      cursor: pollerConfig.initialCursor,
    });

    this.emit('poller:registered', pollerConfig.id);

    if (this.running) {
      this.startPoller(pollerConfig);
    }
  }

  /**
   * Unregisters a poller, stopping it first.
   * Emits `poller:unregistered`.
   * @param id - The poller ID to remove.
   * @throws If the poller is not found.
   */
  unregister(id: string): void {
    if (!this.pollers.has(id)) {
      throw new Error(`Poller ${id} not found`);
    }
    this.stopPoller(id);
    this.pollers.delete(id);
    this.statuses.delete(id);
    this.emit('poller:unregistered', id);
  }

  /**
   * Starts all registered pollers.
   * Emits `service:started`.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const [, pollerConfig] of this.pollers) {
      this.startPoller(pollerConfig);
    }

    this.emit('service:started');
  }

  /**
   * Stops all pollers and clears their timers.
   * Emits `service:stopped`.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const [id] of this.pollers) {
      this.stopPoller(id);
    }

    this.emit('service:stopped');
  }

  /**
   * Returns the runtime status of a single poller.
   * @param id - The poller ID.
   * @returns PollerStatus or null if not found.
   */
  getStatus(id: string): PollerStatus | null {
    return this.statuses.get(id) ?? null;
  }

  /** Starts the polling cycle for a single poller. */
  private startPoller(config: PollerConfig): void {
    const status = this.statuses.get(config.id);
    if (!status) return;

    status.running = true;

    this.executePoll(config);

    const timer = setInterval(() => {
      this.executePoll(config);
    }, config.intervalMs);
    this.timers.set(config.id, timer);
  }

  /** Stops a single poller and clears its interval timer. */
  private stopPoller(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    const status = this.statuses.get(id);
    if (status) {
      status.running = false;
    }
  }

  /**
   * Executes a single poll cycle: calls the poll function, processes
   * results, and handles errors. If consecutive errors exceed the
   * limit, the poller is disabled.
   * Emits `poller:items`, `poller:polled`, `poller:error`, and
   * `poller:disabled`.
   */
  private async executePoll(config: PollerConfig): Promise<void> {
    const status = this.statuses.get(config.id);
    if (!status || !this.running) return;

    const maxErrors = config.maxErrors ?? 10;

    try {
      const cursor = config.incremental !== false ? status.cursor : undefined;
      const result = await config.poll(cursor);

      status.lastPollAt = Date.now();
      status.totalPolls++;
      status.consecutiveErrors = 0;
      status.lastError = undefined;

      if (result.items && result.items.length > 0) {
        status.totalItems += result.items.length;
        this.emit('poller:items', config.id, result.items);
        if (this.config.onItems) {
          this.config.onItems(config.id, result.items);
        }
      }

      if (result.cursor !== undefined) {
        status.cursor = result.cursor;
      }

      this.emit('poller:polled', config.id, result);
    } catch (error: unknown) {
      status.consecutiveErrors++;
      const err = error instanceof Error ? error : new Error(String(error));
      status.lastError = err.message;
      status.lastPollAt = Date.now();

      this.emit('poller:error', config.id, err);
      if (this.config.onError) {
        this.config.onError(config.id, err);
      }

      if (status.consecutiveErrors >= maxErrors) {
        this.stopPoller(config.id);
        status.running = false;
        this.emit('poller:disabled', config.id, `Max consecutive errors (${maxErrors}) reached`);
      }
    }
  }
}
