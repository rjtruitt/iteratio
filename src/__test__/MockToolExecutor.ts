import type { ITool, IToolExecutor, ToolCall, ToolContext, ToolResult, ToolDefinition, ValidationResult } from '../interfaces/IToolExecutor.js';

export interface MockToolOptions {
  defaultResult?: ToolResult;
  throwOnTool?: string;
  throwError?: Error;
  delayMs?: number;
}

export class MockToolExecutor implements IToolExecutor {
  private tools = new Map<string, ITool>();
  private _calls: Array<{ toolCall: ToolCall; context: ToolContext }> = [];
  private results = new Map<string, ToolResult>();
  private options: MockToolOptions;

  constructor(options: MockToolOptions = {}) {
    this.options = options;
  }

  get calls() { return this._calls; }
  get callCount() { return this._calls.length; }

  registerTool(tool: ITool): void {
    this.tools.set(tool.name, tool);
  }

  registerTools(tools: ITool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  async executeTool(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    this._calls.push({ toolCall, context });

    if (this.options.throwOnTool === toolCall.name) {
      throw this.options.throwError ?? new Error(`MockToolExecutor: forced error on ${toolCall.name}`);
    }

    if (this.options.delayMs) {
      await new Promise(resolve => setTimeout(resolve, this.options.delayMs));
    }

    const configured = this.results.get(toolCall.name);
    if (configured) return configured;

    return this.options.defaultResult ?? { success: true, data: { mock: true } };
  }

  async executeTools(toolCalls: ToolCall[], context: ToolContext, mode: 'parallel' | 'sequential'): Promise<ToolResult[]> {
    if (mode === 'parallel') {
      return Promise.all(toolCalls.map(tc => this.executeTool(tc, context)));
    }
    const results: ToolResult[] = [];
    for (const tc of toolCalls) {
      results.push(await this.executeTool(tc, context));
    }
    return results;
  }

  getTool(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  getTools(): ITool[] {
    return [...this.tools.values()];
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    }));
  }

  setResult(toolName: string, result: ToolResult): void {
    this.results.set(toolName, result);
  }

  getResults(): Record<string, ToolResult> {
    return Object.fromEntries(this.results);
  }

  reset(): void {
    this._calls = [];
    this.results.clear();
  }

  wasCalledWith(toolName: string): boolean {
    return this._calls.some(c => c.toolCall.name === toolName);
  }

  callsForTool(toolName: string): Array<{ toolCall: ToolCall; context: ToolContext }> {
    return this._calls.filter(c => c.toolCall.name === toolName);
  }
}

export function createMockTool(name: string, overrides?: Partial<ITool>): ITool {
  return {
    name,
    description: `Mock tool: ${name}`,
    schema: { parse: (x: unknown) => x } as any,
    execute: async () => ({ success: true, data: { tool: name } }),
    ...overrides,
  };
}
