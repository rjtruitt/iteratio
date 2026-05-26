/** Error type taxonomy for distributed systems. */
export enum ErrorType {
  NETWORK = 'network',
  TIMEOUT = 'timeout',
  RATE_LIMIT = 'rate_limit',
  AUTH = 'auth',
  VALIDATION = 'validation',
  NOT_FOUND = 'not_found',
  CONFLICT = 'conflict',
  UNAVAILABLE = 'unavailable',
  INTERNAL = 'internal',
  UNKNOWN = 'unknown',
}

/** Determines the retry strategy for a given error. */
export enum ErrorCategory {
  /** May succeed on retry. */
  TRANSIENT = 'transient',
  /** Will never succeed regardless of retries. */
  PERMANENT = 'permanent',
  /** Requires manual intervention. */
  FATAL = 'fatal',
}

/** Structured error for distributed operations with classification and serialization support. */
export class DistributedError extends Error {
  readonly type: ErrorType;
  readonly category: ErrorCategory;
  readonly component: string;
  readonly operation: string;
  retryCount: number;
  readonly retriable: boolean;
  readonly cause?: Error;
  readonly context?: Record<string, any>;
  readonly timestamp: number;

  constructor(options: {
    message: string;
    type: ErrorType;
    category: ErrorCategory;
    component: string;
    operation: string;
    retriable?: boolean;
    cause?: Error;
    context?: Record<string, any>;
  }) {
    super(options.message);
    this.name = 'DistributedError';
    this.type = options.type;
    this.category = options.category;
    this.component = options.component;
    this.operation = options.operation;
    this.retryCount = 0;
    this.retriable = options.retriable ?? (options.category === ErrorCategory.TRANSIENT);
    this.cause = options.cause;
    this.context = options.context;
    this.timestamp = Date.now();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, DistributedError);
    }
  }

  /** Wraps an unknown thrown value into a classified DistributedError. */
  static from(
    error: unknown,
    component: string,
    operation: string
  ): DistributedError {
    if (error instanceof DistributedError) {
      return error;
    }

    if (error instanceof Error) {
      const type = classifyError(error);
      const category = categorizeError(type);

      return new DistributedError({
        message: error.message,
        type,
        category,
        component,
        operation,
        cause: error,
      });
    }

    return new DistributedError({
      message: String(error),
      type: ErrorType.UNKNOWN,
      category: ErrorCategory.PERMANENT,
      component,
      operation,
    });
  }

  /** Returns true if this error is retriable (transient category and retriable flag set). */
  isRetriable(): boolean {
    return this.retriable && this.category === ErrorCategory.TRANSIENT;
  }

  /** Serializes the error to a plain JSON object for logging or transmission. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      type: this.type,
      category: this.category,
      component: this.component,
      operation: this.operation,
      retryCount: this.retryCount,
      retriable: this.retriable,
      timestamp: this.timestamp,
      context: this.context,
      cause: this.cause?.message,
      stack: this.stack,
    };
  }
}

/** Infers error type from message content heuristics. */
export function classifyError(error: Error): ErrorType {
  const message = error.message.toLowerCase();

  if (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('network')
  ) {
    return ErrorType.NETWORK;
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return ErrorType.TIMEOUT;
  }

  if (message.includes('rate limit') || message.includes('too many requests')) {
    return ErrorType.RATE_LIMIT;
  }

  if (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('authentication')
  ) {
    return ErrorType.AUTH;
  }

  if (message.includes('invalid') || message.includes('validation')) {
    return ErrorType.VALIDATION;
  }

  if (message.includes('not found') || message.includes('404')) {
    return ErrorType.NOT_FOUND;
  }

  if (message.includes('conflict') || message.includes('version')) {
    return ErrorType.CONFLICT;
  }

  if (
    message.includes('unavailable') ||
    message.includes('503') ||
    message.includes('service down')
  ) {
    return ErrorType.UNAVAILABLE;
  }

  if (message.includes('internal') || message.includes('500')) {
    return ErrorType.INTERNAL;
  }

  return ErrorType.UNKNOWN;
}

/** Maps an error type to its retry category. */
export function categorizeError(type: ErrorType): ErrorCategory {
  switch (type) {
    case ErrorType.NETWORK:
    case ErrorType.TIMEOUT:
    case ErrorType.RATE_LIMIT:
    case ErrorType.UNAVAILABLE:
    case ErrorType.CONFLICT:
      return ErrorCategory.TRANSIENT;

    case ErrorType.AUTH:
    case ErrorType.VALIDATION:
    case ErrorType.NOT_FOUND:
      return ErrorCategory.PERMANENT;

    case ErrorType.INTERNAL:
    case ErrorType.UNKNOWN:
      return ErrorCategory.FATAL;
  }
}
