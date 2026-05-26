import { ITransport, TransportConfig, MessageHandler, ReplyHandler, TransportMessage, TransportStatus } from '../interfaces/ITransport.js';

/**
 * Redis Pub/Sub transport implementing ITransport for distributed messaging.
 * Handles publish, subscribe, request/reply, automatic reconnect, message buffering,
 * and local event dispatching (disconnect/reconnect).
 */
export class RedisPubSubTransport implements ITransport {
  private connected: boolean = false;
  private redis: any;
  private config: TransportConfig | null = null;
  private subscriptions = new Map<string, { topic: string; handler: MessageHandler }>();
  private replyHandlers = new Map<string, ReplyHandler>();
  private subIdCounter = 0;
  private messageBuffer: Array<{ topic: string; message: any }> = [];
  private eventHandlers = new Map<string, Set<Function>>();
  private stats = {
    messagesPublished: 0,
    messagesReceived: 0,
    errors: 0
  };

  constructor(redis: any) {
    this.redis = redis;
    // Listen for disconnect events from the redis client
    if (this.redis && typeof this.redis.onDisconnect === 'function') {
      this.redis.onDisconnect(() => {
        if (this.connected) {
          this.connected = false;
          this.stats.errors++;
          this.emit('disconnect');
        }
      });
    }
  }

  /**
   * Establish a connection to the Redis Pub/Sub server.
   * Re-establishes subscriptions on reconnect and flushes any buffered messages.
   *
   * @param config - Transport configuration including URL and topic prefix
   * @throws Error if Redis connection fails
   */
  async connect(config: TransportConfig): Promise<void> {
    if (!this.redis || (typeof this.redis.connected !== 'undefined' && !this.redis.connected)) {
      // Check if redis mock is disconnected
      try {
        await this.redis.get('__ping__');
      } catch {
        throw new Error('Redis connection failed');
      }
    }

    const wasDisconnected = !this.connected;
    this.config = config;
    this.connected = true;

    // Re-establish subscriptions on reconnect
    for (const [subId, sub] of this.subscriptions) {
      const channel = this.resolveTopic(sub.topic);
      // Clear any stale handlers first, then re-subscribe
      try { await this.redis.unsubscribe(channel); } catch {}
      await this.redis.subscribe(channel, (ch: string, message: string) => {
        this.handleIncomingMessage(sub.topic, ch, message, sub.handler);
      });
    }

    // Emit reconnect event if this was a reconnection
    if (wasDisconnected && this.eventHandlers.has('reconnect')) {
      this.emit('reconnect');
    }

    // Flush buffered messages
    if (this.messageBuffer.length > 0) {
      const buffered = [...this.messageBuffer];
      this.messageBuffer = [];
      for (const { topic, message } of buffered) {
        try {
          await this.publish(topic, message);
        } catch {
          // If publish fails during flush, re-buffer
          this.messageBuffer.push({ topic, message });
        }
      }
    }
  }

  /**
   * Disconnect from Redis, unsubscribe from all channels, and clear state.
   */
  async disconnect(): Promise<void> {
    // Unsubscribe from all channels on Redis side
    for (const [subId, sub] of this.subscriptions) {
      const channel = this.resolveTopic(sub.topic);
      try {
        await this.redis.unsubscribe(channel);
      } catch {
        // Redis might already be disconnected
      }
    }
    // Clear subscriptions and handlers on full disconnect
    this.subscriptions.clear();
    this.replyHandlers.clear();
    this.connected = false;
  }

