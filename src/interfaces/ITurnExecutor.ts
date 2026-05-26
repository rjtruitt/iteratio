import { Message, LLMResponse } from './ILLMProvider.js';

/** Turn execution context. */
export interface TurnContext {
  turnNumber: number;
  messages: Message[];
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
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
