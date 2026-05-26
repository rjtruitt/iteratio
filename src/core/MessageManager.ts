import { injectable } from 'inversify';
import { IMessageManager, GetMessagesOptions, CompressionStrategy } from '../interfaces/IMessageManager.js';
import { Message, ILLMProvider } from '../interfaces/ILLMProvider.js';
import type { CompactionResult, ContextUsage, ContextWindowConfig, RewindSnapshot } from './MessageManagerTypes.js';

export type { CompactionResult, ContextUsage, ContextWindowConfig, RewindSnapshot } from './MessageManagerTypes.js';

const ROLE_OVERHEAD_TOKENS = 4;
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
const DEFAULT_COMPACT_THRESHOLD = 0.75;
const ANTI_THRASH_MAX_ATTEMPTS = 3;

/** Manages conversation messages with context window tracking, compression, and rewind. */
@injectable()
export class MessageManager implements IMessageManager {
  private messages: Message[] = [];
  private _maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS;
  private _compactThreshold: number = DEFAULT_COMPACT_THRESHOLD;
  private _tokenThreshold: number = Infinity;
  private _recentToKeep: number = 12;
  private _summaryTargetRatio: number = 0.15;
  private _antiThrashMax: number = ANTI_THRASH_MAX_ATTEMPTS;
  private _llmProvider: ILLMProvider | null = null;
  private _compactionHistory: CompactionResult[] = [];
  private _snapshots: RewindSnapshot[] = [];
  private _snapshotCounter: number = 0;
  private _maxSnapshots: number = 50;
  private _runningSummary: string = '';

  /** Apply context window configuration (token limits, compaction thresholds). */
  configure(config: ContextWindowConfig): void {
    if (config.maxTokens !== undefined) this._maxContextTokens = config.maxTokens;
    if (config.compactThreshold !== undefined) this._compactThreshold = config.compactThreshold;
    if (config.recentMessagesToKeep !== undefined) this._recentToKeep = config.recentMessagesToKeep;
    if (config.summaryTargetRatio !== undefined) this._summaryTargetRatio = config.summaryTargetRatio;
    if (config.antiThrashAttempts !== undefined) this._antiThrashMax = config.antiThrashAttempts;
  }

  /** Set the LLM provider used for summarization-based compaction. */
  setLLMProvider(provider: ILLMProvider): void {
    this._llmProvider = provider;
  }

  /** Append a message to the conversation history. */
  addMessage(message: Message): void {
    this.messages.push(message);
  }

  /** Retrieve messages, optionally filtered by role or limited to most recent N. */
  getMessages(options?: GetMessagesOptions): Message[] {
    if (!options) {
      return [...this.messages];
    }

    let result = [...this.messages];

    if (options.role) {
      result = result.filter(m => m.role === options.role);
    }

    if (options.limit && options.limit > 0) {
      result = result.slice(-options.limit);
    }

    return result;
  }

  /** Clear all messages and reset the running summary. */
  clear(): void {
    this.messages = [];
    this._runningSummary = '';
  }

  /** Number of messages in the conversation. */
  count(): number {
    return this.messages.length;
  }

  /** Estimated total token count across all messages. */
  getTokenCount(): number {
    return this.messages.reduce((sum, m) => sum + this._estimateMessageTokens(m), 0);
  }

  /**
   * Set the absolute token threshold that triggers compaction.
   * When the estimated token count exceeds this value, shouldCompact() returns true.
   */
  setTokenThreshold(threshold: number): void {
    this._tokenThreshold = threshold;
  }

  /**
   * Set the maximum context window size in tokens.
   * When token usage exceeds this limit, isOverContextLimit() returns true.
   */
  setMaxContextTokens(max: number): void {
    this._maxContextTokens = max;
  }

  /** True when token usage exceeds the compaction threshold. */
  shouldCompact(): boolean {
    const tokens = this.getTokenCount();
    return tokens > this._tokenThreshold || tokens > this._maxContextTokens * this._compactThreshold;
  }

  /** True when token usage is at or above the compaction threshold. */
  isNearCapacity(): boolean {
    return this.getTokenCount() >= this._maxContextTokens * this._compactThreshold;
  }

  /** True when token usage exceeds the maximum context window. */
  isOverContextLimit(): boolean {
    return this.getTokenCount() > this._maxContextTokens;
  }

  /** Get current token utilization as absolute and percentage values. */
  getContextUsage(): ContextUsage {
    const current = this.getTokenCount();
    return {
      current,
      max: this._maxContextTokens,
      percent: Math.min(100, Math.round((current / this._maxContextTokens) * 100)),
      headroom: Math.max(0, this._maxContextTokens - current),
    };
  }

