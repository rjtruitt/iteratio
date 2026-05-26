/** Message structure for LLM communication. */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Reasoning/thinking content from models that support it (DeepSeek, o1/o3). Must be echoed back. */
  reasoning?: string;
}

/** Tool call from LLM response. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** LLM response structure. */
export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  reasoning?: string;
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  model?: string;
  metadata?: Record<string, unknown>;
}

/** Streaming chunk from LLM. */
export interface LLMStreamChunk {
  type: 'text' | 'thinking' | 'tool_call' | 'usage' | 'done';
  text?: string;
  toolCall?: { id: string; name: string; arguments: string };
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

/** LLM provider interface for sending messages and receiving responses. */
export interface ILLMProvider {
  /** Send messages to LLM and get response. */
  invoke(messages: Message[], options?: LLMOptions): Promise<LLMResponse>;

  /** Stream messages to LLM and get chunks as they arrive. */
  invokeStream?(messages: Message[], options?: LLMOptions): AsyncGenerator<LLMStreamChunk>;

  /** Get provider information. */
  getInfo?(): {
    provider: string;
    model: string;
    capabilities: string[];
  };

  /** Graceful shutdown. */
  shutdown?(): Promise<void>;
}

/** Optional parameters for LLM invocation. */
export interface LLMOptions {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'required' | { name: string };
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

/** Tool definition for LLM (Anthropic/OpenAI format). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
