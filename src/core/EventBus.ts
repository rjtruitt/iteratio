import { injectable } from 'inversify';
import { IEventBus, EventHandler } from '../interfaces/IEventBus.js';

/** In-process event bus with wildcard pattern matching and error isolation. */
@injectable()
export class EventBus implements IEventBus {
  private listeners: Map<string, Set<EventHandler>> = new Map();
  private wildcardListeners: Map<string, Set<EventHandler>> = new Map();
  private errorHandler: ((event: string, error: unknown) => void) | null = null;

  /** Set a global error handler for exceptions thrown by event listeners. */
  onError(handler: (event: string, error: unknown) => void): void {
    this.errorHandler = handler;
  }

  /** Subscribe to an event. Supports trailing wildcard patterns (e.g. "step.*"). */
  on<T = unknown>(event: string, handler: EventHandler<T>): void {
    if (event.includes('*')) {
      if (!this.wildcardListeners.has(event)) {
        this.wildcardListeners.set(event, new Set());
      }
      this.wildcardListeners.get(event)!.add(handler as EventHandler);
    } else {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)!.add(handler as EventHandler);
    }
  }

  /** Subscribe to an event for a single firing, then auto-unsubscribe. */
  once<T = unknown>(event: string, handler: EventHandler<T>): void {
    const wrapper: EventHandler<T> = (data) => {
      this.off(event, wrapper);
      return handler(data);
    };
    this.on(event, wrapper);
  }

  /** Unsubscribe a specific handler from an event. */
  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    const target = event.includes('*') ? this.wildcardListeners : this.listeners;
    const handlers = target.get(event);
    if (handlers) {
      handlers.delete(handler as EventHandler);
      if (handlers.size === 0) target.delete(event);
    }
  }

  /** Emit an event to all matching listeners (exact + wildcard). */
  emit<T = unknown>(event: string, data: T): void {
    const exact = this.listeners.get(event);
    if (exact) {
      for (const handler of exact) {
        this.safeCall(event, handler, data);
      }
    }

    for (const [pattern, handlers] of this.wildcardListeners) {
      if (this.matchWildcard(pattern, event)) {
        for (const handler of handlers) {
          this.safeCall(event, handler, data);
        }
      }
    }
  }

  /** Remove all event listeners (both exact and wildcard). */
  clear(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
  }

  /** Get the number of registered listeners for an exact event name (excludes wildcards). */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  private safeCall(event: string, handler: EventHandler, data: unknown): void {
    try {
      const result = handler(data);
      if (result && typeof (result as any).catch === 'function') {
        (result as Promise<void>).catch((err) => this.handleError(event, err));
      }
    } catch (err) {
      this.handleError(event, err);
    }
  }

  private handleError(event: string, err: unknown): void {
    if (this.errorHandler) {
      this.errorHandler(event, err);
    }
  }

  private matchWildcard(pattern: string, event: string): boolean {
    if (pattern === '*') return true;
    const prefix = pattern.replace(/\*$/, '');
    return event.startsWith(prefix);
  }
}
