import { EventEmitter } from 'events';
import { RedisElectionBackend } from './RedisElectionBackend.js';

/** Roles that can participate in leader election. */
export type LeadershipRole = 'overseer' | 'coordinator' | 'scheduler' | 'monitor';

/** Information about the current leader for a given role. */
export interface LeaderInfo {
  role: LeadershipRole;
  leaderId: string;      // Agent ID
  electedAt: number;
  term: number;          // Election term number
  metadata?: Record<string, any>;
}

/** Options for starting an election campaign. */
export interface CampaignOptions {
  value?: string;        // Value to store (default: agent ID)
  metadata?: Record<string, any>;
  ttl?: number;          // Leadership TTL (default: 30s)
}

/** Configuration for the leader election system. */
export interface LeaderElectionConfig {
  etcd: any;             // Redis-compatible backend (MockRedis in tests)
  agentId: string;       // This agent's ID
  messageBus?: any;      // Optional message bus for announcements
  defaultTTL?: number;   // Default leadership TTL (30s)
}

/** Pluggable backend for distributed election storage (e.g., Redis, etcd). */
export interface IElectionBackend {
  /** Attempts to acquire the leadership lock atomically. Returns true if this candidate won. */
  campaign(electionKey: string, candidateId: string, ttl: number): Promise<boolean>;
  /** Gets the current leader ID for the given election key, or null. */
  getLeader(electionKey: string): Promise<string | null>;
  /** Relinquishes the leadership lock for a given candidate. */
  resign(electionKey: string, candidateId: string): Promise<void>;
  /** Watches for leadership changes on the given election key. */
  watch(electionKey: string, callback: (leader: string | null) => void): Promise<void>;
  /** Closes the backend and releases resources. */
  close(): Promise<void>;
}

// Maximum allowed TTL: 5 minutes
const MAX_TTL = 300000;

/**
 * Distributed leader election using Redis-based locks.
 * Supports multiple leadership roles, automatic TTL refresh, and change watching.
 */
export class LeaderElection extends EventEmitter {
  private backend: RedisElectionBackend;
  private config: Required<LeaderElectionConfig>;
  private activeCampaigns: Map<LeadershipRole, {
    isLeader: boolean;
    term: number;
    startedAt: number;
  }> = new Map();
  private watchers: Map<LeadershipRole, any> = new Map();
  private refreshCancellers: Map<LeadershipRole, { cancelled: boolean }> = new Map();
  private isShutdown = false;

  constructor(config: LeaderElectionConfig) {
    super();

    if (!config.agentId) {
      throw new Error('LeaderElection: agentId is required');
    }

    this.config = {
      ...config,
      messageBus: config.messageBus || null,
      defaultTTL: config.defaultTTL || 30000,
    };

    this.backend = new RedisElectionBackend(config.etcd);
  }

  /**
   * Starts an election campaign for the given role.
   * Returns LeaderInfo indicating whether this agent won or who the current leader is.
   */
  async campaign(role: LeadershipRole, options?: CampaignOptions): Promise<LeaderInfo> {
    if (this.isShutdown) {
      throw new Error('LeaderElection is shut down');
    }

    if (!this.config.agentId) {
      throw new Error('Cannot campaign with empty agentId');
    }

    const ttl = options?.ttl || this.config.defaultTTL;

    if (ttl > MAX_TTL) {
      throw new Error(`TTL ${ttl}ms exceeds maximum allowed (${MAX_TTL}ms)`);
    }

    const electionKey = `leader-${role}`;
    const won = await this.backend.campaign(
      electionKey,
      options?.value || this.config.agentId,
      ttl
    );

    const term = await this.getNextTerm(role);

    this.activeCampaigns.set(role, {
      isLeader: won,
      term,
      startedAt: Date.now(),
    });

    if (won) {
      if (this.config.messageBus) {
        await this.config.messageBus.announceLifecycle('leader.elected', {
          role,
          leaderId: this.config.agentId,
          term,
          timestamp: Date.now(),
        });
      }

      this.emit('leader:elected', { role, term });

      this.startLeadershipRefresh(role, electionKey, ttl);
    }

    const leaderInfo: LeaderInfo = {
      role,
      leaderId: won ? this.config.agentId : (await this.backend.getLeader(electionKey) || ''),
      electedAt: Date.now(),
      term,
      metadata: options?.metadata,
    };

    return leaderInfo;
  }

