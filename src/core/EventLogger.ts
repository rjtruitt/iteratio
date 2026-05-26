import { injectable } from 'inversify';
import { ILogger, LogLevel } from '../interfaces/ILogger.js';
import type { IEventBus } from '../interfaces/IEventBus.js';

/** A structured log entry emitted as an event on the event bus. */
export interface LogEntry {
  /** ISO-8601 timestamp of when the log entry was created. */
  timestamp: string;
  /** Log severity level (DEBUG, INFO, WARN, ERROR). */
  level: string;
  /** The log message text. */
  message: string;
  /** Additional structured context/metadata for the log entry. */
  context: Record<string, unknown>;
  /** Error details if the log entry represents an error condition. */
  error?: { message: string; stack?: string };
}

/** Logger that emits structured log entries as events on the event bus. */
@injectable()
export class EventLogger implements ILogger {
  private context: Record<string, unknown>;
  private eventBus: IEventBus | null = null;

  constructor(private level: LogLevel = LogLevel.INFO, context?: Record<string, unknown>) {
    this.context = context ?? {};
  }

  /** Attach an event bus to emit log entries as 'log' events. */
  setEventBus(eventBus: IEventBus): void {
    this.eventBus = eventBus;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      this.emitEntry('DEBUG', message, meta);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.INFO)) {
      this.emitEntry('INFO', message, meta);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.WARN)) {
      this.emitEntry('WARN', message, meta);
    }
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      this.emitEntry('ERROR', message, meta, error);
    }
  }

  child(childContext: Record<string, unknown>): ILogger {
    const child = new EventLogger(this.level, { ...this.context, ...childContext });
    if (this.eventBus) child.setEventBus(this.eventBus);
    return child;
  }

  private emitEntry(levelStr: string, message: string, meta?: Record<string, unknown>, error?: Error): void {
    if (!this.eventBus) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: levelStr,
      message,
      context: { ...this.context, ...meta },
      ...(error ? { error: { message: error.message, stack: error.stack } } : {}),
    };

    this.eventBus.emit('log', entry);
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    return levels.indexOf(level) >= levels.indexOf(this.level);
  }
}
