export {
  ErrorType,
  ErrorCategory,
  DistributedError,
  classifyError,
  categorizeError,
} from './ErrorClassification.js';

export {
  retryWithBackoff,
  executeWithFallback,
} from './RetryStrategy.js';
export type { RetryConfig, RetryResult } from './RetryStrategy.js';

export {
  CircuitState,
  DistributedCircuitBreaker,
  DistributedCircuitBreaker as CircuitBreaker,
} from './DistributedCircuitBreaker.js';
export type { CircuitBreakerConfig } from './DistributedCircuitBreaker.js';

export { ErrorMetrics } from './ErrorMetrics.js';

/** Predefined recovery strategies for handling failures in different operational contexts. */
export const RecoveryStrategies = {
  /** Handles failures related to hub connectivity. */
  async handleHubFailure(_operation: string, _context: any): Promise<void> {
  },

  /** Handles failures caused by network partitions. */
  async handleNetworkPartition(_operation: string, _context: any): Promise<void> {
  },

  /** Handles failures from tool execution errors. */
  async handleToolFailure(
    _toolName: string,
    _error: InstanceType<typeof DistributedError>
  ): Promise<void> {
  },
};
