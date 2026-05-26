/** Logger interface. Apps can inject their own implementation. */
export interface ILogger {
  /** Log a debug-level message. */
  debug(message: string, meta?: Record<string, unknown>): void;
  /** Log an info-level message. */
  info(message: string, meta?: Record<string, unknown>): void;
  /** Log a warning-level message. */
  warn(message: string, meta?: Record<string, unknown>): void;
  /** Log an error-level message with optional Error object. */
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
  /** Create a child logger with additional context. */
  child?(context: Record<string, unknown>): ILogger;
}

/** Log levels in ascending order of severity. */
export enum LogLevel {
  /** Detailed debugging information. */
  DEBUG = 'debug',
  /** Informational messages about normal operation. */
  INFO = 'info',
  /** Warnings about potential issues. */
  WARN = 'warn',
  /** Error conditions that should be investigated. */
  ERROR = 'error'
}
