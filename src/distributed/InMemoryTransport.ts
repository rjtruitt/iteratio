import type { ITransport } from './AgentMessageBusTypes.js';

/** In-memory implementation of ITransport for local single-process testing. */
export class InMemoryTransport implements ITransport {
  private subscriptions: Map<string, Set<(message: any) => void>> = new Map();
  private closed = false;

  /** Publishes a message to all subscribers of the topic. */
  async publish(topic: string, message: any): Promise<void> {
    if (this.closed) throw new Error('Transport is closed');
    const handlers = this.subscriptions.get(topic);
    if (handlers) {
      for (const handler of handlers) {
        handler(message);
      }
    }
  }

  /** Subscribes a handler to a topic. */
  async subscribe(topic: string, handler: (message: any) => void): Promise<void> {
    if (this.closed) throw new Error('Transport is closed');
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
    }
    this.subscriptions.get(topic)!.add(handler);
  }

  /** Unsubscribes all handlers for the given topic. */
  async unsubscribe(topic: string): Promise<void> {
    this.subscriptions.delete(topic);
  }

  /** Not supported at the transport level; use AgentMessageBus.request() instead. */
  async request(_topic: string, _message: any, _timeout: number): Promise<any> {
    throw new Error('Use AgentMessageBus.request() instead');
  }

  /** Closes the transport, preventing further messages. */
  async close(): Promise<void> {
    this.closed = true;
    this.subscriptions.clear();
  }

  /** Returns whether the transport has been closed. */
  isClosed(): boolean {
    return this.closed;
  }
}

const globalTransportRegistry = new Map<string, InMemoryTransport>();

/** Gets or creates a shared InMemoryTransport instance for the given backend URL. */
export function getOrCreateSharedTransport(backendUrl: string): InMemoryTransport {
  if (!globalTransportRegistry.has(backendUrl)) {
    globalTransportRegistry.set(backendUrl, new InMemoryTransport());
  }
  return globalTransportRegistry.get(backendUrl)!;
}
