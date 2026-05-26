/** Lifecycle hooks for observing and reacting to agent loop events. */
export interface ILifecycleHooks {
  /** Called at the start of each turn. */
  onTurnStart?: (context: LifecycleTurnContext) => void | Promise<void>;
  /** Called after a turn completes successfully. */
  onTurnComplete?: (context: LifecycleTurnContext) => void | Promise<void>;
  /** Called when the agent invokes a tool. */
  onToolCall?: (tool: LifecycleToolCall, context: LifecycleTurnContext) => void | Promise<void>;
  /** Called after a tool execution finishes. */
  onToolResult?: (tool: LifecycleToolCall, result: LifecycleToolResult, context: LifecycleTurnContext) => void | Promise<void>;
  /** Called with token usage metrics after each LLM invocation. */
  onTokenUsage?: (usage: TokenUsage, context: LifecycleTurnContext) => void | Promise<void>;
  /** Called when the loop status changes (e.g. running, paused, completed). */
  onStatusChange?: (status: LoopStatus, context: LifecycleTurnContext) => void | Promise<void>;
  /** Called when an error occurs during execution. */
  onError?: (error: Error, context: LifecycleTurnContext) => void | Promise<void>;
  /** Called when the loop is paused. */
  onPause?: (context: LifecycleTurnContext) => void | Promise<void>;
  /** Called when the loop resumes from a paused state. */
  onResume?: (context: LifecycleTurnContext) => void | Promise<void>;
  /** Called when the loop is cancelled. */
  onCancel?: (context: LifecycleTurnContext) => void | Promise<void>;
}

/** Turn context for lifecycle hook callbacks. */
export interface LifecycleTurnContext {
  turnNumber: number;
  messages: unknown[];
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** Tool call descriptor passed to lifecycle hooks. */
export interface LifecycleToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** Tool execution result passed to lifecycle hooks. */
export interface LifecycleToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Token usage reported to lifecycle hooks. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Current status of the agent loop for lifecycle tracking. */
export type LoopStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
