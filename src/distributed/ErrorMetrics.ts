import { DistributedError, ErrorType } from './ErrorClassification.js';
import { CircuitState } from './DistributedCircuitBreaker.js';

/** Aggregates error, retry, and circuit breaker metrics for observability. */
export class ErrorMetrics {
  private totalErrors = 0;
  private byType: Record<string, number> = {};
  private totalRetries = 0;
  private retriesByOperation: Record<string, number> = {};
  private circuitStateChanges = 0;

  /** Records an error occurrence, incrementing type-specific counters. */
  recordError(error: DistributedError): void {
    this.totalErrors++;
    this.byType[error.type] = (this.byType[error.type] || 0) + 1;
  }

  /** Records a retry attempt for a given component/operation. */
  recordRetry(componentOrOperation: string, operation?: string, _attempt?: number): void {
    this.totalRetries++;
    const key = operation || componentOrOperation;
    this.retriesByOperation[key] = (this.retriesByOperation[key] || 0) + 1;
  }

  /** Records a circuit breaker state change. */
  recordCircuitStateChange(_nameOrFrom: string | CircuitState, _fromOrTo?: CircuitState, _to?: CircuitState): void {
    this.circuitStateChanges++;
  }

  /** Returns a snapshot of all accumulated error and retry metrics. */
  getStats(): {
    totalErrors: number;
    byType: Record<string, number>;
    totalRetries: number;
    retriesByOperation: Record<string, number>;
    circuitStateChanges: number;
  } {
    return {
      totalErrors: this.totalErrors,
      byType: { ...this.byType },
      totalRetries: this.totalRetries,
      retriesByOperation: { ...this.retriesByOperation },
      circuitStateChanges: this.circuitStateChanges,
    };
  }
}
