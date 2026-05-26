import type { Message } from '../interfaces/ILLMProvider.js';
import type { CompressionStrategy } from '../interfaces/IMessageManager.js';

/** Before/after metrics from a compaction operation. */
export interface CompactionResult {
  before: { messages: number; tokens: number };
  after: { messages: number; tokens: number };
  strategy: CompressionStrategy | 'progressive';
  summary?: string;
}

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

/** Immutable snapshot of conversation state for rewind. */
export interface RewindSnapshot {
  id: number;
  timestamp: number;
  messages: Message[];
  tokenCount: number;
  summary?: string;
}
