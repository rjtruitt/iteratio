export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time to wait before trying half-open (ms) */
  resetTimeoutMs: number;
  /** Number of successes in half-open before closing */
  successThreshold?: number;
  /** Window to count failures in (ms) */
  failureWindowMs?: number;
}

export interface CircuitBreakerMetrics {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  totalRequests: number;
  totalFailures: number;
  timeInCurrentState: number;
  stateChangedAt: number;
}

export class CircuitBreaker {
  private config: Required<CircuitBreakerConfig>;
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private failures: number[] = []; // timestamps
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private stateChangedAt: number;
  private totalRequests = 0;
  private totalFailures = 0;
  private _stateChanges: Array<{ from: CircuitState; to: CircuitState; timestamp: number }> = [];
  private onStateChange?: (from: CircuitState, to: CircuitState) => void;

  /**
   * Create a new CircuitBreaker with the given configuration.
   *
   * @param config - Configuration for failure threshold, reset timeout, and success threshold
   */
  constructor(config: CircuitBreakerConfig) {
    this.config = {
      ...config,
      successThreshold: config.successThreshold ?? 1,
      failureWindowMs: config.failureWindowMs ?? 60000,
    };
    this.stateChangedAt = Date.now();
  }

  get currentState(): CircuitState {
    if (this.state === 'open' && Date.now() - this.stateChangedAt >= this.config.resetTimeoutMs) {
      this.transitionTo('half-open');
    }
    return this.state;
  }
  get stateChanges() { return this._stateChanges; }
  get metrics(): CircuitBreakerMetrics {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      timeInCurrentState: Date.now() - this.stateChangedAt,
      stateChangedAt: this.stateChangedAt,
    };
  }

  /**
   * Register a callback invoked on every state transition.
   *
   * @param fn - Callback receiving the old and new state
   */
  setOnStateChange(fn: (from: CircuitState, to: CircuitState) => void): void {
    this.onStateChange = fn;
  }

  /**
   * Execute a function through the circuit breaker.
   * Opens the circuit on failures, closes on successful recovery in half-open state.
   *
   * @param fn - The function to execute
   * @returns The function's result
   * @throws CircuitOpenError if circuit is open and not yet ready for retry
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    if (this.state === 'open') {
      if (Date.now() - this.stateChangedAt >= this.config.resetTimeoutMs) {
        this.transitionTo('half-open');
      } else {
        throw new CircuitOpenError('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Check whether a function call would be allowed through the circuit breaker.
   * Automatically transitions from open to half-open if the reset timeout has elapsed.
   *
   * @returns true if execution is permitted
   */
  canExecute(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      return Date.now() - this.stateChangedAt >= this.config.resetTimeoutMs;
    }
    return true; // half-open allows probes
  }

  /**
   * Record a successful execution.
   * If in half-open state and success threshold is reached, transitions to closed.
   */
  onSuccess(): void {
    this.lastSuccessTime = Date.now();
    this.successCount++;

    if (this.state === 'half-open') {
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo('closed');
        this.failureCount = 0;
        this.failures = [];
      }
    }
  }

  /**
   * Record a failed execution.
   * Increments the failure count and transitions to open if threshold is exceeded.
   */
  onFailure(): void {
    this.totalFailures++;
    this.lastFailureTime = Date.now();
    this.failureCount++;
    this.failures.push(Date.now());

    const windowStart = Date.now() - this.config.failureWindowMs;
    this.failures = this.failures.filter(t => t >= windowStart);

    if (this.state === 'half-open') {
      this.transitionTo('open');
      this.successCount = 0;
    } else if (this.state === 'closed') {
      if (this.failures.length >= this.config.failureThreshold) {
        this.transitionTo('open');
        this.successCount = 0;
      }
    }
  }

  /**
   * Manually force the circuit breaker into a specific state.
   *
   * @param newState - The state to transition to
   */
  forceState(newState: CircuitState): void {
    this.transitionTo(newState);
  }

  /**
   * Reset the circuit breaker to its initial closed state, clearing all metrics and history.
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.failures = [];
    this.totalRequests = 0;
    this.totalFailures = 0;
    this.stateChangedAt = Date.now();
    this._stateChanges = [];
  }

  /**
   * Transition the circuit breaker to a new state, recording the state change and invoking the callback.
   *
   * @param newState - The target circuit state
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const from = this.state;
    this.state = newState;
    this.stateChangedAt = Date.now();
    this._stateChanges.push({ from, to: newState, timestamp: Date.now() });
    if (this.onStateChange) {
      this.onStateChange(from, newState);
    }
  }
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}
