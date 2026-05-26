import { EventEmitter } from 'events';
import type {
  AgentMessage,
  BroadcastFilter,
  MessageBusConfig,
} from './AgentMessageBusTypes.js';
import { InMemoryTransport, getOrCreateSharedTransport } from './InMemoryTransport.js';

export type { MessageType, AgentMessage, BroadcastFilter, MessageBusConfig, ITransport } from './AgentMessageBusTypes.js';

let messageIdCounter = 0;

/**
 * Distributed message bus for agent communication with pub/sub, RPC, broadcast,
 * channel, lifecycle events, and buffered delivery.
 */
export class AgentMessageBus extends EventEmitter {
  private transport: InMemoryTransport;
  private config: Required<MessageBusConfig>;
  private subscriptions: Map<string, Set<(msg: AgentMessage) => void>> = new Map();
  private broadcastSubscriptions: Map<string, Set<(msg: AgentMessage) => void>> = new Map();
  private channelSubscriptions: Map<string, Set<(msg: AgentMessage) => void>> = new Map();
  private lifecycleHandlers: Set<(event: any) => void> = new Set();
  private pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: any;
  }> = new Map();
  private messageBuffer: Map<string, AgentMessage[]> = new Map();
  private messageTTL = 300000; // 5 minute default message TTL
  private isShutdown = false;
  private messagesSentCount = 0;
  private messagesReceivedCount = 0;

  constructor(config: MessageBusConfig) {
    super();

    this.config = {
      ...config,
      clientId: config.clientId || `client_${++messageIdCounter}`,
      defaultTimeout: config.defaultTimeout || 30000,
      reconnectDelay: config.reconnectDelay || 5000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
    };

    this.transport = getOrCreateSharedTransport(config.backendUrl);
  }

  /**
   * Sends a message to a specific agent by ID.
   * If the target has no active subscriptions, the message is buffered for later delivery.
   */
  async sendTo(targetAgentId: string, message: any): Promise<void> {
    if (this.isShutdown) {
      throw new Error('Message bus is shut down');
    }

    try {
      JSON.stringify(message);
    } catch {
      throw new Error('Message content is not JSON-serializable (circular reference or similar)');
    }

    const envelope: AgentMessage = {
      from: this.config.clientId,
      to: targetAgentId,
      type: 'message',
      content: message,
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    try {
      await this.transport.publish(`agent.${targetAgentId}`, envelope);
    } catch {
    }

    const handlers = this.subscriptions.get(targetAgentId);
    let delivered = false;
    if (handlers && handlers.size > 0) {
      for (const handler of handlers) {
        try {
          handler(envelope);
        } catch {
        }
      }
      delivered = true;
    }

    if (!delivered) {
      if (!this.messageBuffer.has(targetAgentId)) {
        this.messageBuffer.set(targetAgentId, []);
      }
      this.messageBuffer.get(targetAgentId)!.push(envelope);
    }

    this.messagesSentCount++;
    this.emit('message:sent', envelope);
  }

  /**
   * Sends a message to multiple target agents in parallel.
   * Results are collected; individual failures do not block others.
   */
  async sendToMany(targetAgentIds: string[], message: any): Promise<Array<void | Error>> {
    const results = await Promise.allSettled(
      targetAgentIds.map(id => this.sendTo(id, message))
    );

    return results.map(r =>
      r.status === 'fulfilled' ? r.value : (r as PromiseRejectedResult).reason
    );
  }

  /**
   * Sends an RPC-style request to a target agent and waits for a response.
   * Throws a timeout error if no response is received within the specified period.
   */
  async request(targetAgentId: string, requestPayload: any, timeout?: number): Promise<any> {
    if (this.isShutdown) {
      throw new Error('Message bus is shut down');
    }

    const correlationId = this.generateMessageId();
    const actualTimeout = timeout ?? this.config.defaultTimeout;

    const envelope: AgentMessage = {
      from: this.config.clientId,
      to: targetAgentId,
      type: 'request',
      content: requestPayload,
      messageId: this.generateMessageId(),
      correlationId,
      replyTo: `agent.${this.config.clientId}.response`,
      timestamp: Date.now(),
      timeout: actualTimeout,
    };

    return new Promise<any>((resolve, reject) => {
      if (actualTimeout <= 0) {
        reject(new Error(`Request to ${targetAgentId} timed out after ${actualTimeout}ms`));
        return;
      }

      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request to ${targetAgentId} timed out after ${actualTimeout}ms`));
      }, actualTimeout);

      this.pendingRequests.set(correlationId, { resolve, reject, timeout: timer });

      const handlers = this.subscriptions.get(targetAgentId);
      if (handlers) {
        for (const handler of handlers) {
          handler(envelope);
        }
      }

      this.messagesSentCount++;
    });
  }

  /**
   * Sends a response back to the sender of an original RPC request.
   * Resolves the pending request promise associated with the correlation ID.
   */
  async respond(originalRequest: AgentMessage, response: any): Promise<void> {
    if (!originalRequest.correlationId) {
      throw new Error('Cannot respond: request missing correlationId');
    }

    const pending = this.pendingRequests.get(originalRequest.correlationId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(response);
      this.pendingRequests.delete(originalRequest.correlationId);
    }
  }

  /**
   * Subscribes to messages addressed to a specific agent ID.
   * Delivers any buffered messages that arrived before the subscription.
   */
  async subscribe(agentId: string, handler: (msg: AgentMessage) => void | Promise<void>): Promise<void> {
    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, new Set());
    }
    this.subscriptions.get(agentId)!.add(handler);

    await this.transport.subscribe(`agent.${agentId}`, (envelope: AgentMessage) => {
      if (envelope.from !== this.config.clientId) {
        try {
          handler(envelope);
        } catch {
        }
      }
    });

    const buffered = this.messageBuffer.get(agentId);
    if (buffered && buffered.length > 0) {
      const now = Date.now();
      const valid = buffered.filter(msg => {
        const ttl = msg.content?.metadata?.ttl || this.messageTTL;
        return now - msg.timestamp < ttl;
      });
      for (const msg of valid) {
        try {
          handler(msg);
        } catch {
        }
      }
      this.messageBuffer.delete(agentId);
    }
  }

  /** Unsubscribes all handlers for a given agent ID. */
  async unsubscribe(agentId: string): Promise<void> {
    this.subscriptions.delete(agentId);
  }

  /**
   * Broadcasts a message to all agents matching the given filter.
   * The filter can be a plain string (topic shorthand) or a BroadcastFilter object.
   */
  async broadcast(filter: BroadcastFilter | string, message: any): Promise<void> {
    if (this.isShutdown) {
      throw new Error('Message bus is shut down');
    }

    const topic = this.buildBroadcastTopic(filter);

    const envelope: AgentMessage = {
      from: this.config.clientId,
      to: topic,
      type: 'broadcast',
      content: message,
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    const handlers = this.broadcastSubscriptions.get(topic);
    if (handlers) {
      for (const handler of handlers) {
        handler(envelope);
      }
    }

    this.messagesSentCount++;
    this.emit('broadcast:sent', envelope);
  }

  /**
   * Subscribes to broadcast messages matching the given filter.
   * Only messages matching the filter criteria will be delivered to the handler.
   */
  async subscribeToBroadcasts(
    _agentId: string,
    filter: BroadcastFilter | string,
    handler: (msg: AgentMessage) => void
  ): Promise<void> {
    const topic = this.buildBroadcastTopic(filter);

    if (!this.broadcastSubscriptions.has(topic)) {
      this.broadcastSubscriptions.set(topic, new Set());
    }
    this.broadcastSubscriptions.get(topic)!.add(handler);
  }

  private buildBroadcastTopic(filter: BroadcastFilter | string): string {
    if (typeof filter === 'string') {
      return `broadcast.${filter}`;
    }
    const parts = ['broadcast'];
    if (filter.role) parts.push('role', filter.role);
    if (filter.capability) parts.push('capability', filter.capability);
    if (filter.llmProvider) parts.push('llm', filter.llmProvider);
    if (filter.machineId) parts.push('machine', filter.machineId);
    return parts.join('.');
  }

  /** Joins a named channel, enabling channel-scoped messaging. */
  async joinChannel(channel: string): Promise<void> {
    if (!this.channelSubscriptions.has(channel)) {
      this.channelSubscriptions.set(channel, new Set());
    }
    this.emit('channel:joined', channel);
  }

  /** Leaves a named channel, removing all associated handlers. */
  async leaveChannel(channel: string): Promise<void> {
    this.channelSubscriptions.delete(channel);
    this.subscriptions.delete(channel);
    this.emit('channel:left', channel);
  }

  /** Publishes a message to all subscribers of the given channel. */
  async publishToChannel(channel: string, message: any): Promise<void> {
    if (this.isShutdown) {
      throw new Error('Message bus is shut down');
    }

    const envelope: AgentMessage = {
      from: this.config.clientId,
      to: `channel.${channel}`,
      type: 'message',
      content: message,
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    const handlers = this.subscriptions.get(channel);
    if (handlers) {
      for (const handler of handlers) {
        handler(envelope);
      }
    }

    this.messagesSentCount++;
    this.emit('channel:published', { channel, message: envelope });
  }

  /** Announces a lifecycle event (e.g. agent started, leader elected) to all watchers. */
  async announceLifecycle(event: any, data?: any): Promise<void> {
    const lifecycleEvent = typeof event === 'string' ? { type: event, ...data } : event;

    for (const handler of this.lifecycleHandlers) {
      handler(lifecycleEvent);
    }
  }

  /** Registers a handler that receives all lifecycle events. */
  async watchLifecycle(handler: (event: any) => void): Promise<void> {
    this.lifecycleHandlers.add(handler);
  }

  /** Returns current bus statistics (subscription count, pending requests, message counts). */
  async getStats(): Promise<{
    subscriptions: number;
    pendingRequests: number;
    messagesSent: number;
    messagesReceived: number;
  }> {
    return {
      subscriptions: this.subscriptions.size,
      pendingRequests: this.pendingRequests.size,
      messagesSent: this.messagesSentCount,
      messagesReceived: this.messagesReceivedCount,
    };
  }

  /** Initializes the bus to an active state. */
  async initialize(): Promise<void> {
    this.isShutdown = false;
    this.emit('connected');
  }

  /**
   * Shuts down the bus, rejecting pending requests, clearing subscriptions,
   * and emitting a shutdown event.
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Message bus shutting down'));
    }
    this.pendingRequests.clear();

    this.subscriptions.clear();
    this.broadcastSubscriptions.clear();
    this.channelSubscriptions.clear();
    this.lifecycleHandlers.clear();

    this.emit('shutdown');
  }

  private generateMessageId(): string {
    return `msg_${++messageIdCounter}_${Date.now()}`;
  }
}
