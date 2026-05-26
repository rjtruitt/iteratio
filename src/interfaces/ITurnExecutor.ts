import { Message, LLMResponse } from './ILLMProvider.js';

/** Turn execution context. */
export interface TurnContext {
  turnNumber: number;
  messages: Message[];
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  /** Timestamp when this turn started (ms since epoch). */
  startTime?: number;
  /** Timestamp when this turn ended (ms since epoch). */
  endTime?: number;
  /** Tool calls made during this turn with execution durations. */
  toolCalls?: Array<{ name: string; duration: number }>;
  /** Token usage for this turn. */
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /** Error that occurred during this turn. */
  error?: Error;
  /** Number of concurrent tasks active during this turn. */
  activeTasks?: number;
}

/** Result of a turn execution. */
export interface TurnResult {
  response: LLMResponse;
  toolResults?: ToolExecutionResult[];
  updatedMessages: Message[];
  shouldContinue: boolean;
}

/** Tool execution result within a turn. */
export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  error?: string;
}

/** Turn executor interface for executing a single turn of the agent loop. */
export interface ITurnExecutor {
  /** Execute one turn: call LLM, handle tool calls, return updated state. */
  executeTurn(context: TurnContext): Promise<TurnResult>;

  /** Check if turn should continue (for multi-turn tool calling). */
  shouldContinue(result: TurnResult): boolean;
}
