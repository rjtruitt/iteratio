/**
 * NATS transport implementing ITransport for distributed pub/sub messaging.
 *
 * STUB — This class provides the interface skeleton for NATS integration.
 * All public methods throw until the `nats` npm package dependency is added
 * and the implementation is wired in. The commented-out code in each method
 * documents the expected implementation pattern.
 *
 * To implement:
 * 1. Add `"nats": "^2.x"` to dependencies
 * 2. Uncomment the implementation in each method
 * 3. Import `connect, NatsConnection, Subscription` from 'nats'
 * 4. Replace `any` types with proper NATS types
 */
export class NATSTransport implements ITransport {
  private connected = false;
  private connection: any = null;
  private subscriptions = new Map<string, any>();
  private stats = { messagesPublished: 0, messagesReceived: 0, errors: 0 };

  async connect(_config: import('../interfaces/ITransport.js').TransportConfig): Promise<void> {
    throw new Error('NATSTransport is a stub — implement with nats package');
  }

  async disconnect(): Promise<void> {
    this.subscriptions.clear();
    this.connection = null;
    this.connected = false;
    throw new Error('NATSTransport is a stub — implement with nats package');
  }

  async publish(_topic: string, _message: unknown): Promise<void> {
    this.stats.messagesPublished++;
    throw new Error('NATSTransport is a stub — implement with nats package');
  }

  async subscribe(_topic: string, _handler: import('../interfaces/ITransport.js').MessageHandler): Promise<string> {
    const id = `sub-${Date.now()}`;
    this.subscriptions.set(id, null);
    throw new Error('NATSTransport is a stub — implement with nats package');
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.subscriptions.delete(subscriptionId);
    throw new Error('NATSTransport is a stub — implement with nats package');
  }

  async request(_topic: string, _message: unknown, _timeout = 30000): Promise<unknown> {
    throw new Error('NATSTransport is a stub — implement with nats package');
  }

  async reply(_topic: string, _handler: import('../interfaces/ITransport.js').ReplyHandler): Promise<void> {
    throw new Error('NATSTransport is a stub — implement with nats package');
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatus(): import('../interfaces/ITransport.js').TransportStatus {
    return {
      connected: this.connected,
      backend: 'nats',
      subscriptions: this.subscriptions.size,
      messagesPublished: this.stats.messagesPublished,
      messagesReceived: this.stats.messagesReceived,
      errors: this.stats.errors,
    };
  }
}
