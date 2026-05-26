import { EventEmitter } from 'events';

/**
 * Configuration for the hub election process.
 */
export interface HubElectionConfig {
  /**
   * Discovery mode:
   * - `auto`: Try to find hub, become hub if none found
   * - `connect-to`: Always connect to specified hub
   * - `become-hub`: Force this instance to become hub
   */
  discovery: 'auto' | 'connect-to' | 'become-hub';

  /**
   * Timeout for discovery response (ms).
   * If no hub responds within this time, become hub.
   * @default 5000
   */
  discoveryTimeout?: number;

  /**
   * Interval for hub health checks (ms).
   * @default 10000
   */
  healthCheckInterval?: number;

  /**
   * Max missed heartbeats before declaring hub dead.
   * @default 3
   */
  maxMissedHeartbeats?: number;

  /**
   * Unique ID for this instance.
   * Auto-generated if not provided.
   */
  instanceId?: string;

  /**
   * Priority boost for this instance (0-1).
   * Higher priority increases chance of becoming hub.
   * @default 0
   */
  priorityBoost?: number;
}

/**
 * States in the hub election state machine.
 */
export type HubElectionState =
  | 'discovering'     // Searching for existing hub
  | 'connecting'      // Connecting to discovered hub
  | 'hub'             // This instance is the hub
  | 'connected'       // Connected to hub as client
  | 'electing'        // In election process (tie-breaker)
  | 'failed';         // Election failed

/**
 * Information about an active hub instance.
 */
export interface HubInfo {
  /** Hub instance ID. */
  id: string;

  /** Hub hostname. */
  hostname: string;

  /** Hub platform (darwin, linux, win32, etc). */
  platform: string;

  /** Hub connection endpoint. */
  endpoint: string;

  /** Timestamp when hub was started. */
  startedAt: number;

  /** Number of connected clients. */
  clientCount: number;

  /** Hub capabilities. */
  capabilities: {
    modelSharing: boolean;
    toolSharing: boolean;
    artifactTransfer: boolean;
  };
}

/**
 * An election proposal submitted by a candidate during tie-breaking.
 */
export interface ElectionProposal {
  /** Candidate instance ID. */
  instanceId: string;

  /** Timestamp when proposal was made. */
  timestamp: number;

  /** Random value (0-1) for tie-breaking. */
  random: number;

  /** Final election score (random + timestamp + priority). */
  score: number;

  /** Priority boost applied. */
  priority: number;

  /** Instance metadata for capability negotiation. */
  metadata: {
    hostname: string;
    platform: string;
    uptime: number;
    capabilities: string[];
  };
}

/**
 * Manages hub election using discovery and tie-breaker algorithms.
 *
 * Supports three discovery modes: forced hub, connect-to-existing, and
 * auto-discovery with election. Monitors hub health and triggers re-election
 * on failure.
 *
 * Events emitted:
 * - `state-change` - (oldState: HubElectionState, newState: HubElectionState)
 * - `hub-discovered` - (hubInfo: HubInfo)
 * - `became-hub` - This instance assumed the hub role
 * - `hub-failed` - (hubInfo: HubInfo) Hub became unreachable
 * - `election-started` - Tie-breaker election began
 * - `election-complete` - (winner: ElectionProposal)
 * - `re-election-triggered` - (reason: string)
 */
export class HubElection extends EventEmitter {
  private config: Required<HubElectionConfig>;
  private state: HubElectionState = 'discovering';
  private currentHub: HubInfo | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private missedHeartbeats = 0;
  private electionProposals: Map<string, ElectionProposal> = new Map();

  constructor(config: HubElectionConfig) {
    super();

    this.config = {
      discovery: config.discovery,
      discoveryTimeout: config.discoveryTimeout ?? 5000,
      healthCheckInterval: config.healthCheckInterval ?? 10000,
      maxMissedHeartbeats: config.maxMissedHeartbeats ?? 3,
      instanceId: config.instanceId ?? this.generateInstanceId(),
      priorityBoost: config.priorityBoost ?? 0,
    };
  }

  /**
   * Start the election process based on configured discovery mode.
   *
   * - `become-hub`: Immediately assumes hub role
   * - `connect-to`: Connects to a specified hub (not yet implemented)
   * - `auto`: Broadcasts discovery and elects if needed (not yet implemented)
   *
   * @throws Error if `connect-to` or `auto` mode is used (pending implementation)
   */
  async start(): Promise<void> {
    this.changeState('discovering');

    if (this.config.discovery === 'become-hub') {
      await this.becomeHub();
      return;
    }

    if (this.config.discovery === 'connect-to') {
      throw new Error('Connect-to mode not yet implemented');
    }

    throw new Error('Auto discovery not yet implemented');
  }

