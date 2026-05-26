import { injectable, inject } from 'inversify';
import type { ZodTypeAny } from 'zod';
import { IToolExecutor, ITool, ToolContext, ToolResult, ToolDefinition } from '../interfaces/IToolExecutor.js';
import { ToolCall } from '../interfaces/ILLMProvider.js';
import { ILogger } from '../interfaces/ILogger.js';
import { TOKENS } from '../types/Tokens.js';

/** Callback hooks for observing tool call/result lifecycle events. */
export interface ToolCallbacks {
  /** Invoked immediately before a tool is executed. */
  onToolCall?: (toolName: string, args: unknown) => void;
  /** Invoked after a tool completes (success or failure), with duration. */
  onToolResult?: (toolName: string, args: unknown, result: ToolResult, durationMs: number) => void;
}

/** Manages tool registration, validation, and execution with timeout support. */
@injectable()
export class ToolExecutor implements IToolExecutor {
  private tools: Map<string, ITool> = new Map();
  private callbacks?: ToolCallbacks;

  constructor(
    @inject(TOKENS.ILogger) private logger: ILogger
  ) {}

  /** Attach callbacks for tool call/result observation (e.g. logging, metrics). */
  setCallbacks(callbacks: ToolCallbacks): void {
    this.callbacks = callbacks;
  }

  /** Register or replace a tool by name. */
  registerTool(tool: ITool): void {
    const existing = this.tools.has(tool.name);
    this.tools.set(tool.name, tool);
    this.logger.info(existing ? 'Tool updated' : 'Tool registered', { name: tool.name });
  }

  /** Register multiple tools at once. */
  registerTools(tools: ITool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /** Remove a tool by name. Returns true if removed. */
  deregisterTool(name: string): boolean {
    const had = this.tools.has(name);
    if (had) {
      this.tools.delete(name);
      this.logger.info('Tool deregistered', { name });
    }
    return had;
  }

  /** Execute a single tool call with argument parsing, validation, and timeout. */
  async executeTool(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    this.logger.debug('Executing tool', { name: toolCall.name });

    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        success: false,
        error: {
          message: `Tool "${toolCall.name}" not found`,
          code: 'TOOL_NOT_FOUND'
        }
      };
    }

    let args: unknown = {};
    let startTime = Date.now();

    try {
      if (toolCall.arguments === null || toolCall.arguments === undefined) {
        args = {};
      } else if (typeof toolCall.arguments === 'string') {
        args = JSON.parse(toolCall.arguments);
      } else {
        args = toolCall.arguments;
      }

      if (tool.validate) {
        const validation = tool.validate(args);
        if (!validation.valid) {
          return {
            success: false,
            error: {
              message: `Validation failed: ${validation.errors.map((e: any) => e.message).join(', ')}`,
              code: 'VALIDATION_ERROR'
            }
          };
        }
      }

      this.callbacks?.onToolCall?.(toolCall.name, args);
      startTime = Date.now();

      const result = await Promise.race([
        tool.execute(args, context),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Tool execution timeout')), 30000)
        )
      ]);

      const durationMs = Date.now() - startTime;
      this.callbacks?.onToolResult?.(toolCall.name, args, result, durationMs);
      this.logger.debug('Tool executed successfully', { name: toolCall.name });
      return result;
    } catch (error: any) {
      this.logger.error('Tool execution failed', error, { name: toolCall.name });
      const errorResult: ToolResult = {
        success: false,
        error: {
          message: error?.message ?? String(error),
          code: 'EXECUTION_ERROR'
        }
      };
      this.callbacks?.onToolResult?.(toolCall.name, args, errorResult, Date.now() - startTime);
      return errorResult;
    }
  }

  /** Execute multiple tool calls either in parallel or sequentially. */
  async executeTools(
    toolCalls: ToolCall[],
    context: ToolContext,
    mode: 'parallel' | 'sequential'
  ): Promise<ToolResult[]> {
    if (mode === 'parallel') {
      return Promise.all(
        toolCalls.map(tc => this.executeTool(tc, context))
      );
    } else {
      const results: ToolResult[] = [];
      for (const tc of toolCalls) {
        results.push(await this.executeTool(tc, context));
      }
      return results;
    }
  }

  /** Look up a registered tool by name. Returns undefined if not found. */
  getTool(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /** Get all currently registered tool instances. */
  getTools(): ITool[] {
    return Array.from(this.tools.values());
  }

  /** Convert all registered tools to LLM-compatible JSON Schema definitions. */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: this.zodToJsonSchema(tool.schema)
    }));
  }

  private zodToJsonSchema(schema: ZodTypeAny): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
    if (!schema || !schema._def) {
      return { type: 'object', properties: {} };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Zod's _def types vary by typeName and TS can't narrow discriminated unions on _def
    const def = schema._def as any;

    if (def.typeName === 'ZodObject') {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        const prop = this.zodPropertyToJson(value as ZodTypeAny);
        properties[key] = prop;
        if (!(value as any)?.isOptional?.() && (value as any)?._def?.typeName !== 'ZodOptional') {
          required.push(key);
        }
      }

      return { type: 'object', properties, required: required.length > 0 ? required : undefined };
    }

    return { type: 'object', properties: {} };
  }

  private zodPropertyToJson(schema: ZodTypeAny): Record<string, unknown> {
    if (!schema || !schema._def) return { type: 'string' };

    const def = schema._def;
    const description = def.description;
    let result: Record<string, unknown> = {};

    switch (def.typeName) {
      case 'ZodString':
        result = { type: 'string' };
        break;
      case 'ZodNumber':
        result = { type: 'number' };
        break;
      case 'ZodBoolean':
        result = { type: 'boolean' };
        break;
      case 'ZodArray':
        result = { type: 'array', items: this.zodPropertyToJson(def.type) };
        break;
      case 'ZodEnum':
        result = { type: 'string', enum: def.values };
        break;
      case 'ZodOptional':
        return this.zodPropertyToJson(def.innerType);
      case 'ZodObject':
        result = this.zodToJsonSchema(schema);
        break;
      default:
        result = { type: 'string' };
    }

    if (description) result.description = description;
    return result;
  }
}
