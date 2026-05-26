import { injectable } from 'inversify';
import { IStateManager } from '../interfaces/IStateManager.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Configuration for the state persistence backend. */
export interface PersistenceConfig {
  /** The storage backend to use: in-memory or persisted to a JSON file. */
  backend: 'memory' | 'json-file';
  /** Required if backend is 'json-file' — path to the persistence file. */
  filePath?: string;
}

/** Key-value state manager with optional JSON file persistence. */
@injectable()
export class StateManager implements IStateManager {
  private state: Map<string, unknown> = new Map();
  private _persistConfig: PersistenceConfig = { backend: 'memory' };
  private _changeListeners: Array<(key: string, value: unknown) => void> = [];

  /** Retrieve a value by key. Returns undefined if the key does not exist. */
  get<T = unknown>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  /** Store a value by key. Notifies all registered change listeners. */
  set<T = unknown>(key: string, value: T): void {
    this.state.set(key, value);
    for (const cb of this._changeListeners) {
      cb(key, value);
    }
  }

  /** Check if a key exists in the state store. */
  has(key: string): boolean {
    return this.state.has(key);
  }

  /** Remove a key from the state store. */
  delete(key: string): void {
    this.state.delete(key);
  }

  /** Remove all keys from the state store. */
  clear(): void {
    this.state.clear();
  }

  /** Export state as a plain JavaScript object (key-value pairs). */
  toObject(): Record<string, unknown> {
    return Object.fromEntries(this.state);
  }

  /** Import state from a plain JavaScript object, replacing all existing keys. */
  fromObject(state: Record<string, unknown>): void {
    this.state = new Map(Object.entries(state));
  }

  /** Configure the persistence backend (memory or JSON file). */
  configurePersistence(config: PersistenceConfig): void {
    this._persistConfig = config;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(cb: (key: string, value: unknown) => void): () => void {
    this._changeListeners.push(cb);
    return () => {
      const idx = this._changeListeners.indexOf(cb);
      if (idx >= 0) this._changeListeners.splice(idx, 1);
    };
  }

  /** Write current state to the configured persistence backend. */
  async persist(): Promise<void> {
    if (this._persistConfig.backend === 'memory') return;

    if (this._persistConfig.backend === 'json-file') {
      const filePath = this._persistConfig.filePath;
      if (!filePath) throw new Error('json-file backend requires filePath');
      await mkdir(dirname(filePath), { recursive: true });
      const data = JSON.stringify(this.toObject(), null, 2);
      await writeFile(filePath, data, 'utf-8');
    }
  }

  /** Load state from the configured persistence backend. No-op if file doesn't exist. */
  async load(): Promise<void> {
    if (this._persistConfig.backend === 'memory') return;

    if (this._persistConfig.backend === 'json-file') {
      const filePath = this._persistConfig.filePath;
      if (!filePath) throw new Error('json-file backend requires filePath');
      try {
        const raw = await readFile(filePath, 'utf-8');
        const obj = JSON.parse(raw);
        this.fromObject(obj);
      } catch (err: any) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
    }
  }
}
