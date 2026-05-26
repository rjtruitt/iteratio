import type { AgentRole, LLMProvider } from './AgentRegistry.js';

/** Discriminated union of all supported message types on the bus. */
export type MessageType =
  | 'message'           // Simple message
  | 'request'           // RPC request
  | 'response'          // RPC response
  | 'broadcast'         // Broadcast message
  | 'notification'      // System notification
  | 'task'              // Task assignment
  | 'result'            // Task result
  | 'error'             // Error message
  | 'heartbeat';        // Heartbeat ping

/** Envelope wrapping all messages passed through the bus. */
export interface AgentMessage {
  // Routing
  from: string;         // Sender agent ID
  to: string;           // Recipient agent ID (or channel)
  type: MessageType;

  // Content
  content: any;
  metadata?: Record<string, any>;

  // Tracking
  messageId: string;
  timestamp: number;
  correlationId?: string;  // For request/response pairing

  // Delivery
  replyTo?: string;     // For request/response
  timeout?: number;     // Request timeout
}

/** Filter criteria for targeted broadcasts based on agent attributes. */
export interface BroadcastFilter {
  role?: AgentRole;
  capability?: string;
  llmProvider?: LLMProvider;
  machineId?: string;
  metadata?: Record<string, any>;
}

/** Configuration for connecting the message bus to a backend transport. */
export interface MessageBusConfig {
  backend: 'nats' | 'redis' | 'rabbitmq' | 'kafka';
  backendUrl: string;
  clientId?: string;    // Unique client identifier
  defaultTimeout?: number;  // Default request timeout (30s)
  reconnectDelay?: number;  // Reconnect delay on connection loss
  maxReconnectAttempts?: number;
}

/** Abstraction for pluggable message transport backends. */
export interface ITransport {
  /** Publishes a message to the given topic. */
  publish(topic: string, message: any): Promise<void>;
  /** Subscribes a handler to receive messages on the given topic. */
  subscribe(topic: string, handler: (message: any) => void): Promise<void>;
  /** Unsubscribes all handlers for the given topic. */
  unsubscribe(topic: string): Promise<void>;
  /** Sends a request and awaits a response within the timeout. */
  request(topic: string, message: any, timeout: number): Promise<any>;
  /** Closes the transport and releases resources. */
  close(): Promise<void>;
}