  /** Reduce message count using the specified strategy (truncate, sliding-window, or summarize). */
  async compress(strategy: CompressionStrategy, limit: number): Promise<void> {
    if (limit === 0) {
      this.messages = [];
      return;
    }

    if (this.messages.length <= limit) {
      return;
    }

    const before = { messages: this.messages.length, tokens: this.getTokenCount() };

    const systemMessages = this.messages.filter(m => m.role === 'system');
    const nonSystem = this.messages.filter(m => m.role !== 'system');

    if (strategy === 'truncate' || strategy === 'sliding-window') {
      const kept = nonSystem.slice(-limit);
      this.messages = [...systemMessages, ...kept];
    } else if (strategy === 'summarize') {
      if (!this._llmProvider) {
        throw new Error('Summarize strategy requires an LLM provider. Call setLLMProvider() first.');
      }
      await this._progressiveSummarize(limit);
    }

    const after = { messages: this.messages.length, tokens: this.getTokenCount() };
    this._compactionHistory.push({ before, after, strategy });
  }

  /** Automatically compact when thresholds are exceeded, with anti-thrash protection. */
  async autoCompact(): Promise<CompactionResult | null> {
    if (!this.shouldCompact()) return null;

    const before = { messages: this.messages.length, tokens: this.getTokenCount() };
    let attempts = 0;

    this._clearToolOutputs();
    if (!this.shouldCompact()) {
      const after = { messages: this.messages.length, tokens: this.getTokenCount() };
      const result: CompactionResult = { before, after, strategy: 'truncate' };
      this._compactionHistory.push(result);
      return result;
    }

    while (this.shouldCompact() && attempts < this._antiThrashMax) {
      attempts++;
      if (this._llmProvider) {
        await this._progressiveSummarize(this._recentToKeep);
      } else {
        const systemMessages = this.messages.filter(m => m.role === 'system');
        const nonSystem = this.messages.filter(m => m.role !== 'system');
        const kept = nonSystem.slice(-this._recentToKeep);
        this.messages = [...systemMessages, ...kept];
        break;
      }
    }

    const after = { messages: this.messages.length, tokens: this.getTokenCount() };
    const result: CompactionResult = {
      before,
      after,
      strategy: 'progressive',
      summary: this._runningSummary ? `Compacted in ${attempts} pass(es)` : undefined,
    };
    this._compactionHistory.push(result);
    return result;
  }

  /** Force compaction regardless of whether thresholds are exceeded. */
  async forceCompact(): Promise<CompactionResult> {
    const before = { messages: this.messages.length, tokens: this.getTokenCount() };

    if (this.messages.length <= 1) {
      const result: CompactionResult = { before, after: before, strategy: 'truncate' };
      this._compactionHistory.push(result);
      return result;
    }

    this._clearToolOutputs();

    if (this._llmProvider) {
      await this._progressiveSummarize(this._recentToKeep);
    } else {
      const systemMessages = this.messages.filter(m => m.role === 'system');
      const nonSystem = this.messages.filter(m => m.role !== 'system');
      const kept = nonSystem.slice(-this._recentToKeep);
      this.messages = [...systemMessages, ...kept];
    }

    const after = { messages: this.messages.length, tokens: this.getTokenCount() };
    const result: CompactionResult = { before, after, strategy: 'progressive' };
    this._compactionHistory.push(result);
    return result;
  }

  /** Get the log of all past compaction operations. */
  getCompactionHistory(): CompactionResult[] {
    return [...this._compactionHistory];
  }

  /** Get the current progressive summary of compacted conversation history. */
  getRunningSummary(): string {
    return this._runningSummary;
  }

  /** Capture the current conversation state for later rewind. */
  takeSnapshot(): RewindSnapshot {
    const snapshot: RewindSnapshot = {
      id: this._snapshotCounter++,
      timestamp: Date.now(),
      messages: this.messages.map(m => ({ ...m })),
      tokenCount: this.getTokenCount(),
      summary: this._runningSummary || undefined,
    };

    this._snapshots.push(snapshot);

    if (this._snapshots.length > this._maxSnapshots) {
      this._snapshots.shift();
    }

    return snapshot;
  }

  /** Restore conversation to a previous snapshot. Returns false if snapshot not found. */
  rewind(snapshotId: number): boolean {
    const snapshot = this._snapshots.find(s => s.id === snapshotId);
    if (!snapshot) return false;

    this.messages = snapshot.messages.map(m => ({ ...m }));
    this._runningSummary = snapshot.summary ?? '';

    const idx = this._snapshots.indexOf(snapshot);
    this._snapshots = this._snapshots.slice(0, idx + 1);

    return true;
  }

