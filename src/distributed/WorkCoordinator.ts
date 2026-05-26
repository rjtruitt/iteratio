import { EventEmitter } from 'events';

/** Current lifecycle status of a work item. */
export type WorkStatus = 'available' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'abandoned';

/** Represents a unit of work to be claimed, processed, and completed by an agent. */
export interface WorkItem {
  id: string;
  description: string;
  type: string;
  status: WorkStatus;
  assignedTo?: string;
  assignedAt?: number;
  claimedUntil?: number;
  completedAt?: number;
  completedBy?: string;
  result?: any;
  error?: string;
  priority?: number;
  deadline?: number;
  dependencies?: string[];
  tags?: string[];
  metadata?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  attempts?: number;
}

/** Options for claiming a work item, including TTL and force-claim. */
export interface ClaimOptions {
  ttl?: number;
  force?: boolean;
  priority?: number;
}

/** Options for releasing a work item, including result data or error info. */
export interface ReleaseOptions {
  result?: any;
  error?: string;
  status?: WorkStatus;
}

/** Describes an active work assignment, including the lock expiry. */
export interface WorkAssignment {
  workId: string;
  agentId: string;
  status: WorkStatus;
  assignedAt: number;
  expiresAt: number;
}

/** Result of a similarity comparison between two work items. */
export interface SimilarityResult {
  workItem: WorkItem;
  similarityScore: number;
  reason: string;
}

/** Configuration for the work coordinator, including backend, TTL, and cleanup settings. */
export interface WorkCoordinatorConfig {
  redis: any;
  messageBus?: any;
  defaultTTL?: number;
  similarityThreshold?: number;
  cleanupInterval?: number;
}

let workIdCounter = 0;

/**
 * Distributed work coordinator for claiming, tracking, and completing work items.
 * Uses Redis-based distributed locks for safe concurrent access across agents.
 */
export class WorkCoordinator extends EventEmitter {
  private redis: any;
  private config: Required<WorkCoordinatorConfig>;
  private cleanupControl: { cancelled: boolean } | null = null;
  private workItems: Map<string, WorkItem> = new Map();
  private isShutdown = false;

  constructor(config: WorkCoordinatorConfig) {
    super();

    this.redis = config.redis;

    this.config = {
      defaultTTL: config.defaultTTL || 300000,
      similarityThreshold: config.similarityThreshold || 0.8,
      cleanupInterval: config.cleanupInterval || 60000,
      redis: config.redis,
      messageBus: config.messageBus,
    };
  }


  /**
   * Creates a new work item with the given description and options.
   * Returns the generated work ID.
   */
  async createWork(description: string, options?: {
    type?: string;
    priority?: number;
    deadline?: number;
    dependencies?: string[];
    tags?: string[];
    metadata?: Record<string, any>;
  }): Promise<string> {
    if (this.isShutdown) {
      throw new Error('WorkCoordinator is shut down');
    }

    const workId = `work_${++workIdCounter}_${Date.now()}`;

    const workItem: WorkItem = {
      id: workId,
      description,
      type: options?.type || 'task',
      status: 'available',
      priority: options?.priority || 0,
      deadline: options?.deadline,
      dependencies: options?.dependencies,
      tags: options?.tags,
      metadata: options?.metadata,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
    };

    this.workItems.set(workId, workItem);

    this.emit('work:created', workItem);
    return workId;
  }


