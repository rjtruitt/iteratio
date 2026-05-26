import type { ITransport, TransportConfig, TransportMessage, TransportStatus, MessageHandler, ReplyHandler } from '../interfaces/ITransport.js';

export class MockTransport implements ITransport {
  private connected = false;
  private subscriptions = new Map<string, { topic: string; handler: MessageHandler }>();
  private replyHandlers = new Map<string, ReplyHandler>();
  private subIdCounter = 0;
  private _publishedMessages: Array<{ topic: string; message: unknown }> = [];
  private _config?: TransportConfig;
  private _publishHooks: Array<(topic: string, message: unknown) => void> = [];

  get publishedMessages() { return this._publishedMessages; }
  get config() { return this._config; }

  async connect(config: TransportConfig): Promise<void> {
    this._config = config;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.subscriptions.clear();
    this.replyHandlers.clear();
  }

  async publish(topic: string, message: unknown): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    this._publishedMessages.push({ topic, message });

    // Notify publish hooks
    for (const hook of this._publishHooks) {
      hook(topic, message);
    }

    for (const [, sub] of this.subscriptions) {
      if (sub.topic === topic) {
        const transportMessage: TransportMessage = {
          topic,
          data: message,
          metadata: { timestamp: Date.now(), messageId: `msg-${this._publishedMessages.length}` },
        };
        await sub.handler(transportMessage);
      }
    }
  }

  onPublish(hook: (topic: string, message: unknown) => void): void {
    this._publishHooks.push(hook);
  }

  async subscribe(topic: string, handler: MessageHandler): Promise<string> {
    if (!this.connected) throw new Error('Not connected');
    const id = `sub-${++this.subIdCounter}`;
    this.subscriptions.set(id, { topic, handler });
    return id;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    this.subscriptions.delete(subscriptionId);
  }

  async request(topic: string, message: unknown, timeout?: number): Promise<unknown> {
    if (!this.connected) throw new Error('Not connected');
    const handler = this.replyHandlers.get(topic);
    if (!handler) throw new Error(`No reply handler for topic: ${topic}`);
    return handler(message);
  }

  async reply(topic: string, handler: ReplyHandler): Promise<void> {
    if (!this.connected) throw new Error('Not connected');
    this.replyHandlers.set(topic, handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStatus(): TransportStatus {
    return {
      connected: this.connected,
      backend: 'mock',
      subscriptions: this.subscriptions.size,
      messagesPublished: this._publishedMessages.length,
      messagesReceived: 0,
      errors: 0,
    };
  }

  reset(): void {
    this._publishedMessages = [];
    this.subscriptions.clear();
    this.replyHandlers.clear();
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  getSubscriptionsForTopic(topic: string): number {
    return [...this.subscriptions.values()].filter(s => s.topic === topic).length;
  }
}