  /** Rewind to the snapshot closest to the given turn number. */
  rewindToTurn(turn: number): boolean {
    const target = this._snapshots.filter(s => s.messages.length <= turn * 2 + 1).pop();
    if (!target) return false;
    return this.rewind(target.id);
  }

  /** Get all stored rewind snapshots. */
  getSnapshots(): RewindSnapshot[] {
    return [...this._snapshots];
  }

  /** Number of stored rewind snapshots. */
  getSnapshotCount(): number {
    return this._snapshots.length;
  }

  /** Set the maximum number of snapshots to retain (oldest evicted first). */
  setMaxSnapshots(max: number): void {
    this._maxSnapshots = max;
    while (this._snapshots.length > max) {
      this._snapshots.shift();
    }
  }

  /** Serialize the full message manager state for persistence or transfer. */
  exportState(): {
    messages: Message[];
    runningSummary: string;
    snapshots: RewindSnapshot[];
    config: ContextWindowConfig;
    compactionHistory: CompactionResult[];
  } {
    return {
      messages: this.messages.map(m => ({ ...m })),
      runningSummary: this._runningSummary,
      snapshots: this._snapshots.map(s => ({ ...s, messages: s.messages.map(m => ({ ...m })) })),
      config: {
        maxTokens: this._maxContextTokens,
        compactThreshold: this._compactThreshold,
        recentMessagesToKeep: this._recentToKeep,
        summaryTargetRatio: this._summaryTargetRatio,
        antiThrashAttempts: this._antiThrashMax,
      },
      compactionHistory: [...this._compactionHistory],
    };
  }

  /** Restore message manager state from a previously exported snapshot. */
  importState(state: {
    messages: Message[];
    runningSummary?: string;
    snapshots?: RewindSnapshot[];
    config?: ContextWindowConfig;
  }): void {
    this.messages = state.messages.map(m => ({ ...m }));
    this._runningSummary = state.runningSummary ?? '';
    if (state.snapshots) {
      this._snapshots = state.snapshots;
      this._snapshotCounter = Math.max(0, ...state.snapshots.map(s => s.id)) + 1;
    }
    if (state.config) this.configure(state.config);
  }

  private _estimateMessageTokens(message: Message): number {
    const contentTokens = Math.ceil(message.content.length / CHARS_PER_TOKEN);
    const toolCallTokens = message.tool_calls
      ? message.tool_calls.reduce((sum, tc) => sum + Math.ceil((tc.name.length + tc.arguments.length) / CHARS_PER_TOKEN), 0)
      : 0;
    return contentTokens + toolCallTokens + ROLE_OVERHEAD_TOKENS;
  }

  private _clearToolOutputs(): void {
    this.messages = this.messages.map(m => {
      if (m.role === 'tool' && m.content.length > 500) {
        return {
          ...m,
          content: m.content.slice(0, 200) + '\n...[truncated]...\n' + m.content.slice(-200),
        };
      }
      return m;
    });
  }

  private async _progressiveSummarize(recentToKeep: number): Promise<void> {
    if (!this._llmProvider) {
      await this.compress('truncate', recentToKeep);
      return;
    }

    const systemMessages = this.messages.filter(m => m.role === 'system');
    const nonSystem = this.messages.filter(m => m.role !== 'system');

    if (nonSystem.length <= recentToKeep) return;

    const toSummarize = nonSystem.slice(0, nonSystem.length - recentToKeep);
    const toKeep = nonSystem.slice(-recentToKeep);

    const conversationText = toSummarize
      .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
      .join('\n');

    const summaryPrompt = this._runningSummary
      ? `Progressively summarize this conversation, building on the existing summary.

Existing summary:
${this._runningSummary}

New conversation to incorporate:
${conversationText}

Create a concise summary preserving: key decisions, file paths mentioned, errors encountered, task progress, and any constraints established. Be specific — names, paths, numbers matter.`
      : `Summarize this conversation concisely.

${conversationText}

Preserve: key decisions, file paths mentioned, errors encountered, task progress, and constraints. Be specific.`;

    try {
      const response = await this._llmProvider.invoke([
        { role: 'system', content: 'You are a conversation summarizer. Be concise but preserve critical details: file paths, function names, decisions, errors, and constraints. Output only the summary.' },
        { role: 'user', content: summaryPrompt },
      ], { temperature: 0, max_tokens: Math.ceil(this.getTokenCount() * this._summaryTargetRatio) });

      this._runningSummary = response.content;

      const summaryMessage: Message = {
        role: 'system',
        content: `[Conversation summary]\n${this._runningSummary}`,
      };

      this.messages = [...systemMessages, summaryMessage, ...toKeep];
    } catch {
      this.messages = [...systemMessages, ...toKeep];
    }
  }
}