  /**
   * Attempts to claim a work item for a specific agent using a distributed lock.
   * Returns true if the claim succeeded, false if another agent holds the lock.
   */
  async claimWork(workId: string, agentId: string, options?: ClaimOptions): Promise<boolean> {
    if (this.isShutdown) {
      throw new Error('WorkCoordinator is shut down');
    }

    if (!workId) return false;

    const ttl = options?.ttl ?? this.config.defaultTTL;

    if (ttl <= 0) {
      throw new Error('TTL must be positive');
    }

    const lockKey = `work:${workId}:lock`;

    const result = await this.redis.set(lockKey, agentId, 'NX', 'PX', ttl);

    if (result === 'OK') {
      const work = this.workItems.get(workId);
      if (work) {
        work.status = 'in_progress';
        work.assignedTo = agentId;
        work.assignedAt = Date.now();
        work.claimedUntil = Date.now() + ttl;
        work.attempts = (work.attempts || 0) + 1;
        work.updatedAt = Date.now();
      }

      this.emit('work:claimed', { workId, agentId });
      return true;
    }

    const currentHolder = await this.redis.get(lockKey);
    if (currentHolder === agentId) {
      await this.redis.expire(lockKey, Math.ceil(ttl / 1000));
      return true;
    }

    return false;
  }


  /**
   * Releases a claimed work item, setting its status and clearing the distributed lock.
   * Throws if the agent does not hold the lock.
   */
  async releaseWork(workId: string, agentId: string, options?: ReleaseOptions): Promise<void> {
    const lockKey = `work:${workId}:lock`;

    const currentHolder = await this.redis.get(lockKey);
    if (currentHolder === null) {
      throw new Error(`Lock for ${workId} does not exist or has expired`);
    }
    if (currentHolder !== agentId) {
      throw new Error(`Agent ${agentId} does not hold the lock for ${workId}`);
    }

    await this.redis.del(lockKey);

    const work = this.workItems.get(workId);
    if (work) {
      if (options?.error) {
        work.status = 'failed';
        work.error = options.error;
      } else if (options?.status) {
        work.status = options.status;
      } else {
        work.status = 'completed';
      }
      work.completedAt = Date.now();
      work.completedBy = agentId;
      work.result = options?.result;
      work.assignedTo = undefined;
      work.claimedUntil = undefined;
      work.updatedAt = Date.now();
    }

    this.emit('work:released', { workId, agentId });
  }


  /** Extends the lock TTL on a claimed work item. Returns false if the agent no longer holds the lock. */
  async extendLock(workId: string, agentId: string, newTTL: number): Promise<boolean> {
    const lockKey = `work:${workId}:lock`;

    const currentHolder = await this.redis.get(lockKey);
    if (currentHolder !== agentId) {
      return false;
    }

    await this.redis.expire(lockKey, Math.ceil(newTTL / 1000));

    const work = this.workItems.get(workId);
    if (work) {
      work.claimedUntil = Date.now() + newTTL;
      work.updatedAt = Date.now();
    }

    return true;
  }


  /** Gets a work item by ID, or null if it does not exist. */
  async getWork(workId: string): Promise<WorkItem | null> {
    return this.workItems.get(workId) || null;
  }

  /** Returns all work items with the given status. */
  async getWorkByStatus(status: WorkStatus): Promise<WorkItem[]> {
    return Array.from(this.workItems.values()).filter(w => w.status === status);
  }

  /** Returns all work items currently assigned to the given agent. */
  async getWorkByAgent(agentId: string): Promise<WorkItem[]> {
    return Array.from(this.workItems.values()).filter(w => w.assignedTo === agentId);
  }

  /** Returns all active work assignments (in-progress items with assigned agents). */
  async getWorkAssignments(): Promise<WorkAssignment[]> {
    return Array.from(this.workItems.values())
      .filter(w => w.assignedTo && w.status === 'in_progress')
      .map(w => ({
        workId: w.id,
        agentId: w.assignedTo!,
        status: w.status,
        assignedAt: w.assignedAt || 0,
        expiresAt: w.claimedUntil || 0,
      }));
  }

  /**
   * Claims the highest-priority available work item for the agent.
   * Returns the claimed work item, or null if none are available.
   */
  async claimNextWork(agentId: string, options?: ClaimOptions): Promise<WorkItem | null> {
    const available = Array.from(this.workItems.values())
      .filter(w => w.status === 'available')
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    if (available.length === 0) return null;

    const work = available[0];
    const claimed = await this.claimWork(work.id, agentId, options);
    if (claimed) {
      return this.workItems.get(work.id) || null;
    }
    return null;
  }