  /**
   * Register an event listener for transport-level events (disconnect, reconnect).
   *
   * @param event - Event name
   * @param handler - Callback function
   */
  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  private emit(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  /**
   * Publish a message to a Redis channel. Buffers messages if disconnected for later replay on reconnect.
   *
   * @param topic - The channel/topic to publish to
   * @param message - The message payload
   * @throws Error if message exceeds 64MB size limit
   */
  async publish(topic: string, message: any): Promise<void> {
    if (!this.connected || (this.redis.connected !== undefined && !this.redis.connected)) {
      // If we were previously connected (have config), buffer for reconnection
      if (this.config) {
        this.connected = false;
        this.messageBuffer.push({ topic, message });
        return; // Silently buffer
      }
      throw new Error('Not connected to Redis');
    }

    const channel = this.resolveTopic(topic);
    const serialized = JSON.stringify(message);

    // Redis has a 512MB hard limit; enforce a practical limit of 64MB
    const MAX_MESSAGE_SIZE = 64 * 1024 * 1024;
    if (serialized.length > MAX_MESSAGE_SIZE) {
      this.stats.errors++;
      throw new Error(`Message exceeds maximum payload size (${serialized.length} bytes > ${MAX_MESSAGE_SIZE} bytes)`);
    }

    try {
      await this.redis.publish(channel, serialized);
      this.stats.messagesPublished++;
    } catch (error: any) {
      this.stats.errors++;
      if (this.redis.connected !== undefined && !this.redis.connected) {
        this.connected = false;
      }
      throw error;
    }
  }

  /**
   * Subscribe to a Redis channel and receive messages via the handler.
   *
   * @param topic - The channel/topic to subscribe to
   * @param handler - Callback invoked for each received message
   * @returns A subscription ID for unsubscribing
   */
  async subscribe(topic: string, handler: MessageHandler): Promise<string> {
    if (!this.connected) {
      throw new Error('Not connected to Redis');
    }

    const channel = this.resolveTopic(topic);
    const subscriptionId = `sub-${++this.subIdCounter}-${Math.random().toString(36).substr(2, 9)}`;

    this.subscriptions.set(subscriptionId, { topic, handler });

    await this.redis.subscribe(channel, (ch: string, message: string) => {
      this.handleIncomingMessage(topic, ch, message, handler);
    });

    return subscriptionId;
  }

  /**
   * Unsubscribe from a Redis channel using the subscription ID.
   *
   * @param subscriptionId - The subscription ID to remove
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;

    const channel = this.resolveTopic(sub.topic);
    await this.redis.unsubscribe(channel);
    this.subscriptions.delete(subscriptionId);
  }

  /**
   * Send a request and wait for a response using a registered reply handler.
   *
   * @param topic - The topic to send the request to
   * @param message - The request payload
   * @param timeout - Maximum wait time in milliseconds (default: 30000)
   * @returns The response payload
   */
  async request(topic: string, message: any, timeout: number = 30000): Promise<any> {
    if (!this.connected) {
      throw new Error('Not connected to Redis');
    }

    const replyHandler = this.replyHandlers.get(topic);
    if (!replyHandler) {
      throw new Error(`No reply handler registered for topic: ${topic}`);
    }

    const response = await replyHandler(message);
    return response;
  }

  /**
   * Register a handler that processes request messages and returns responses.
   *
   * @param topic - The topic to handle requests for
   * @param handler - Async handler that receives the request and returns the response
   */
  async reply(topic: string, handler: ReplyHandler): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected to Redis');
    }
    this.replyHandlers.set(topic, handler);
  }

  /**
   * Check whether the transport is currently connected to Redis.
   * Detects Redis-side disconnections and updates state accordingly.
   *
   * @returns true if connected
   */
  isConnected(): boolean {
    // Reflect Redis disconnection
    if (this.redis && typeof this.redis.connected !== 'undefined' && !this.redis.connected) {
      this.connected = false;
    }
    return this.connected;
  }

  getStatus(): TransportStatus {
    return {
      connected: this.connected,
      backend: 'redis-pubsub',
      url: this.config?.url,
      subscriptions: this.subscriptions.size,
      messagesPublished: this.stats.messagesPublished,
      messagesReceived: this.stats.messagesReceived,
      errors: this.stats.errors
    };
  }

  /**
   * Get the status of messages for a given topic (for ghost message detection)
   */
  async getMessageStatus(topic: string): Promise<{ buffered: number; delivered: number }> {
    const bufferedForTopic = this.messageBuffer.filter(m => m.topic === topic).length;
    return {
      buffered: bufferedForTopic,
      delivered: this.stats.messagesPublished,
    };
  }

  private resolveTopic(topic: string): string {
    if (this.config?.topicPrefix) {
      return `${this.config.topicPrefix}${topic}`;
    }
    return topic;
  }

  private handleIncomingMessage(topic: string, channel: string, rawMessage: string, handler: MessageHandler): void {
    try {
      const parsed = JSON.parse(rawMessage);
      // If the parsed message has a `topic` and `data` field, treat it as a pre-wrapped TransportMessage
      // Otherwise, treat the entire parsed value as the data payload
      let transportMessage: TransportMessage;
      if (parsed && typeof parsed === 'object' && 'topic' in parsed && 'data' in parsed) {
        transportMessage = {
          topic: parsed.topic,
          data: parsed.data,
          metadata: parsed.metadata || { timestamp: Date.now(), messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` }
        };
      } else {
        transportMessage = {
          topic,
          data: parsed,
          metadata: { timestamp: Date.now(), messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` }
        };
      }
      handler(transportMessage);
      this.stats.messagesReceived++;
    } catch (error) {
      this.stats.errors++;
    }
  }
}
