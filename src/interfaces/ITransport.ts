/** Transport abstraction for distributed agent communication. */
export interface ITransport {
  /** Connect to the transport backend with the given configuration. */
  connect(config: TransportConfig): Promise<void>;
  /** Disconnect from the transport backend gracefully. */
  disconnect(): Promise<void>;
  /** Publish a message to a topic. */
  publish(topic: string, message: any): Promise<void>;
  /** Subscribe to a topic and receive messages via handler. Returns a subscription ID. */
  subscribe(topic: string, handler: MessageHandler): Promise<string>;
  /** Unsubscribe from a topic using the subscription ID. */
  unsubscribe(subscriptionId: string): Promise<void>;
  /** Send a request and wait for a reply (request-reply pattern). */
  request(topic: string, message: any, timeout?: number): Promise<any>;
  /** Register a handler that responds to requests on a topic. */
  reply(topic: string, handler: ReplyHandler): Promise<void>;
  /** Check if the transport is currently connected. */
  isConnected(): boolean;
  /** Get current transport connection status and metrics. */
  getStatus(): TransportStatus;
}

/** Transport configuration. */
export interface TransportConfig {
  backend: 'nats' | 'redis-pubsub' | 'broadcast-channel' | 'memory';
  url?: string;
  auth?: {
    type: 'apikey' | 'jwt' | 'basic' | 'nkey' | 'token';
    credentials?: Record<string, string>;
  };
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  timeout?: number;
  topicPrefix?: string;
}

/** Handler function for incoming transport messages. */
export type MessageHandler = (message: TransportMessage) => void | Promise<void>;
/** Handler function for request-reply patterns. Returns a response. */
export type ReplyHandler = (request: any) => any | Promise<any>;

/** Transport message envelope. */
export interface TransportMessage {
  topic: string;
  data: any;
  metadata?: {
    from?: string;
    timestamp?: number;
    messageId?: string;
    correlationId?: string;
  };
}

/** Transport connection status. */
export interface TransportStatus {
  connected: boolean;
  backend: string;
  url?: string;
  subscriptions: number;
  messagesPublished: number;
  messagesReceived: number;
  errors: number;
}
