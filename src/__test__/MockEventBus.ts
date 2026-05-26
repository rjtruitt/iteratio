import type { IEventBus, EventHandler } from '../interfaces/IEventBus.js';

interface EmittedEvent {
  event: string;
  data: unknown;
  timestamp: number;
}

export class MockEventBus implements IEventBus {
  private handlers = new Map<string, Set<EventHandler<unknown>>>();
  private _emitted: EmittedEvent[] = [];

  get emittedEvents() { return this._emitted; }

  on<T = unknown>(event: string, handler: EventHandler<T>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler<unknown>);
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): void {
    const wrapper: EventHandler<T> = (data) => {
      this.off(event, wrapper);
      return handler(data);
    };
    this.on(event, wrapper);
  }

  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    this.handlers.get(event)?.delete(handler as EventHandler<unknown>);
  }

  emit<T = unknown>(event: string, data: T): void {
    this._emitted.push({ event, data, timestamp: Date.now() });
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        handler(data);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }

  emitted(event: string): boolean {
    return this._emitted.some(e => e.event === event);
  }

  emittedCount(event: string): number {
    return this._emitted.filter(e => e.event === event).length;
  }

  emittedWith<T>(event: string, predicate: (data: T) => boolean): boolean {
    return this._emitted
      .filter(e => e.event === event)
      .some(e => predicate(e.data as T));
  }

  lastEmitted<T>(event: string): T | undefined {
    const events = this._emitted.filter(e => e.event === event);
    return events.length > 0 ? events[events.length - 1].data as T : undefined;
  }

  allEmitted<T>(event: string): T[] {
    return this._emitted.filter(e => e.event === event).map(e => e.data as T);
  }

  reset(): void {
    this._emitted = [];
    this.handlers.clear();
  }

  getHandlerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
