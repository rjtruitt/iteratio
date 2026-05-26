export interface CheckpointData {
  id: string;
  agentId: string;
  timestamp: number;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  turnNumber: number;
  version: number;
  /** Whether this checkpoint is from a transient state (e.g., paused) */
  transient?: boolean;
}

export interface CheckpointConfig {
  agentId: string;
  redis?: any;
  /** Interval between automatic checkpoints (ms) */
  intervalMs?: number;
  /** Maximum checkpoints to retain */
  maxCheckpoints?: number;
}

/**
 * Manages session checkpoint save/restore with optional Redis persistence,
 * versioning, transient checkpoint support, and integrity validation.
 */
export class SessionCheckpoint {
  private config: CheckpointConfig;
  private checkpoints: CheckpointData[] = [];
  private currentVersion = 0;
  private _saves: CheckpointData[] = [];
  private _restores: Array<{ checkpoint: CheckpointData; timestamp: number }> = [];

  /**
   * Create a new SessionCheckpoint for a specific agent.
   *
   * @param config - Checkpoint configuration including agent ID, optional Redis client, and retention limits
   */
  constructor(config: CheckpointConfig) {
    this.config = config;
  }

  get saves() { return this._saves; }
  get restores() { return this._restores; }
  get latestCheckpoint(): CheckpointData | null {
    return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : null;
  }

  /**
   * Save a checkpoint
   */
  async save(state: Record<string, unknown>, metadata: Record<string, unknown> = {}, options?: { transient?: boolean }): Promise<CheckpointData> {
    this.currentVersion++;
    const checkpoint: CheckpointData = {
      id: `ckpt-${this.config.agentId}-${this.currentVersion}`,
      agentId: this.config.agentId,
      timestamp: Date.now(),
      state: structuredClone(state),
      metadata: structuredClone(metadata),
      turnNumber: (state.turnNumber as number) || (state.turn as number) || 0,
      version: this.currentVersion,
      transient: options?.transient,
    };

    this.checkpoints.push(checkpoint);
    this._saves.push(checkpoint);

    if (this.config.maxCheckpoints && this.checkpoints.length > this.config.maxCheckpoints) {
      this.checkpoints.shift();
    }

    if (this.config.redis) {
      try {
        const key = `checkpoint:${this.config.agentId}:${checkpoint.version}`;
        await this.config.redis.set(key, JSON.stringify(checkpoint));
        await this.config.redis.set(`checkpoint:${this.config.agentId}:latest`, JSON.stringify(checkpoint));
      } catch {
      }
    }

    return checkpoint;
  }

  /**
   * Restore from latest checkpoint
   */
  async restore(): Promise<CheckpointData | null> {
    if (this.config.redis) {
      try {
        const data = await this.config.redis.get(`checkpoint:${this.config.agentId}:latest`);
        if (data) {
          const checkpoint = JSON.parse(data) as CheckpointData;
          this._restores.push({ checkpoint, timestamp: Date.now() });
          return checkpoint;
        }
      } catch {
      }
    }

    if (this.checkpoints.length === 0) return null;

    const durable = this.checkpoints.filter(c => !c.transient);
    const checkpoint = durable.length > 0 ? durable[durable.length - 1] : this.checkpoints[this.checkpoints.length - 1];

    this._restores.push({ checkpoint, timestamp: Date.now() });
    return checkpoint;
  }

  /**
   * Restore from a specific version
   */
  async restoreVersion(version: number): Promise<CheckpointData | null> {
    if (this.config.redis) {
      try {
        const data = await this.config.redis.get(`checkpoint:${this.config.agentId}:${version}`);
        if (data) {
          const checkpoint = JSON.parse(data) as CheckpointData;
          this._restores.push({ checkpoint, timestamp: Date.now() });
          return checkpoint;
        }
      } catch {
      }
    }

    const checkpoint = this.checkpoints.find(c => c.version === version);
    if (checkpoint) {
      this._restores.push({ checkpoint, timestamp: Date.now() });
    }
    return checkpoint || null;
  }

  /**
   * Validate checkpoint integrity
   */
  validateCheckpoint(checkpoint: CheckpointData): { valid: boolean; reason?: string } {
    if (!checkpoint.id || !checkpoint.agentId) {
      return { valid: false, reason: 'Missing required fields' };
    }
    if (!checkpoint.state || typeof checkpoint.state !== 'object') {
      return { valid: false, reason: 'Invalid or corrupted state' };
    }
    if (checkpoint.version <= 0) {
      return { valid: false, reason: 'Invalid version number' };
    }
    return { valid: true };
  }

  /**
   * Get all checkpoints for this agent
   */
  getCheckpoints(): CheckpointData[] {
    return [...this.checkpoints];
  }

  /**
   * Clear all checkpoints
   */
  clear(): void {
    this.checkpoints = [];
    this._saves = [];
    this._restores = [];
    this.currentVersion = 0;
  }
}
