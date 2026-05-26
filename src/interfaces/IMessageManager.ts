import { Message, ILLMProvider } from './ILLMProvider.js';

/** Manages conversation messages with context window tracking, compression, and rewind. */
export interface IMessageManager {
  /** Add a message to the conversation history. */
  addMessage(message: Message): void;
  /** Get all messages, optionally filtered by role, index, or count. */
  getMessages(): Message[];
  getMessages(options: GetMessagesOptions): Message[];
  /** Clear all messages and reset state. */
  clear(): void;
  /** Get the total number of messages in the conversation. */
  count(): number;

  /** Get the estimated token count for the current conversation. */
  getTokenCount(): number;
  /** Set the token threshold for triggering automatic compaction. */
  setTokenThreshold(threshold: number): void;
  /** Set the maximum context tokens the LLM can handle. */
  setMaxContextTokens(max: number): void;
  /** Check if the conversation should be compacted based on the threshold. */
  shouldCompact(): boolean;
  /** Check if the conversation is approaching capacity. */
  isNearCapacity(): boolean;
  /** Check if the conversation is over the context limit. */
  isOverContextLimit(): boolean;
  /** Get a snapshot of current context window utilization. */
  getContextUsage(): ContextUsage;

  /** Apply a specific compression strategy to reduce context size. */
  compress(strategy: CompressionStrategy, limit: number): Promise<void>;
  /** Automatically compact if the threshold is exceeded. */
  autoCompact(): Promise<CompactionResult | null>;
  /** Force compaction regardless of current token usage. */
  forceCompact(): Promise<CompactionResult>;
  /** Get the history of all compaction operations performed. */
  getCompactionHistory(): CompactionResult[];
  /** Get the running summary text accumulated from compactions. */
  getRunningSummary(): string;

  /** Configure context window parameters. */
  configure(config: ContextWindowConfig): void;
  /** Set the LLM provider used for summarization during compaction. */
  setLLMProvider(provider: ILLMProvider): void;

  /** Take a snapshot of current conversation state for later rewind. */
  takeSnapshot(): RewindSnapshot;
  /** Rewind conversation to a specific snapshot by ID. Returns false if not found. */
  rewind(snapshotId: number): boolean;
  /** Rewind conversation to the state at a specific turn number. */
  rewindToTurn(turn: number): boolean;
  /** Get all available rewind snapshots. */
  getSnapshots(): RewindSnapshot[];
  /** Get the total number of stored snapshots. */
  getSnapshotCount(): number;
  /** Set the maximum number of snapshots to retain. */
  setMaxSnapshots(max: number): void;

  /** Export the full state for persistence or transfer. */
  exportState(): MessageManagerState;
  /** Import a previously exported state, merging with current state. */
  importState(state: Partial<MessageManagerState>): void;
}

/** Filtering options for getMessages(). */
export interface GetMessagesOptions {
  role?: Message['role'];
  since?: number;
  limit?: number;
}

/** Strategy for reducing context window size. */
export type CompressionStrategy =
  | 'truncate'
  | 'sliding-window'
  | 'summarize';

/** Current context window utilization snapshot. */
export interface ContextUsage {
  current: number;
  max: number;
  percent: number;
  headroom: number;
}

/** Configuration for context window size and compaction behavior. */
export interface ContextWindowConfig {
  maxTokens?: number;
  compactThreshold?: number;
  recentMessagesToKeep?: number;
  summaryTargetRatio?: number;
  antiThrashAttempts?: number;
}

/** Before/after metrics from a compaction operation. */
export interface CompactionResult {
  before: { messages: number; tokens: number };
  after: { messages: number; tokens: number };
  strategy: CompressionStrategy | 'progressive';
  summary?: string;
}

/** Immutable snapshot of conversation state for rewind. */
export interface RewindSnapshot {
  id: number;
  timestamp: number;
  messages: Message[];
  tokenCount: number;
  summary?: string;
}

/** Serialized message manager state for persistence or transfer. */
export interface MessageManagerState {
  messages: Message[];
  runningSummary: string;
  snapshots: RewindSnapshot[];
  config: ContextWindowConfig;
  compactionHistory: CompactionResult[];
}
