import { IPlugin } from './IPlugin.js';
import { IMessageManager } from './IMessageManager.js';
import { ITool } from './IToolExecutor.js';

/** Core agent loop interface for turn execution and lifecycle management. */
export interface IAgentLoop {
  /** Execute one turn with multi-turn tool loop internally. */
  runTurn(input: string, maxIterations?: number): Promise<string>;

  /** Run the loop until completion or maxTurns. */
  run(options?: RunOptions): Promise<void>;

  /** Add a plugin to the loop. */
  addPlugin(plugin: IPlugin): void;

  /** Register a tool dynamically after construction. */
  registerTool(tool: ITool): void;

  /** Register multiple tools dynamically. */
  registerTools(tools: ITool[]): void;

  /** Remove a tool by name. Returns true if it existed. */
  deregisterTool(name: string): boolean;

  /** Get current loop state. */
  getState(): LoopState;

  /** Get all registered tools. */
  getTools(): ITool[];

  /** Get a tool by name. */
  getTool(name: string): ITool | undefined;

  /** Get tool definitions formatted for LLM. */
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: any }>;

  /** Access the message manager for context window, rewind, and compression. */
  getMessageManager(): IMessageManager;

  /** Shutdown the loop and all plugins. */
  shutdown(): Promise<void>;
}

/** Options for starting a continuous agent loop run. */
export interface RunOptions {
  maxTurns?: number;
  timeout?: number;
  initialMessages?: any[];
}

/** Snapshot of current loop execution status and metadata. */
export interface LoopState {
  turnNumber: number;
  isRunning: boolean;
  metadata: Record<string, unknown>;
}
