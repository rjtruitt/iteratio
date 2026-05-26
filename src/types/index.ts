/** Message in conversation. */
export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | ContentBlock[];
    name?: string;
    tool_call_id?: string;
}

/** Multi-modal content block within a message. */
export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** Tool invocation requested by the LLM. */
export interface ToolCall {
    id: string;
    name: string;
    arguments: unknown;
}

/** Result of executing a tool. */
export interface ToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
}

/** Structured response from an LLM invocation. */
export interface LLMResponse {
    content: string;
    toolCalls?: ToolCall[];
    stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
}

/** A single turn in the agent loop execution. */
export interface Turn {
    number: number;
    startTime: number;
    endTime?: number;
    messages: Message[];
    response?: LLMResponse;
    toolCalls?: ToolCall[];
    toolResults?: Map<string, ToolResult>;
    tokensUsed: number;
    error?: Error;
}

/** Final result after the agent loop completes or is interrupted. */
export interface LoopResult {
    status: 'completed' | 'max_turns_exceeded' | 'max_tokens_exceeded' | 'cancelled' | 'error';
    turns: Turn[];
    messages: Message[];
    finalMessage?: string;
    totalTokens: number;
    totalDuration: number;
    error?: Error;
}

/** Arbitrary key-value state maintained across turns. */
export type LoopState = Record<string, unknown>;

/** Configuration for driving the agent loop externally (without AgentLoopBuilder). */
export interface LoopConfig {
    sendRequest: (messages: Message[], state: LoopState) => Promise<LLMResponse>;
    executeTool: (name: string, args: unknown, state: LoopState) => Promise<ToolResult>;
    maxTurns?: number;
    maxTokens?: number;
    turnTimeout?: number;
    onTurnStart?: (turn: Turn, state: LoopState) => Promise<void>;
    onTurnComplete?: (turn: Turn, state: LoopState) => Promise<void>;
    onToolCall?: (call: ToolCall, state: LoopState) => Promise<void>;
    onToolResult?: (call: ToolCall, result: ToolResult, state: LoopState) => Promise<void>;
    onError?: (error: Error, context: 'request' | 'tool' | 'hook', state: LoopState) => Promise<boolean>;
}

/** Options for starting a loop run. */
export interface RunOptions {
    messages: Message[];
    state?: LoopState;
    maxTurns?: number;
    maxTokens?: number;
}