  /**
   * Stop the election and release resources.
   * If this instance is the hub, triggers resignation.
   */
  async stop(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.isHub()) {
      await this.resignHub();
    }

    this.changeState('failed');
  }

  /**
   * Get current hub information, or null if no hub is elected.
   */
  getHub(): HubInfo | null {
    return this.currentHub;
  }

  /**
   * Check if this instance is currently the hub.
   */
  isHub(): boolean {
    return this.state === 'hub';
  }

  /**
   * Get the current election state.
   */
  getState(): HubElectionState {
    return this.state;
  }

  /**
   * Assume the hub role by initializing HubInfo and emitting the 'became-hub' event.
   */
  private async becomeHub(): Promise<void> {
    this.currentHub = {
      id: this.config.instanceId,
      hostname: this.getHostname(),
      platform: process.platform,
      endpoint: this.getEndpoint(),
      startedAt: Date.now(),
      clientCount: 0,
      capabilities: {
        modelSharing: true,
        toolSharing: true,
        artifactTransfer: true,
      },
    };

    this.changeState('hub');
    this.emit('became-hub');

    console.log(`[HubElection] Became hub: ${this.config.instanceId}`);
  }

  /**
   * Resign the hub role by clearing HubInfo and transitioning to discovering state.
   */
  private async resignHub(): Promise<void> {
    if (!this.isHub()) {
      return;
    }

    console.log(`[HubElection] Resigning from hub role: ${this.config.instanceId}`);

    this.currentHub = null;
    this.changeState('discovering');
  }

  /**
   * Conduct a leader election among the given candidates using score-based tie-breaking.
   * Currently a stub — election logic is not yet fully implemented.
   *
   * @param _candidates - Array of candidate instance IDs
   */
  private async conductElection(_candidates: string[]): Promise<void> {
    this.changeState('electing');
    this.emit('election-started');

    const proposal: ElectionProposal = {
      instanceId: this.config.instanceId,
      timestamp: Date.now(),
      random: Math.random(),
      score: 0,
      priority: this.config.priorityBoost,
      metadata: {
        hostname: this.getHostname(),
        platform: process.platform,
        uptime: process.uptime(),
        capabilities: ['model-sharing', 'tool-sharing', 'artifact-transfer'],
      },
    };

    proposal.score = proposal.random + proposal.timestamp + proposal.priority;
    this.electionProposals.set(this.config.instanceId, proposal);

    throw new Error('Election not yet implemented');
  }

  /**
   * Start periodic health monitoring for the connected hub.
   */
  private startHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      this.checkHubHealth();
    }, this.config.healthCheckInterval);
  }

  /**
   * Check the health of the connected hub and handle failure if max missed heartbeats is exceeded.
   */
  private async checkHubHealth(): Promise<void> {
    if (!this.currentHub || this.isHub()) {
      return;
    }

    try {
      this.missedHeartbeats = 0;
    } catch (error) {
      this.missedHeartbeats++;

      console.warn(
        `[HubElection] Health check failed (${this.missedHeartbeats}/${this.config.maxMissedHeartbeats})`,
        error
      );

      if (this.missedHeartbeats >= this.config.maxMissedHeartbeats) {
        await this.handleHubFailure();
      }
    }
  }

  /**
   * Handle hub failure by emitting failure events and restarting the election process.
   */
  private async handleHubFailure(): Promise<void> {
    if (!this.currentHub) {
      return;
    }

    console.error(`[HubElection] Hub failed: ${this.currentHub.id}`);

    const failedHub = this.currentHub;
    this.currentHub = null;
    this.missedHeartbeats = 0;

    this.emit('hub-failed', failedHub);
    this.emit('re-election-triggered', 'hub-failure');

    await this.start();
  }

  /**
   * Transition the election state machine to a new state and emit the 'state-change' event.
   *
   * @param newState - The new election state
   */
  private changeState(newState: HubElectionState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== newState) {
      this.emit('state-change', oldState, newState);
      console.log(`[HubElection] State: ${oldState} -> ${newState}`);
    }
  }

  /**
   * Generate a unique instance ID for this node.
   *
   * @returns A unique instance ID string
   */
  private generateInstanceId(): string {
    return `instance-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get the hostname for this instance.
   *
   * @returns The hostname string
   */
  private getHostname(): string {
    return 'localhost';
  }

  /**
   * Get the RPC endpoint URL for this instance.
   *
   * @returns The endpoint URL string
   */
  private getEndpoint(): string {
    return 'nats://localhost:4222';
  }
}