  /** Resigns from a leadership role. Throws if not currently the leader for that role. */
  async resign(role: LeadershipRole): Promise<void> {
    const campaign = this.activeCampaigns.get(role);
    if (!campaign || !campaign.isLeader) {
      throw new Error(`Not currently leader for ${role}`);
    }

    const electionKey = `leader-${role}`;
    await this.backend.resign(electionKey, this.config.agentId);

    this.stopLeadershipRefresh(role);

    if (this.config.messageBus) {
      await this.config.messageBus.announceLifecycle('leader.resigned', {
        role,
        leaderId: this.config.agentId,
        term: campaign.term,
        timestamp: Date.now(),
      });
    }

    campaign.isLeader = false;
    this.activeCampaigns.delete(role);

    this.emit('leader:resigned', { role });
  }

  /** Returns whether this agent is the current leader for the given role. */
  isLeader(role: LeadershipRole): boolean {
    const campaign = this.activeCampaigns.get(role);
    return campaign?.isLeader || false;
  }

  /** Gets the leader ID for the given role, or null if no leader exists. */
  async getLeader(role: LeadershipRole): Promise<string | null> {
    const electionKey = `leader-${role}`;
    return await this.backend.getLeader(electionKey);
  }

  /** Gets full LeaderInfo for the given role, or null if no leader exists. */
  async getLeaderInfo(role: LeadershipRole): Promise<LeaderInfo | null> {
    const leaderId = await this.getLeader(role);
    if (!leaderId) return null;

    const campaign = this.activeCampaigns.get(role);

    const leaderInfo: LeaderInfo = {
      role,
      leaderId,
      electedAt: campaign?.startedAt || 0,
      term: campaign?.term || 0,
    };

    return leaderInfo;
  }

  /** Watches for leadership changes and invokes the callback whenever the leader changes. */
  async watchLeaderChanges(
    role: LeadershipRole,
    callback: (leader: string | null) => void
  ): Promise<void> {
    const electionKey = `leader-${role}`;

    await this.backend.watch(electionKey, (newLeader) => {
      if (this.config.messageBus) {
        this.config.messageBus.announceLifecycle('leader.changed', {
          role,
          leaderId: newLeader,
          timestamp: Date.now(),
        });
      }

      this.emit('leader:changed', { role, leaderId: newLeader });

      callback(newLeader);
    });

    this.watchers.set(role, { electionKey, callback });
  }

  /** Stops watching for leadership changes on the given role. */
  async stopWatching(role: LeadershipRole): Promise<void> {
    const watcher = this.watchers.get(role);
    if (!watcher) return;

    await this.backend.stopWatch(watcher.electionKey);
    this.watchers.delete(role);
  }

  private startLeadershipRefresh(role: LeadershipRole, electionKey: string, ttl: number): void {
    this.stopLeadershipRefresh(role);

    const control = { cancelled: false };
    this.refreshCancellers.set(role, control);

    const scheduleRefresh = () => {
      setTimeout(async () => {
        if (control.cancelled) return;

        try {
          const won = await this.backend.campaign(
            electionKey,
            this.config.agentId,
            ttl
          );

          if (control.cancelled) return;

          if (!won) {
            this.stopLeadershipRefresh(role);

            const campaign = this.activeCampaigns.get(role);
            if (campaign) {
              campaign.isLeader = false;
            }

            if (this.config.messageBus) {
              await this.config.messageBus.announceLifecycle('leader.lost', {
                role,
                leaderId: this.config.agentId,
                timestamp: Date.now(),
              });
            }

            this.emit('leader:lost', { role });
            return;
          }

          if (!control.cancelled) {
            scheduleRefresh();
          }
        } catch (error) {
          control.cancelled = true;
          this.refreshCancellers.delete(role);

          const campaign = this.activeCampaigns.get(role);
          if (campaign) {
            campaign.isLeader = false;
          }

          this.emit('leader:lost', { role });
        }
      }, ttl / 2);
    };

    scheduleRefresh();
  }

