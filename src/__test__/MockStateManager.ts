import type { IStateManager } from '../interfaces/IStateManager.js';

export class MockStateManager implements IStateManager {
  private state = new Map<string, unknown>();
  private _persistCalls = 0;
  private _loadCalls = 0;
  private persistShouldThrow = false;
  private loadShouldThrow = false;
  private corruptedState: Record<string, unknown> | null = null;

  get persistCalls() { return this._persistCalls; }
  get loadCalls() { return this._loadCalls; }

  get<T = unknown>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.state.set(key, value);
  }

  has(key: string): boolean {
    return this.state.has(key);
  }

  delete(key: string): void {
    this.state.delete(key);
  }

  clear(): void {
    this.state.clear();
  }

  toObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of this.state) {
      obj[key] = value;
    }
    return obj;
  }

  fromObject(state: Record<string, unknown>): void {
    this.state.clear();
    for (const [key, value] of Object.entries(state)) {
      this.state.set(key, value);
    }
  }

  async persist(): Promise<void> {
    this._persistCalls++;
    if (this.persistShouldThrow) {
      throw new Error('MockStateManager: persist failed');
    }
  }

  async load(): Promise<void> {
    this._loadCalls++;
    if (this.loadShouldThrow) {
      throw new Error('MockStateManager: load failed');
    }
    if (this.corruptedState) {
      this.fromObject(this.corruptedState);
    }
  }

  setPersistShouldThrow(shouldThrow: boolean): void {
    this.persistShouldThrow = shouldThrow;
  }

  setLoadShouldThrow(shouldThrow: boolean): void {
    this.loadShouldThrow = shouldThrow;
  }

  injectCorruptedState(state: Record<string, unknown>): void {
    this.corruptedState = state;
  }

  reset(): void {
    this.state.clear();
    this._persistCalls = 0;
    this._loadCalls = 0;
    this.persistShouldThrow = false;
    this.loadShouldThrow = false;
    this.corruptedState = null;
  }
}
