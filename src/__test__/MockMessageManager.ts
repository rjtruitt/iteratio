import type { IMessageManager, GetMessagesOptions, CompressionStrategy, ContextUsage, ContextWindowConfig, CompactionResult, RewindSnapshot, MessageManagerState } from '../interfaces/IMessageManager.js';
import type { Message, ILLMProvider } from '../interfaces/ILLMProvider.js';

export class MockMessageManager implements IMessageManager {
  messages: Message[] = [];
  _compressCalls = 0;
  compressShouldThrow = false;
  private _maxContextTokens = 200_000;
  private _tokenThreshold = Infinity;

  get compressCalls() { return this._compressCalls; }

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  getMessages(options?: GetMessagesOptions): Message[] {
    if (!options) return [...this.messages];
    let result = [...this.messages];
    if (options.role) result = result.filter(m => m.role === options.role);
    if (options.limit) result = result.slice(-options.limit);
    return result;
  }

  clear(): void { this.messages = []; }
  count(): number { return this.messages.length; }

  getTokenCount(): number {
    return this.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 0);
  }

  setTokenThreshold(threshold: number): void { this._tokenThreshold = threshold; }
  setMaxContextTokens(max: number): void { this._maxContextTokens = max; }
  shouldCompact(): boolean { return this.getTokenCount() > this._tokenThreshold; }
  isNearCapacity(): boolean { return this.getTokenCount() >= this._maxContextTokens * 0.85; }
  isOverContextLimit(): boolean { return this.getTokenCount() > this._maxContextTokens; }

  getContextUsage(): ContextUsage {
    const current = this.getTokenCount();
    return { current, max: this._maxContextTokens, percent: Math.round((current / this._maxContextTokens) * 100), headroom: Math.max(0, this._maxContextTokens - current) };
  }

  async compress(strategy: CompressionStrategy, limit: number): Promise<void> {
    this._compressCalls++;
    if (this.compressShouldThrow) throw new Error('MockMessageManager: compress failed');
    if (strategy === 'truncate' || strategy === 'sliding-window') {
      this.messages = this.messages.slice(-limit);
    }
  }

  async autoCompact(): Promise<CompactionResult | null> { return null; }
  async forceCompact(): Promise<CompactionResult> { return { before: { messages: 0, tokens: 0 }, after: { messages: 0, tokens: 0 }, strategy: 'truncate' }; }
  getCompactionHistory(): CompactionResult[] { return []; }
  getRunningSummary(): string { return ''; }

  configure(_config: ContextWindowConfig): void {}
  setLLMProvider(_provider: ILLMProvider): void {}

  takeSnapshot(): RewindSnapshot { return { id: 0, timestamp: Date.now(), messages: [...this.messages], tokenCount: this.getTokenCount() }; }
  rewind(_snapshotId: number): boolean { return false; }
  rewindToTurn(_turn: number): boolean { return false; }
  getSnapshots(): RewindSnapshot[] { return []; }
  getSnapshotCount(): number { return 0; }
  setMaxSnapshots(_max: number): void {}

  exportState(): MessageManagerState {
    return { messages: this.messages, runningSummary: '', snapshots: [], config: {}, compactionHistory: [] };
  }
  importState(_state: Partial<MessageManagerState>): void {}

  setCompressShouldThrow(shouldThrow: boolean): void {
    this.compressShouldThrow = shouldThrow;
  }

  reset(): void {
    this.messages = [];
    this._compressCalls = 0;
    this.compressShouldThrow = false;
  }
}
