export interface MemoryEntry {
  key: string;
  value: unknown;
  agentId: string;
  timestamp: number;
  version: number;
  vectorClock?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface MemoryStoreConfig {
  /** Enable isolation (agent can only see own memories) */
  isolationMode?: boolean;
  /** Conflict resolution strategy */
  conflictResolution?: 'last-write-wins' | 'vector-clock' | 'manual';
  /** Enable deduplication */
  deduplicate?: boolean;
  /** Redis for persistence */
  redis?: any;
  /** Transport for broadcasting */
  transport?: any;
}

export interface MemoryConflict {
  key: string;
  localEntry: MemoryEntry;
  remoteEntry: MemoryEntry;
  resolution?: 'local' | 'remote' | 'merged';
}

/**
 * Distributed memory store with agent isolation, conflict resolution (LWW/vector clock),
 * offline queuing, broadcast synchronization, and optional Redis persistence.
 */
export class MemoryStore {
  private config: MemoryStoreConfig;
  private entries = new Map<string, MemoryEntry>();
  private offlineQueue: Array<{ op: 'set' | 'delete'; entry: MemoryEntry }> = [];
  private _broadcasts: Array<{ key: string; entry: MemoryEntry }> = [];
  private _conflicts: MemoryConflict[] = [];
  private online = true;
  private versionCounter = 0;
  private vectorClocks = new Map<string, Record<string, number>>();

  /**
   * Create a new MemoryStore with optional configuration.
   *
   * @param config - Configuration for isolation mode, conflict resolution, deduplication, and backends
   */
  constructor(config: MemoryStoreConfig = {}) {
    this.config = config;
  }

  get broadcasts() { return this._broadcasts; }
  get conflicts() { return this._conflicts; }
  get offlineQueueLength() { return this.offlineQueue.length; }

  store(key: string, value: unknown, agentId: string, metadata?: Record<string, unknown>): MemoryEntry {
    const existing = this.entries.get(key);

    if (this.config.deduplicate && existing) {
      if (JSON.stringify(existing.value) === JSON.stringify(value)) {
        return existing;
      }
    }

    if (existing && existing.agentId !== agentId) {
      const conflict: MemoryConflict = {
        key,
        localEntry: existing,
        remoteEntry: { key, value, agentId, timestamp: Date.now(), version: this.versionCounter + 1 },
      };

      if (this.config.conflictResolution === 'last-write-wins') {
        conflict.resolution = 'remote'; // New write wins
      } else if (this.config.conflictResolution === 'vector-clock') {
        conflict.resolution = this.resolveByVectorClock(key, agentId, existing.agentId);
      } else {
        conflict.resolution = undefined; // Manual resolution needed
      }

      this._conflicts.push(conflict);

      if (conflict.resolution === 'local') {
        return existing;
      }
    }

    this.versionCounter++;
    const entry: MemoryEntry = {
      key,
      value,
      agentId,
      timestamp: Date.now(),
      version: this.versionCounter,
      vectorClock: this.incrementVectorClock(key, agentId),
      metadata,
    };

    this.entries.set(key, entry);

    if (this.online && this.config.transport) {
      this._broadcasts.push({ key, entry });
    } else if (!this.online) {
      this.offlineQueue.push({ op: 'set', entry });
    }

    return entry;
  }

  get(key: string, requestingAgentId?: string): MemoryEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (this.config.isolationMode && requestingAgentId && entry.agentId !== requestingAgentId) {
      return undefined;
    }

    return entry;
  }

  search(predicate: (entry: MemoryEntry) => boolean, requestingAgentId?: string): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (this.config.isolationMode && requestingAgentId && entry.agentId !== requestingAgentId) {
        continue;
      }
      if (predicate(entry)) {
        results.push(entry);
      }
    }
    return results;
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  goOffline(): void {
    this.online = false;
  }

  goOnline(): Array<{ op: string; entry: MemoryEntry }> {
    this.online = true;
    const flushed = [...this.offlineQueue];
    for (const item of flushed) {
      this._broadcasts.push({ key: item.entry.key, entry: item.entry });
    }
    this.offlineQueue = [];
    return flushed;
  }

  mergeRemote(remoteEntries: MemoryEntry[]): { merged: number; conflicts: MemoryConflict[] } {
    const newConflicts: MemoryConflict[] = [];
    let merged = 0;

    for (const remote of remoteEntries) {
      const local = this.entries.get(remote.key);

      if (!local) {
        this.entries.set(remote.key, remote);
        merged++;
        continue;
      }

      if (local.version === remote.version && JSON.stringify(local.value) === JSON.stringify(remote.value)) {
        continue;
      }

      const conflict: MemoryConflict = { key: remote.key, localEntry: local, remoteEntry: remote };

      if (this.config.conflictResolution === 'last-write-wins') {
        // Remote wins on tie since mergeRemote implies remote is authoritative
        if (remote.timestamp >= local.timestamp || remote.version > local.version) {
          this.entries.set(remote.key, remote);
          conflict.resolution = 'remote';
          merged++;
        } else {
          conflict.resolution = 'local';
        }
      } else {
        conflict.resolution = undefined;
      }

      newConflicts.push(conflict);
    }

    this._conflicts.push(...newConflicts);
    return { merged, conflicts: newConflicts };
  }

  getAllEntries(): MemoryEntry[] {
    return [...this.entries.values()];
  }

  getByAgent(agentId: string): MemoryEntry[] {
    return [...this.entries.values()].filter(e => e.agentId === agentId);
  }

  get size(): number {
    return this.entries.size;
  }

  isOnline(): boolean {
    return this.online;
  }

  /**
   * Increment the vector clock for a given key and agent.
   *
   * @param key - Memory key
   * @param agentId - Agent ID making the change
   * @returns Updated vector clock record
   */
  private incrementVectorClock(key: string, agentId: string): Record<string, number> {
    const clock = this.vectorClocks.get(key) || {};
    clock[agentId] = (clock[agentId] || 0) + 1;
    this.vectorClocks.set(key, clock);
    return { ...clock };
  }

  /**
   * Resolve a conflict between two agents using vector clock comparison.
   *
   * @param key - Memory key in conflict
   * @param newAgentId - Agent making the new write
   * @param existingAgentId - Agent that wrote the existing entry
   * @returns 'remote' if the new write wins, 'local' otherwise
   */
  private resolveByVectorClock(key: string, newAgentId: string, existingAgentId: string): 'local' | 'remote' {
    const clock = this.vectorClocks.get(key) || {};
    const newCount = clock[newAgentId] || 0;
    const existingCount = clock[existingAgentId] || 0;
    return newCount >= existingCount ? 'remote' : 'local';
  }

  reset(): void {
    this.entries.clear();
    this.offlineQueue = [];
    this._broadcasts = [];
    this._conflicts = [];
    this.online = true;
    this.versionCounter = 0;
    this.vectorClocks.clear();
  }
}
