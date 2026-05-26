import { EventEmitter } from 'events';

/** Links an event name to a workflow and stores runtime state. */
export interface TriggerBinding {
  /** Unique binding identifier. */
  id: string;
  /** Name of the event to listen for. */
  event: string;
  /** ID of the workflow to trigger. */
  workflowId: string;
  /** Optional filtering / debounce / transform options. */
  options?: TriggerOptions;
  /** Whether the binding is currently active. */
  active: boolean;
  /** Timestamp (epoch ms) of the last trigger firing. */
  lastTriggered?: number;
}

/** Behavioural options for a trigger binding (filtering, debounce, rate-limit). */
export interface TriggerOptions {
  /** Filter function: only trigger if this returns true */
  filter?: (data: unknown) => boolean;
  /** Debounce delay in ms */
  debounceMs?: number;
  /** Deduplicate: ignore duplicate events within this window (ms) */
  deduplicateMs?: number;
  /** Transform event data before passing to workflow */
  transform?: (data: unknown) => unknown;
  /** Max triggers per minute (rate limit) */
  maxTriggersPerMinute?: number;
}

/** Configuration for the WorkflowTriggerManager. */
export interface WorkflowTriggerManagerConfig {
  /** EventEmitter to listen on for events. */
  eventSource?: EventEmitter;
  /** Callback invoked when a workflow should be triggered. */
  onTrigger?: (workflowId: string, data: unknown) => void | Promise<void>;
}

/**
 * Manages event-to-workflow bindings with support for filtering,
 * debouncing, deduplication, and rate-limiting.
 */
export class WorkflowTriggerManager extends EventEmitter {
  private config: WorkflowTriggerManagerConfig;
  private bindings: Map<string, TriggerBinding> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private dedupeCache: Map<string, number> = new Map();
  private triggerCounts: Map<string, { count: number; windowStart: number }> = new Map();
  private running = false;
  private bindingCounter = 0;
  private eventListeners: Map<string, (data: unknown) => void> = new Map();

  /**
   * @param config - Optional configuration for the manager.
   */
  constructor(config: WorkflowTriggerManagerConfig = {}) {
    super();
    this.config = config;
  }

  /**
   * Creates a binding between an event and a workflow.
   * If the manager is already running, the listener is attached immediately.
   * Emits `binding:created`.
   * @param event - Name of the event to listen for.
   * @param workflowId - ID of the workflow to trigger.
   * @param options - Optional filtering / debounce / transform options.
   * @returns The unique binding ID.
   */
  bind(event: string, workflowId: string, options?: TriggerOptions): string {
    const id = `binding-${++this.bindingCounter}`;
    const binding: TriggerBinding = {
      id,
      event,
      workflowId,
      options,
      active: true,
    };
    this.bindings.set(id, binding);
    this.emit('binding:created', binding);

    if (this.running) {
      this.attachListener(binding);
    }

    return id;
  }

  /**
   * Removes a binding, detaches its listener, and clears any pending timers.
   * Emits `binding:removed`.
   * @param bindingId - ID of the binding to remove.
   * @throws If the binding ID does not exist.
   */
  unbind(bindingId: string): void {
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      throw new Error(`Binding ${bindingId} not found`);
    }
    binding.active = false;
    this.detachListener(binding);
    this.bindings.delete(bindingId);

    const timer = this.debounceTimers.get(bindingId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(bindingId);
    }

    this.emit('binding:removed', bindingId);
  }

  /**
   * Returns all registered trigger bindings.
   * @returns Array of TriggerBinding objects.
   */
  getBindings(): TriggerBinding[] {
    return Array.from(this.bindings.values());
  }

  /**
   * Starts listening for events on all active bindings.
   * Emits `manager:started`.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const binding of this.bindings.values()) {
      if (binding.active) {
        this.attachListener(binding);
      }
    }

    this.emit('manager:started');
  }

  /**
   * Stops listening for events, clears all timers and caches.
   * Emits `manager:stopped`.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const binding of this.bindings.values()) {
      this.detachListener(binding);
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.dedupeCache.clear();
    this.triggerCounts.clear();

    this.emit('manager:stopped');
  }

  /** Subscribes to the event source for the given binding. */
  private attachListener(binding: TriggerBinding): void {
    const source = this.config.eventSource;
    if (!source) return;

    const handler = (data: unknown) => this.handleEvent(binding, data);
    this.eventListeners.set(binding.id, handler);
    source.on(binding.event, handler);
  }

  /** Removes the event-source listener for the given binding. */
  private detachListener(binding: TriggerBinding): void {
    const source = this.config.eventSource;
    if (!source) return;

    const handler = this.eventListeners.get(binding.id);
    if (handler) {
      source.removeListener(binding.event, handler);
      this.eventListeners.delete(binding.id);
    }
  }

  /**
   * Processes an incoming event: applies filter, rate-limit, deduplication,
   * transform, and debounce before firing the trigger.
   */
  private handleEvent(binding: TriggerBinding, data: unknown): void {
    if (!binding.active || !this.running) return;

    const options = binding.options;

    if (options?.filter && !options.filter(data)) {
      return;
    }

    if (options?.maxTriggersPerMinute) {
      if (!this.checkRateLimit(binding.id, options.maxTriggersPerMinute)) {
        this.emit('trigger:rate-limited', binding);
        return;
      }
    }

    if (options?.deduplicateMs) {
      const key = `${binding.id}:${JSON.stringify(data)}`;
      const lastSeen = this.dedupeCache.get(key);
      if (lastSeen && Date.now() - lastSeen < options.deduplicateMs) {
        this.emit('trigger:deduplicated', binding);
        return;
      }
      this.dedupeCache.set(key, Date.now());
    }

    const transformedData = options?.transform ? options.transform(data) : data;

    if (options?.debounceMs) {
      const existingTimer = this.debounceTimers.get(binding.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      const timer = setTimeout(() => {
        this.debounceTimers.delete(binding.id);
        this.fireTrigger(binding, transformedData);
      }, options.debounceMs);
      this.debounceTimers.set(binding.id, timer);
    } else {
      this.fireTrigger(binding, transformedData);
    }
  }

  /**
   * Fires the trigger for a binding: updates lastTriggered, emits
   * `trigger:fired`, and invokes the onTrigger callback.
   */
  private fireTrigger(binding: TriggerBinding, data: unknown): void {
    binding.lastTriggered = Date.now();
    this.emit('trigger:fired', binding, data);

    if (this.config.onTrigger) {
      Promise.resolve(this.config.onTrigger(binding.workflowId, data)).catch(err => {
        this.emit('trigger:error', binding, err);
      });
    }
  }

  /** Returns true if the binding has not exceeded its per-minute rate limit. */
  private checkRateLimit(bindingId: string, maxPerMinute: number): boolean {
    const now = Date.now();
    const entry = this.triggerCounts.get(bindingId);

    if (!entry || now - entry.windowStart >= 60000) {
      this.triggerCounts.set(bindingId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= maxPerMinute) {
      return false;
    }

    entry.count++;
    return true;
  }
}
