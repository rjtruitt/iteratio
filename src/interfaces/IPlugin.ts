import { Container } from 'inversify';

/** Plugin configuration. */
export interface PluginConfig {
  [key: string]: unknown;
}

/** Turn context passed to plugin hooks. */
export interface TurnContext {
  turnNumber: number;
  messages: any[];
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

/** Core plugin interface that all iteratio plugins must implement. */
export interface IPlugin {
  readonly name: string;
  readonly version: string;

  /** Initialize plugin and register services with DI container. */
  initialize(container: Container): Promise<void>;

  /** Optional configuration method. */
  configure?(config: PluginConfig): void;

  /** Called before each turn. */
  beforeTurn?(context: TurnContext): Promise<void>;

  /** Called after each turn. */
  afterTurn?(context: TurnContext): Promise<void>;

  /** Cleanup on shutdown. */
  shutdown?(): Promise<void>;
}
