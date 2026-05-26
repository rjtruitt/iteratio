import type {
    Message,
    LoopState,
    ToolCall,
    ToolResult,
    LLMResponse
} from '../types/index.js';

/** Configuration for the functional tool executor used by TurnManager. */
interface FunctionalToolExecutorConfig {
    /** Core function that executes a tool by name with given arguments. */
    executeTool: (name: string, args: unknown, state: LoopState) => Promise<ToolResult>;
    /** Optional hook invoked before each tool execution. */
    onToolCall?: (call: ToolCall, state: LoopState) => Promise<void>;
    /** Optional hook invoked after each tool execution with its result. */
    onToolResult?: (call: ToolCall, result: ToolResult, state: LoopState) => Promise<void>;
    /** Optional error handler for tool and request failures. Return true to suppress propagation. */
    onError?: (error: Error, context: 'request' | 'tool' | 'hook', state: LoopState) => Promise<boolean>;
}

/** Internal tool executor that wraps a functional configuration with error handling. */
class FunctionalToolExecutor {
    private config: FunctionalToolExecutorConfig;

    constructor(config: FunctionalToolExecutorConfig) {
        this.config = config;
    }

    /** Execute a batch of tool calls sequentially, collecting results into a Map keyed by call ID. */
    async executeTools(toolCalls: ToolCall[], state: LoopState): Promise<Map<string, ToolResult>> {
        const results = new Map<string, ToolResult>();
        for (const call of toolCalls) {
            try {
                if (this.config.onToolCall) {
                    await this.config.onToolCall(call, state);
                }
                const result = await this.config.executeTool(call.name, call.arguments, state);
                results.set(call.id, result);
                if (this.config.onToolResult) {
                    await this.config.onToolResult(call, result, state);
                }
            } catch (error) {
                const toolResult: ToolResult = {
                    success: false,
                    error: (error as Error).message ?? String(error)
                };
                results.set(call.id, toolResult);
                if (this.config.onError) {
                    await this.config.onError(error as Error, 'tool', state);
                }
            }
        }
        return results;
    }
}

/** Configuration for TurnManager defining LLM request, tool execution, and lifecycle hooks. */
export interface TurnConfig {
    /** Function to send messages to the LLM and receive a response. */
    sendRequest: (messages: Message[], state: LoopState) => Promise<LLMResponse>;
    /** Function to execute a single tool call by name with arguments. */
    executeTool: (name: string, args: unknown, state: LoopState) => Promise<ToolResult>;
    /** Maximum time (ms) allowed for the LLM request before timeout. */
    turnTimeout: number;
    /** Optional hook invoked before each tool call. */
    onToolCall?: (call: ToolCall, state: LoopState) => Promise<void>;
    /** Optional hook invoked after each tool execution with its result. */
    onToolResult?: (call: ToolCall, result: ToolResult, state: LoopState) => Promise<void>;
    /** Optional error handler for request/tool/hook failures. Return true to suppress propagation. */
    onError?: (error: Error, context: 'request' | 'tool' | 'hook', state: LoopState) => Promise<boolean>;
}

/** Result of a single turn execution, including LLM response, tool results, and accumulated messages. */
export interface TurnResult {
    /** The LLM response if the request succeeded. */
    response?: LLMResponse;
    /** Tool calls extracted from the LLM response, if any. */
    toolCalls?: ToolCall[];
    /** Results of each executed tool call, keyed by call ID. */
    toolResults?: Map<string, ToolResult>;
    /** Messages produced during this turn (assistant message + tool result messages). */
    messages: Message[];
    /** Total tokens used by the LLM request. */
    tokensUsed: number;
    /** Error if the turn failed (request timeout, tool failure, etc.). */
    error?: Error;
}

/** Functional turn manager that orchestrates LLM calls and tool execution with timeout. */
export class TurnManager {
    private config: TurnConfig;
    private toolExecutor: FunctionalToolExecutor;

    constructor(config: TurnConfig) {
        this.config = config;
        this.toolExecutor = new FunctionalToolExecutor({
            executeTool: config.executeTool,
            onToolCall: config.onToolCall,
            onToolResult: config.onToolResult,
            onError: config.onError
        });
    }

    /**
     * Execute a single turn: send messages to the LLM, handle tool calls if present,
     * and return the combined result with all response messages.
     *
     * @param messages - The conversation history to send to the LLM.
     * @param state    - The current loop state for tool execution context.
     * @returns A TurnResult containing the LLM response, tool results, and generated messages.
     */
    async executeTurn(messages: Message[], state: LoopState): Promise<TurnResult> {
        const result: TurnResult = {
            messages: [],
            tokensUsed: 0
        };

        try {
            const response = await this.executeWithTimeout(
                () => this.config.sendRequest(messages, state),
                this.config.turnTimeout,
                'Request'
            );

            result.response = response;
            result.tokensUsed = response.usage.totalTokens;

            const assistantMessage: Message = {
                role: 'assistant',
                content: response.content
            };
            result.messages.push(assistantMessage);

            if (response.toolCalls && response.toolCalls.length > 0) {
                result.toolCalls = response.toolCalls;

                const toolResults = await this.toolExecutor.executeTools(response.toolCalls, state);
                result.toolResults = toolResults;

                for (const [callId, toolResult] of toolResults.entries()) {
                    const toolCall = response.toolCalls.find(c => c.id === callId);
                    if (!toolCall) continue;

                    const toolMessage: Message = {
                        role: 'tool',
                        content: toolResult.success
                            ? JSON.stringify(toolResult.data)
                            : `Error: ${toolResult.error}`,
                        name: toolCall.name,
                        tool_call_id: callId
                    };
                    result.messages.push(toolMessage);
                }
            }

            return result;
        } catch (error) {
            result.error = error as Error;

            if (this.config.onError) {
                try {
                    await this.config.onError(error as Error, 'request', state);
                } catch {
                    // Hook errors are non-fatal
                }
            }

            return result;
        }
    }

    /** Execute an async operation with a timeout. Rejects if the operation exceeds the given time limit. */
    private async executeWithTimeout<T>(
        operation: () => Promise<T>,
        timeoutMs: number,
        operationName: string
    ): Promise<T> {
        return Promise.race([
            operation(),
            new Promise<T>((_, reject) =>
                setTimeout(
                    () => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)),
                    timeoutMs
                )
            )
        ]);
    }
}
