import type { ILogger } from '../interfaces/ILogger.js';

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
  timestamp: number;
}

export class MockLogger implements ILogger {
  private _logs: LogEntry[] = [];

  get logs() { return this._logs; }

  debug(message: string, data?: unknown): void {
    this._logs.push({ level: 'debug', message, data, timestamp: Date.now() });
  }

  info(message: string, data?: unknown): void {
    this._logs.push({ level: 'info', message, data, timestamp: Date.now() });
  }

  warn(message: string, data?: unknown): void {
    this._logs.push({ level: 'warn', message, data, timestamp: Date.now() });
  }

  error(message: string, data?: unknown): void {
    this._logs.push({ level: 'error', message, data, timestamp: Date.now() });
  }

  hasLog(level: LogEntry['level'], messageSubstring: string): boolean {
    return this._logs.some(l => l.level === level && l.message.includes(messageSubstring));
  }

  logsAt(level: LogEntry['level']): LogEntry[] {
    return this._logs.filter(l => l.level === level);
  }

  lastLog(): LogEntry | undefined {
    return this._logs[this._logs.length - 1];
  }

  reset(): void {
    this._logs = [];
  }
}
