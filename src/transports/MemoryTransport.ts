import { ITransport, TransportConfig, MessageHandler, ReplyHandler, TransportMessage, TransportStatus } from '../interfaces/ITransport.js';

/**
 * In-memory transport implementing ITransport for local, single-process
 * pub/sub messaging. Supports NATS-style wildcard topics (*, >), topic
 * prefixing, and optional singleton mode for shared state across instances.
 */
export class MemoryTransport implements ITransport {
  private connected: boolean = false;
  private config: TransportConfig | null = null;
  private subscriptions = new Map<string, Map<string, MessageHandler>>();
  private replyHandlers = new Map<string, ReplyHandler>();
  private stats = {
    messagesPublished: 0,
    messagesReceived: 0,
    errors: 0
  };

  // Static registry to share state across instances (optional for testing)
  private static sharedInstance: MemoryTransport | null = null;
  private useSharedInstance: boolean = false;

  constructor(useSharedInstance: boolean = false) {
    this.useSharedInstance = useSharedInstance;
    if (useSharedInstance && MemoryTransport.sharedInstance) {
      return MemoryTransport.sharedInstance as any;
    }
    if (useSharedInstance) {
      MemoryTransport.sharedInstance = this;
    }
  }

  /**
   * Establish a connection to the in-memory transport.
   *
   * @param config - Transport configuration including topic prefix
   * @throws Error if already connected
   */
  async connect(config: TransportConfig): Promise<void> {
    if (this.connected) {
      throw new Error('Already connected');
    }
    if (!config) {
      throw new Error('Config is required');
    }
    this.config = config;
    this.connected = true;
  }

  /**
   * Disconnect from the in-memory transport and clear all subscriptions and handlers.
   */
  async disconnect(): Promise<void> {
    this.subscriptions.clear();
    this.replyHandlers.clear();
    this.connected = false;

    if (this.useSharedInstance) {
      MemoryTransport.sharedInstance = null;
    }
  }

  /**
   * Publish a message to a topic. All matching subscribers receive the message.
   *
   * @param topic - The topic to publish to
   * @param message - The message payload
   * @throws Error if not connected
   */
  async publish(topic: string, message: any): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const resolvedTopic = this.resolveTopic(topic);

    const transportMessage: TransportMessage = {
      topic: resolvedTopic,
      data: message,
      metadata: {
        timestamp: Date.now(),
        messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      }
    };

    this.stats.messagesPublished++;

    // Deliver to all matching subscribers
    const matchingSubscriptions = this.findMatchingSubscriptions(resolvedTopic);
    for (const [_subscriptionId, handler] of matchingSubscriptions) {
      try {
        await handler(transportMessage);
        this.stats.messagesReceived++;
      } catch (error) {
        this.stats.errors++;
      }
    }
  }

  /**
   * Subscribe to a topic with a handler function. Supports NATS-style wildcards (*, >).
   *
   * @param topic - The topic pattern to subscribe to
   * @param handler - Callback invoked for each matching message
   * @returns A subscription ID for unsubscribing
   * @throws Error if not connected
   */
  async subscribe(topic: string, handler: MessageHandler): Promise<string> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const resolvedTopic = this.resolveTopic(topic);
    const subscriptionId = `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    if (!this.subscriptions.has(resolvedTopic)) {
      this.subscriptions.set(resolvedTopic, new Map());
    }
    const topicSubscriptions = this.subscriptions.get(resolvedTopic)!;
    topicSubscriptions.set(subscriptionId, handler);

    return subscriptionId;
  }

  /**
   * Unsubscribe from a topic using a subscription ID returned by subscribe().
   *
   * @param subscriptionId - The subscription ID to remove
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    for (const [topic, topicSubscriptions] of this.subscriptions) {
      if (topicSubscriptions.has(subscriptionId)) {
        topicSubscriptions.delete(subscriptionId);

        if (topicSubscriptions.size === 0) {
          this.subscriptions.delete(topic);
        }
        return;
      }
    }
  }

  /**
   * Send a request message and wait for a response using the registered reply handler.
   *
   * @param topic - The topic to send the request to
   * @param message - The request payload
   * @param timeout - Maximum wait time in milliseconds (default: 30000)
   * @returns The response payload
   * @throws Error if not connected or no reply handler registered
   */
  async request(topic: string, message: any, timeout: number = 30000): Promise<any> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const resolvedTopic = this.resolveTopic(topic);
    const replyHandler = this.replyHandlers.get(resolvedTopic);
    if (!replyHandler) {
      throw new Error(`No reply handler registered for topic: ${resolvedTopic}`);
    }

    const response = await replyHandler(message);
    return response;
  }

  /**
   * Register a handler that processes request messages and returns responses.
   *
   * @param topic - The topic to handle requests for
   * @param handler - Async handler that receives the request and returns the response
   * @throws Error if not connected
   */
  async reply(topic: string, handler: ReplyHandler): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const resolvedTopic = this.resolveTopic(topic);
    this.replyHandlers.set(resolvedTopic, handler);
  }

  /**
   * Check whether the transport is currently connected.
   *
   * @returns true if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the current transport status with statistics.
   *
   * @returns TransportStatus object with connection state and message counts
   */
  getStatus(): TransportStatus {
    return {
      connected: this.connected,
      backend: 'memory',
      url: 'memory://local',
      subscriptions: Array.from(this.subscriptions.values()).reduce((sum, map) => sum + map.size, 0),
      messagesPublished: this.stats.messagesPublished,
      messagesReceived: this.stats.messagesReceived,
      errors: this.stats.errors
    };
  }

  /**
   * Find all subscriptions that match the given topic (including wildcards)
   */
  private findMatchingSubscriptions(topic: string): Map<string, MessageHandler> {
    const matches = new Map<string, MessageHandler>();

    for (const [subscribedTopic, handlers] of this.subscriptions) {
      if (subscribedTopic === topic) {
        for (const [id, handler] of handlers) {
          matches.set(id, handler);
        }
        continue;
      }

      if (this.topicMatches(subscribedTopic, topic)) {
        for (const [id, handler] of handlers) {
          matches.set(id, handler);
        }
      }
    }

    return matches;
  }

  /**
   * Check if a topic pattern matches a specific topic
   */
  private topicMatches(pattern: string, topic: string): boolean {
    // NATS-style wildcard matching
    // - '*' matches exactly one token
    // - '>' matches one or more tokens (must be last)
    const patternParts = pattern.split('.');
    const topicParts = topic.split('.');

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '>') {
        return i <= topicParts.length - 1;
      }
      if (patternParts[i] === '*') {
        if (i >= topicParts.length) return false;
        continue;
      }
      if (i >= topicParts.length || patternParts[i] !== topicParts[i]) {
        return false;
      }
    }

    return patternParts.length === topicParts.length;
  }

  /**
   * Resolve topic with prefix
   */
  private resolveTopic(topic: string): string {
    if (this.config?.topicPrefix) {
      return `${this.config.topicPrefix}${topic}`;
    }
    return topic;
  }

  /**
   * Reset transport state (useful for testing)
   */
  async reset(): Promise<void> {
    this.subscriptions.clear();
    this.replyHandlers.clear();
    this.stats = {
      messagesPublished: 0,
      messagesReceived: 0,
      errors: 0
    };
  }

  /**
   * Get all active subscriptions (useful for debugging)
   */
  getSubscriptions(): Array<{ id: string; topic: string }> {
    const result: Array<{ id: string; topic: string }> = [];
    for (const [topic, handlers] of this.subscriptions) {
      for (const [id] of handlers) {
        result.push({ id, topic });
      }
    }
    return result;
  }
}
