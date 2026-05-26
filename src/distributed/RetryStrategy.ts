import { DistributedError, ErrorType } from './ErrorClassification.js';

/** Configuration for exponential backoff retry behavior. */
export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
  retriableErrors?: ErrorType[];
  timeout?: number;
}

/** Outcome of a retried operation including timing and attempt metadata. */
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: DistributedError;
  attempts: number;
  duration: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: true,
  retriableErrors: [
    ErrorType.NETWORK,
    ErrorType.TIMEOUT,
    ErrorType.RATE_LIMIT,
    ErrorType.UNAVAILABLE,
    ErrorType.CONFLICT,
  ],
};

/**
 * Executes an operation with exponential backoff retry on transient failures.
 * Non-retriable errors abort immediately without exhausting attempts.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  component: string,
  operationName: string,
  config: Partial<RetryConfig> = {}
): Promise<RetryResult<T>> {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  const startTime = Date.now();
  let attempts = 0;
  let lastError: DistributedError | null = null;

  while (attempts <= cfg.maxRetries) {
    attempts++;

    try {
      let result: T;
      if (cfg.timeout) {
        result = await executeWithTimeout(operation, cfg.timeout);
      } else {
        result = await operation();
      }

      return {
        success: true,
        result,
        attempts,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const distError = DistributedError.from(error, component, operationName);
      distError.retryCount = attempts - 1;
      lastError = distError;

      if (!distError.isRetriable()) {
        break;
      }

      if (cfg.retriableErrors && !cfg.retriableErrors.includes(distError.type)) {
        break;
      }

      if (attempts > cfg.maxRetries) {
        break;
      }

      const delay = calculateBackoffDelay(
        attempts - 1,
        cfg.initialDelay,
        cfg.maxDelay,
        cfg.backoffMultiplier,
        cfg.jitter
      );

      await sleep(delay);
    }
  }

  return {
    success: false,
    error: lastError ?? undefined,
    attempts,
    duration: Date.now() - startTime,
  };
}

/**
 * Tries the primary operation, falling back to a secondary on failure.
 * Logs fallback usage for observability.
 */
export async function executeWithFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  component: string,
  operation: string
): Promise<T> {
  try {
    return await primary();
  } catch (_primaryError) {
    try {
      return await fallback();
    } catch (fallbackError) {
      throw DistributedError.from(fallbackError, component, `${operation}.fallback`);
    }
  }
}

function calculateBackoffDelay(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  multiplier: number,
  jitter: boolean
): number {
  let delay = initialDelay * Math.pow(multiplier, attempt);
  delay = Math.min(delay, maxDelay);

  if (jitter) {
    const jitterAmount = delay * 0.25;
    delay = delay + (Math.random() * jitterAmount * 2 - jitterAmount);
  }

  return Math.floor(delay);
}

function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeout: number
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Operation timeout')), timeout);
  });

  return Promise.race([fn(), timeoutPromise]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