  /** Marks a work item as abandoned, releasing its lock. */
  async abandonWork(workId: string): Promise<void> {
    const work = this.workItems.get(workId);
    if (!work) return;

    const lockKey = `work:${workId}:lock`;
    await this.redis.del(lockKey);

    work.status = 'abandoned';
    work.assignedTo = undefined;
    work.claimedUntil = undefined;
    work.updatedAt = Date.now();

    this.emit('work:abandoned', { workId });
  }

  /**
   * Recovers work items assigned to a dead agent by resetting them to 'available'.
   * Returns the number of work items recovered.
   */
  async recoverWorkFromDeadAgent(agentId: string): Promise<number> {
    let recovered = 0;

    for (const work of this.workItems.values()) {
      if (work.assignedTo === agentId && work.status === 'in_progress') {
        const lockKey = `work:${work.id}:lock`;
        await this.redis.del(lockKey);

        work.status = 'available';
        work.assignedTo = undefined;
        work.claimedUntil = undefined;
        work.updatedAt = Date.now();
        recovered++;
      }
    }

    this.emit('work:recovered', { agentId, count: recovered });
    return recovered;
  }


  /** Cleans up expired locks, resetting in-progress items whose locks have expired back to 'available'. */
  async cleanupExpiredLocks(): Promise<number> {
    let cleaned = 0;
    const now = Date.now();

    for (const work of this.workItems.values()) {
      if (work.status === 'in_progress' && work.claimedUntil && now > work.claimedUntil) {
        const lockKey = `work:${work.id}:lock`;
        const lockValue = await this.redis.get(lockKey);
        if (lockValue === null) {
          work.status = 'available';
          work.assignedTo = undefined;
          work.claimedUntil = undefined;
          work.updatedAt = now;
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  /** Starts the periodic lock cleanup cycle. */
  async startCleanup(): Promise<void> {
    this.stopCleanup();

    const control = { cancelled: false };
    this.cleanupControl = control;

    const scheduleCleanup = () => {
      setTimeout(async () => {
        if (control.cancelled) return;
        await this.cleanupExpiredLocks();
        if (!control.cancelled) {
          scheduleCleanup();
        }
      }, this.config.cleanupInterval);
    };

    scheduleCleanup();
  }

  /** Stops the periodic lock cleanup cycle. */
  async stopCleanup(): Promise<void> {
    if (this.cleanupControl) {
      this.cleanupControl.cancelled = true;
      this.cleanupControl = null;
    }
  }


  /** Finds work items similar to the given criteria (by tags, type, or description). */
  async findSimilarWork(criteria: { tags?: string[]; type?: string; description?: string }): Promise<WorkItem[]> {
    return Array.from(this.workItems.values()).filter(w => {
      if (criteria.tags && w.tags) {
        const overlap = criteria.tags.filter(t => w.tags!.includes(t));
        if (overlap.length > 0) return true;
      }
      if (criteria.type && w.type === criteria.type) return true;
      return false;
    });
  }


  /** Returns aggregate work statistics (total, available, in-progress, completed, failed). */
  async getStats(): Promise<{
    totalWork: number;
    available: number;
    inProgress: number;
    completed: number;
    failed: number;
  }> {
    const all = Array.from(this.workItems.values());
    return {
      totalWork: all.length,
      available: all.filter(w => w.status === 'available').length,
      inProgress: all.filter(w => w.status === 'in_progress').length,
      completed: all.filter(w => w.status === 'completed').length,
      failed: all.filter(w => w.status === 'failed').length,
    };
  }


  /** Initializes the coordinator to an active state. */
  async initialize(): Promise<void> {
    this.isShutdown = false;
  }

  /** Shuts down the coordinator, stopping cleanup and emitting a shutdown event. */
  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await this.stopCleanup();
    this.emit('shutdown');
  }
}
