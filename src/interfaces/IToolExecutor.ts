import { ToolCall } from './ILLMProvider.js';
import { z } from 'zod';

/** Tool interface for LLM-callable tools. */
export interface ITool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<any>;

  /** Execute the tool with parsed arguments. */
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;

  /** Validate args before execution. */
  validate?(args: unknown): ValidationResult;
}

/** Context passed to tool execution. */
export interface ToolContext {
  turnNumber: number;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** Tool execution result. */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

/** Validation result from tool argument checking. */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
  }>;
}

/** Tool executor interface for registration and execution. */
export interface IToolExecutor {
  /** Register a single tool. */
  registerTool(tool: ITool): void;
  /** Register multiple tools at once. */
  registerTools(tools: ITool[]): void;
  /** Deregister a tool by name. Returns true if the tool was found and removed. */
  deregisterTool(name: string): boolean;
  /** Execute a single tool call with the given context. */
  executeTool(toolCall: ToolCall, context: ToolContext): Promise<ToolResult>;
  /** Execute multiple tool calls in parallel or sequential mode. */
  executeTools(
    toolCalls: ToolCall[],
    context: ToolContext,
    mode: 'parallel' | 'sequential'
  ): Promise<ToolResult[]>;
  /** Get a registered tool by name, or undefined if not found. */
  getTool(name: string): ITool | undefined;
  /** Get all registered tools. */
  getTools(): ITool[];
  /** Get tool definitions formatted for LLM provider consumption. */
  getToolDefinitions(): ToolDefinition[];
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
