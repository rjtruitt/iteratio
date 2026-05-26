/** Event bus interface for inter-component communication. */
export interface IEventBus {
  /** Subscribe to an event. */
  on<T = unknown>(event: string, handler: EventHandler<T>): void;

  /** Subscribe once (auto-unsubscribe after first call). */
  once<T = unknown>(event: string, handler: EventHandler<T>): void;

  /** Unsubscribe from an event. */
  off<T = unknown>(event: string, handler: EventHandler<T>): void;

  /** Emit an event to all subscribers. */
  emit<T = unknown>(event: string, data: T): void;

  /** Clear all listeners. */
  clear(): void;
}

/** Event handler function type. Can be synchronous or asynchronous. */
export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

/** Standard events emitted by iteratio core. */
export enum CoreEvents {
  /** Emitted when a turn begins. */
  TURN_START = 'turn:start',
  /** Emitted when a turn completes successfully. */
  TURN_END = 'turn:end',
  /** Emitted when a turn encounters an error. */
  TURN_ERROR = 'turn:error',

  /** Emitted when a tool call begins. */
  TOOL_CALL_START = 'tool:call:start',
  /** Emitted when a tool call completes. */
  TOOL_CALL_END = 'tool:call:end',
  /** Emitted when a tool call fails. */
  TOOL_CALL_ERROR = 'tool:call:error',

  /** Emitted when a message is added to the conversation. */
  MESSAGE_ADDED = 'message:added',
  /** Emitted when the message history is compressed. */
  MESSAGE_COMPRESSED = 'message:compressed',

  /** Emitted when the agent state is modified. */
  STATE_CHANGED = 'state:changed',
  /** Emitted when the agent state is persisted. */
  STATE_PERSISTED = 'state:persisted',

  /** Emitted with token usage metrics per iteration. */
  ITERATION_USAGE = 'iteration:usage',

  /** Emitted when the agent loop starts. */
  LOOP_START = 'loop:start',
  /** Emitted when the agent loop ends. */
  LOOP_END = 'loop:end',
  /** Emitted when the agent loop encounters an error. */
  LOOP_ERROR = 'loop:error',

  /** Emitted when a pipeline step starts execution. */
  STEP_START = 'step:start',
  /** Emitted when a pipeline step completes. */
  STEP_END = 'step:end',
  /** Emitted when a pipeline step fails. */
  STEP_ERROR = 'step:error'
}
