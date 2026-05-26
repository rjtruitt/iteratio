import { EventEmitter } from 'events';
import { DistributedError, ErrorType, ErrorCategory } from './ErrorClassification.js';

/** Circuit breaker states following the standard pattern. */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/** Configuration for circuit breaker thresholds and timing. */
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  /** Duration in ms before transitioning from OPEN to HALF_OPEN. */
  timeout: number;
  /** Rolling window in ms for counting failures. */
  windowSize: number;
}

/**
 * Prevents cascading failures by short-circuiting requests to a failing service.
 *
 * State machine: CLOSED -> OPEN (on threshold breach) -> HALF_OPEN (after timeout)
 * -> CLOSED (on success threshold) or back to OPEN (on failure).
 */
export class DistributedCircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number[] = [];
  private successes: number = 0;
  private lastStateChange: number = Date.now();
  private config: CircuitBreakerConfig;

  /**
   * Creates a circuit breaker for the named service or operation.
   * @param circuitName - Identifier for the protected circuit.
   * @param config - Optional overrides for thresholds and timing.
   */
  constructor(
    private readonly circuitName: string,
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    super();

    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      timeout: config.timeout ?? 60000,
      windowSize: config.windowSize ?? 60000,
    };
  }

  /** Executes the operation if the circuit allows it; throws immediately when OPEN. */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.checkState();

    if (this.state === CircuitState.OPEN) {
      throw new DistributedError({
        message: `Circuit breaker [${this.circuitName}] is OPEN - request rejected`,
        type: ErrorType.UNAVAILABLE,
        category: ErrorCategory.TRANSIENT,
        component: 'CircuitBreaker',
        operation: this.circuitName,
        retriable: false,
        context: { circuitState: this.state },
      });
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Returns the current circuit breaker state. */
  getState(): CircuitState {
    return this.state;
  }

  /** Resets the circuit breaker to CLOSED state, clearing all failure/success history. */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = [];
    this.successes = 0;
    this.lastStateChange = Date.now();
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
        this.successes = 0;
        this.failures = [];
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.cleanupFailures();
    }
  }

  private onFailure(): void {
    this.failures.push(Date.now());

    if (this.state === CircuitState.HALF_OPEN) {
      this.transitionTo(CircuitState.OPEN);
      this.successes = 0;
    } else if (this.state === CircuitState.CLOSED) {
      this.cleanupFailures();
      if (this.failures.length >= this.config.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  private checkState(): void {
    if (this.state === CircuitState.OPEN) {
      const timeSinceOpen = Date.now() - this.lastStateChange;
      if (timeSinceOpen >= this.config.timeout) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();
    this.emit('state-change', { name: this.circuitName, from: oldState, to: newState, timestamp: Date.now() });
  }

  private cleanupFailures(): void {
    const now = Date.now();
    this.failures = this.failures.filter((timestamp) => now - timestamp < this.config.windowSize);
  }
}