  private stopLeadershipRefresh(role: LeadershipRole): void {
    const control = this.refreshCancellers.get(role);
    if (control) {
      control.cancelled = true;
      this.refreshCancellers.delete(role);
    }
  }

  private async getNextTerm(role: LeadershipRole): Promise<number> {
    const termKey = `leader-term-${role}`;
    try {
      const current = await this.config.etcd.get(termKey);
      const nextTerm = (current ? parseInt(current, 10) : 0) + 1;
      await this.config.etcd.set(termKey, String(nextTerm));
      return nextTerm;
    } catch {
      const campaign = this.activeCampaigns.get(role);
      return campaign ? campaign.term + 1 : 1;
    }
  }

  /** Returns all roles this agent is currently campaigning for, with leadership status. */
  getActiveCampaigns(): Array<{
    role: LeadershipRole;
    isLeader: boolean;
    term: number;
    startedAt: number;
  }> {
    return Array.from(this.activeCampaigns.entries()).map(([role, info]) => ({
      role,
      ...info,
    }));
  }

  /**
   * Executes a callback only if this agent is the current leader for the given role.
   * Returns null if not the leader, otherwise the callback result.
   */
  async withLeadership<T>(role: LeadershipRole, callback: () => Promise<T>): Promise<T | null> {
    if (!this.isLeader(role)) {
      return null;
    }
    try {
      return await callback();
    } finally {
    }
  }

  /**
   * Blocks and retries until this agent wins leadership for the given role or the timeout expires.
   * Returns true if leadership was acquired, false on timeout.
   */
  async waitForLeadership(role: LeadershipRole, timeout = 60000): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        await this.campaign(role);
        if (this.isLeader(role)) {
          return true;
        }
      } catch {
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return false;
  }

  /** Initializes the election system. */
  async initialize(): Promise<void> {
    if (this.config.messageBus && this.config.messageBus.watchLifecycle) {
      await this.config.messageBus.watchLifecycle('leader.changed', (_data: any) => {
      });
    }
  }

  /** Shuts down the election system, resigning all leadership roles and stopping all watchers. */
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    for (const [role, campaign] of this.activeCampaigns) {
      if (campaign.isLeader) {
        try {
          await this.resign(role);
        } catch {
        }
      }
    }

    for (const role of this.watchers.keys()) {
      await this.stopWatching(role);
    }

    for (const role of this.refreshCancellers.keys()) {
      this.stopLeadershipRefresh(role);
    }

    await this.backend.close();

    this.activeCampaigns.clear();

    this.emit('shutdown');
  }
}

/**
 * Utility that campaigns for a role, runs the callback as leader, then resigns.
 * Throws if leadership cannot be acquired.
 */
export async function withLeadership(
  election: LeaderElection,
  role: LeadershipRole,
  callback: () => Promise<void>
): Promise<void> {
  const leader = await election.campaign(role);
  if (!election.isLeader(role)) {
    throw new Error(`Failed to become leader for ${role}`);
  }

  try {
    await callback();
  } finally {
    await election.resign(role);
  }
}

/**
 * Blocks until leadership is acquired for the given role or the timeout expires.
 * Returns true if leadership was acquired.
 */
export async function waitForLeadership(
  election: LeaderElection,
  role: LeadershipRole,
  timeout = 60000
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      await election.campaign(role);
      if (election.isLeader(role)) {
        return true;
      }
    } catch {
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return false;
}
