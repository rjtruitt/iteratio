import { ITransport, TransportConfig, MessageHandler, ReplyHandler, TransportMessage, TransportStatus } from '../interfaces/ITransport.js';

/**
 * BroadcastChannel transport implementing ITransport for multi-tab browser
 * communication. Uses the BroadcastChannel API for pub/sub, supports
 * request/reply with correlation IDs, and handles local message delivery
 * (since BroadcastChannel does not echo to the sending tab).
 */
export class BroadcastChannelTransport implements ITransport {
  private connected: boolean = false;
  private config: TransportConfig | null = null;
  private mainChannel: BroadcastChannel | null = null;
  private subscriptionChannels = new Map<string, { channel: BroadcastChannel; topic: string; handler: MessageHandler }>();
  private replyHandlers = new Map<string, ReplyHandler>();
  private pendingRequests = new Map<string, { resolve: Function; reject: Function; timeout: any }>();
  private ownMessageIds = new Set<string>();
  private subIdCounter = 0;
  private stats = {
    messagesPublished: 0,
    messagesReceived: 0,
    errors: 0
  };

  /**
   * Establish a connection to the BroadcastChannel bus.
   *
   * @param config - Transport configuration including topic prefix for channel naming
   * @throws Error if BroadcastChannel API is not available
   */
  async connect(config: TransportConfig): Promise<void> {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel API is not available in this environment');
    }
    this.config = config;
    const channelName = config.topicPrefix ? `${config.topicPrefix}__bus__` : '__iteratio__bus__';
    this.mainChannel = new BroadcastChannel(channelName);
    this.connected = true;
  }

  /**
   * Disconnect from the BroadcastChannel bus, close all subscription and reply channels,
   * cancel pending requests, and clear all state.
   */
  async disconnect(): Promise<void> {
    // Close all subscription channels
    for (const [, sub] of this.subscriptionChannels) {
      sub.channel.close();
    }
    this.subscriptionChannels.clear();

    // Close main channel
    if (this.mainChannel) {
      this.mainChannel.close();
      this.mainChannel = null;
    }

    // Cancel all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Transport disconnected'));
    }
    this.pendingRequests.clear();
    this.replyHandlers.clear();
    this.ownMessageIds.clear();
    this.connected = false;
  }

  /**
   * Publish a message to a topic on the BroadcastChannel bus.
   * Delivers locally to own subscribers since BroadcastChannel does not echo to the sender.
   *
   * @param topic - The topic to publish to
   * @param message - The message payload
   * @throws Error if not connected
   */
  async publish(topic: string, message: any): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.ownMessageIds.add(messageId);

    const transportMessage: TransportMessage = {
      topic,
      data: message,
      metadata: {
        timestamp: Date.now(),
        messageId,
      }
    };

    // Post on main channel - subscribers on this transport listen on their own
    // BroadcastChannel instance with the same name
    this.mainChannel!.postMessage(transportMessage);
    this.stats.messagesPublished++;

    // Deliver locally to own subscribers (BroadcastChannel spec does NOT echo
    // back to the same object that called postMessage, so local delivery is needed)
    for (const [, sub] of this.subscriptionChannels) {
      if (sub.topic === topic) {
        sub.handler(transportMessage);
        this.stats.messagesReceived++;
      }
    }
  }

  /**
   * Subscribe to a topic and receive messages via the handler.
   * Creates a new BroadcastChannel and sets up message routing with deduplication.
   *
   * @param topic - The topic to subscribe to
   * @param handler - Callback invoked for each matching message
   * @returns A subscription ID for unsubscribing
   */
  async subscribe(topic: string, handler: MessageHandler): Promise<string> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const channelName = this.config?.topicPrefix ? `${this.config.topicPrefix}__bus__` : '__iteratio__bus__';
    const channel = new BroadcastChannel(channelName);
    const subscriptionId = `sub-${++this.subIdCounter}-${Math.random().toString(36).substr(2, 9)}`;

    channel.onmessage = (event: { data: any }) => {
      const message: TransportMessage = event.data;

      // Skip own messages — we already delivered locally in publish()
      if (message.metadata?.messageId && this.ownMessageIds.has(message.metadata.messageId)) {
        return;
      }

      // Only deliver messages for this subscription's topic
      if (message.topic !== topic) {
        return;
      }

      // Check if this is a request needing a reply
      if (message.metadata?.correlationId && (message.metadata as any).replyTo) {
        const replyHandler = this.replyHandlers.get(topic);
        if (replyHandler) {
          Promise.resolve(replyHandler(message.data)).then((response) => {
            const replyChannelName = (message.metadata as any).replyTo;
            const replyChannel = new BroadcastChannel(replyChannelName);
            const replyMessage: TransportMessage = {
              topic: replyChannelName,
              data: response,
              metadata: {
                correlationId: message.metadata!.correlationId,
                timestamp: Date.now(),
                messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
              }
            };
            replyChannel.postMessage(replyMessage);
            replyChannel.close();
          });
          return;
        }
      }

      // Check if this is a reply to a pending request
      if (message.metadata?.correlationId) {
        const pending = this.pendingRequests.get(message.metadata.correlationId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.metadata.correlationId);
          pending.resolve(message.data);
          return;
        }
      }

      // Normal message delivery (from another tab/context)
      handler(message);
      this.stats.messagesReceived++;
    };

    this.subscriptionChannels.set(subscriptionId, { channel, topic, handler });
    return subscriptionId;
  }

  /**
   * Unsubscribe from a topic using the subscription ID.
   * Closes the associated BroadcastChannel.
   *
   * @param subscriptionId - The subscription ID to remove
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const sub = this.subscriptionChannels.get(subscriptionId);
    if (!sub) return;
    sub.channel.close();
    this.subscriptionChannels.delete(subscriptionId);
  }

  /**
   * Send a request and wait for a response using correlation ID-based reply routing.
   * Creates a temporary reply channel and cleans up on completion or timeout.
   *
   * @param topic - The topic to send the request to
   * @param message - The request payload
   * @param timeout - Maximum wait time in milliseconds (default: 30000)
   * @returns The response payload
   */
  async request(topic: string, message: any, timeout: number = 30000): Promise<any> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const correlationId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const replyChannelName = `__reply__${correlationId}`;

    return new Promise((resolve, reject) => {
      // Listen for reply
      const replyChannel = new BroadcastChannel(replyChannelName);
      const timer = setTimeout(() => {
        replyChannel.close();
        this.pendingRequests.delete(correlationId);
        reject(new Error('Request timeout'));
      }, timeout);

      replyChannel.onmessage = (event: { data: any }) => {
        const response: TransportMessage = event.data;
        if (response.metadata?.correlationId === correlationId) {
          clearTimeout(timer);
          replyChannel.close();
          this.pendingRequests.delete(correlationId);
          resolve(response.data);
        }
      };

      this.pendingRequests.set(correlationId, { resolve, reject, timeout: timer });

      // Send request on the bus channel
      const channelName = this.config?.topicPrefix ? `${this.config.topicPrefix}__bus__` : '__iteratio__bus__';
      const requestChannel = new BroadcastChannel(channelName);
      const requestMessage: TransportMessage = {
        topic,
        data: message,
        metadata: {
          correlationId,
          replyTo: replyChannelName,
          timestamp: Date.now(),
          messageId: `req-msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        } as any
      };
      requestChannel.postMessage(requestMessage);
      requestChannel.close();
    });
  }

  /**
   * Register a handler that processes request messages and sends replies via a temporary channel.
   *
   * @param topic - The topic to handle requests for
   * @param handler - Async handler that receives the request and returns the response
   */
  async reply(topic: string, handler: ReplyHandler): Promise<void> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    this.replyHandlers.set(topic, handler);

    // Subscribe to the bus channel to listen for requests
    const channelName = this.config?.topicPrefix ? `${this.config.topicPrefix}__bus__` : '__iteratio__bus__';
    const channel = new BroadcastChannel(channelName);
    const subscriptionId = `reply-${++this.subIdCounter}`;

    channel.onmessage = (event: { data: any }) => {
      const message: TransportMessage = event.data;

      // Only handle messages for this topic
      if (message.topic !== topic) {
        return;
      }

      // Skip own messages
      if (message.metadata?.messageId && this.ownMessageIds.has(message.metadata.messageId)) {
        return;
      }

      // Only handle messages that are requests (have correlationId and replyTo)
      if (message.metadata?.correlationId && (message.metadata as any).replyTo) {
        Promise.resolve(handler(message.data)).then((response) => {
          const replyChannelName = (message.metadata as any).replyTo;
          const replyChannel = new BroadcastChannel(replyChannelName);
          const replyMessage: TransportMessage = {
            topic: replyChannelName,
            data: response,
            metadata: {
              correlationId: message.metadata!.correlationId,
              timestamp: Date.now(),
              messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            }
          };
          replyChannel.postMessage(replyMessage);
          replyChannel.close();
        });
      }
    };

    this.subscriptionChannels.set(subscriptionId, { channel, topic, handler: () => {} });
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
      backend: 'broadcast-channel',
      url: typeof window !== 'undefined' ? window.location.origin : undefined,
      subscriptions: this.subscriptionChannels.size,
      messagesPublished: this.stats.messagesPublished,
      messagesReceived: this.stats.messagesReceived,
      errors: this.stats.errors
    };
  }
}
