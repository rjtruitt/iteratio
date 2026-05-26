/** Key-value state manager interface for agent state and metadata. */
export interface IStateManager {
  /** Get a value by key, returns undefined if not found. */
  get<T = unknown>(key: string): T | undefined;
  /** Set a value by key. */
  set<T = unknown>(key: string, value: T): void;
  /** Check if a key exists in state. */
  has(key: string): boolean;
  /** Delete a key from state. */
  delete(key: string): void;
  /** Clear all state. */
  clear(): void;
  /** Export all state as a plain object. */
  toObject(): Record<string, unknown>;
  /** Import state from a plain object, replacing current state. */
  fromObject(state: Record<string, unknown>): void;
  /** Persist state to a backing store, if supported. */
  persist?(): Promise<void>;
  /** Load state from a backing store, if supported. */
  load?(): Promise<void>;
}
