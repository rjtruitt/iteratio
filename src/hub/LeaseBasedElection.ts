import { EventEmitter } from 'events';
import {
  Lease,
  LeaseState,
  LeaseBasedElectionConfig,
  ILeaseBackend,
  LeaseAcquisitionResult,
  LeaseRenewalResult,
} from './LeaseTypes.js';

export type { Lease, LeaseAcquisitionResult, LeaseRenewalResult, ILeaseBackend, LeaseBasedElectionConfig, LeaseState } from './LeaseTypes.js';
export { FencingTokenGuard } from './FencingTokenGuard.js';
export { EtcdLeaseBackend, RedisLeaseBackend } from './LeaseBackends.js';

/**
 * Lease-based hub election providing split-brain-safe leadership.
 *
 * Only one instance holds the lease at any time. The leader must continuously
 * renew; if renewal fails, a grace period provides tolerance for transient
 * network issues before leadership is forfeited and re-election begins.
 *
 * Events emitted:
 * - `state-change` - (oldState: LeaseState, newState: LeaseState)
 * - `lease-acquired` - (lease: Lease)
 * - `lease-renewed` - (expiresAt: number)
 * - `lease-lost` - (reason: string)
 * - `lease-expired` - (oldLease: Lease | null)
 * - `lease-released` - (lease: Lease)
 * - `grace-period-started` - (remainingMs: number)
 * - `grace-period-ended` - (recovered: boolean)
 * - `no-leader` - No active lease exists
 * - `leader-changed` - (lease: Lease) Another instance became leader
 */
export class LeaseBasedElection extends EventEmitter {
  private config: Required<LeaseBasedElectionConfig>;
  private state: LeaseState = 'idle';
  private currentLease: Lease | null = null;
  private renewalTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private retryCount = 0;
  private leaseKey = 'hub-lease';

  constructor(config: LeaseBasedElectionConfig) {
    super();

    this.config = {
      instanceId: config.instanceId,
      backend: config.backend,
      leaseTTL: config.leaseTTL ?? 30000,
      renewalInterval: config.renewalInterval ?? (config.leaseTTL ?? 30000) / 3,
      gracePeriod: config.gracePeriod ?? (config.leaseTTL ?? 30000) / 2,
      autoCampaign: config.autoCampaign ?? false,
      autoRetry: config.autoRetry ?? true,
      maxRetries: config.maxRetries ?? Infinity,
      retryBackoff: config.retryBackoff ?? 2000,
    };
  }

  /**
   * Start the election process.
   * Registers a backend watcher and optionally campaigns immediately.
   */
  async start(): Promise<void> {
    console.log(`[LeaseBasedElection] Starting for instance ${this.config.instanceId}`);

    await this.config.backend.watch(this.leaseKey, (lease) => {
      this.handleLeaseChange(lease);
    });

    if (this.config.autoCampaign) {
      await this.campaign();
    }
  }

  /**
   * Stop the election, releasing the lease if currently leader.
   */
  async stop(): Promise<void> {
    console.log(`[LeaseBasedElection] Stopping for instance ${this.config.instanceId}`);

    this.stopRenewal();
    this.stopGracePeriod();

    if (this.isLeader()) {
      await this.releaseLease();
    }

    await this.config.backend.close();

    this.changeState('idle');
  }

  /**
   * Campaign for leadership by attempting to acquire the lease.
   *
   * @returns true if leadership was won, false otherwise
   */
  async campaign(): Promise<boolean> {
    console.log(`[LeaseBasedElection] Campaigning for lease: ${this.leaseKey}`);

    this.changeState('campaigning');

    try {
      const result = await this.config.backend.acquire(
        this.leaseKey,
        this.config.instanceId,
        this.config.leaseTTL,
        { hostname: this.getHostname(), startedAt: Date.now() }
      );

      if (result.acquired && result.lease) {
        this.currentLease = result.lease;
        this.changeState('leader');
        this.emit('lease-acquired', result.lease);
        this.startRenewal();
        this.retryCount = 0;

        console.log(
          `[LeaseBasedElection] Acquired lease ${result.lease.id} with fencing token ${result.lease.fencingToken}`
        );

        return true;
      } else {
        console.log(
          `[LeaseBasedElection] Failed to acquire lease: ${result.reason} (current holder: ${result.currentHolder})`
        );

        if (this.config.autoRetry && this.retryCount < this.config.maxRetries) {
          this.retryCount++;
          console.log(
            `[LeaseBasedElection] Retrying campaign in ${this.config.retryBackoff}ms (attempt ${this.retryCount})`
          );

          setTimeout(() => {
            this.campaign().catch((err) => {
              console.error('[LeaseBasedElection] Campaign retry failed:', err);
            });
          }, this.config.retryBackoff);
        }

        return false;
      }
    } catch (error) {
      console.error('[LeaseBasedElection] Campaign error:', error);
      this.changeState('idle');
      throw error;
    }
  }

  /**
   * Voluntarily release the lease (e.g., during graceful shutdown).
   */
  async releaseLease(): Promise<void> {
    if (!this.isLeader() || !this.currentLease) {
      console.warn('[LeaseBasedElection] Cannot release lease - not leader');
      return;
    }

    console.log(`[LeaseBasedElection] Releasing lease ${this.currentLease.id}`);

    this.stopRenewal();

    try {
      const released = await this.config.backend.release(
        this.leaseKey,
        this.config.instanceId
      );

      if (released) {
        this.emit('lease-released', this.currentLease);
        this.currentLease = null;
        this.changeState('idle');
      } else {
        console.warn('[LeaseBasedElection] Failed to release lease');
      }
    } catch (error) {
      console.error('[LeaseBasedElection] Error releasing lease:', error);
    }
  }

  /**
   * Whether this instance currently considers itself the leader.
   * True during leader, renewing, and grace states.
   */
  isLeader(): boolean {
    return this.state === 'leader' || this.state === 'renewing' || this.state === 'grace';
  }

  /**
   * Get the current lease held by this instance, or null if not leader.
   */
  getLease(): Lease | null {
    return this.currentLease;
  }

  /**
   * Get the current state machine state.
   */
  getState(): LeaseState {
    return this.state;
  }

  /**
   * Get the current fencing token, or null if not leader.
   * All state-mutating operations should include this token.
   */
  getFencingToken(): number | null {
    return this.currentLease?.fencingToken ?? null;
  }

  /**
   * Query the backend for the current leader's instance ID.
   */
  async getCurrentLeader(): Promise<string | null> {
    const lease = await this.config.backend.getLease(this.leaseKey);
    return lease?.holderId ?? null;
  }


  /**
   * Start the periodic lease renewal interval.
   */
  private startRenewal(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
    }

    console.log(
      `[LeaseBasedElection] Starting lease renewal (interval: ${this.config.renewalInterval}ms)`
    );

    this.renewalTimer = setInterval(async () => {
      await this.renewLease();
    }, this.config.renewalInterval);
  }

  /**
   * Stop the periodic lease renewal interval.
   */
  private stopRenewal(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  /**
   * Attempt to renew the current lease with the backend.
   * On failure, enters the grace period for transient error tolerance.
   */
  private async renewLease(): Promise<void> {
    if (!this.isLeader() || !this.currentLease) {
      console.warn('[LeaseBasedElection] Cannot renew lease - not leader');
      this.stopRenewal();
      return;
    }

    this.changeState('renewing');

    try {
      const result = await this.config.backend.renew(
        this.leaseKey,
        this.config.instanceId,
        this.config.leaseTTL
      );

      if (result.renewed && result.expiresAt) {
        this.currentLease.expiresAt = result.expiresAt;
        this.changeState('leader');
        this.emit('lease-renewed', result.expiresAt);

        console.log(
          `[LeaseBasedElection] Lease renewed (expires: ${new Date(result.expiresAt).toISOString()})`
        );
      } else {
        console.warn(`[LeaseBasedElection] Lease renewal failed: ${result.reason}`);

        this.stopRenewal();
        this.enterGracePeriod();
      }
    } catch (error) {
      console.error('[LeaseBasedElection] Lease renewal error:', error);
      this.stopRenewal();
      this.enterGracePeriod();
    }
  }


  /**
   * Enter the grace period after a lease renewal failure.
   * Attempts to re-establish the lease within the grace window before forfeiting leadership.
   */
  private enterGracePeriod(): void {
    console.log(`[LeaseBasedElection] Entering grace period (${this.config.gracePeriod}ms)`);

    this.changeState('grace');
    this.emit('grace-period-started', this.config.gracePeriod);

    let attempts = 0;
    const maxAttempts = Math.floor(this.config.gracePeriod / 1000);

    const tryRenew = async () => {
      attempts++;

      try {
        const result = await this.config.backend.renew(
          this.leaseKey,
          this.config.instanceId,
          this.config.leaseTTL
        );

        if (result.renewed && result.expiresAt) {
          console.log('[LeaseBasedElection] Recovered from grace period - lease renewed');

          this.stopGracePeriod();
          if (this.currentLease) {
            this.currentLease.expiresAt = result.expiresAt;
          }
          this.changeState('leader');
          this.emit('grace-period-ended', true);
          this.startRenewal();
        } else if (attempts < maxAttempts) {
          setTimeout(tryRenew, 1000);
        } else {
          console.error('[LeaseBasedElection] Grace period expired - lost leadership');

          this.stopGracePeriod();
          this.handleLeaseExpiration();
          this.emit('grace-period-ended', false);
        }
      } catch (error) {
        console.error('[LeaseBasedElection] Grace period renewal error:', error);

        if (attempts < maxAttempts) {
          setTimeout(tryRenew, 1000);
        } else {
          this.stopGracePeriod();
          this.handleLeaseExpiration();
          this.emit('grace-period-ended', false);
        }
      }
    };

    tryRenew();

    this.graceTimer = setTimeout(() => {
      console.error('[LeaseBasedElection] Grace period timeout - lost leadership');
      this.handleLeaseExpiration();
    }, this.config.gracePeriod);
  }

  /**
   * Stop the grace period timer.
   */
  private stopGracePeriod(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /**
   * Handle lease expiration by releasing the current lease and optionally re-campaigning.
   */
  private handleLeaseExpiration(): void {
    console.log('[LeaseBasedElection] Lease expired');

    const oldLease = this.currentLease;
    this.currentLease = null;

    this.changeState('expired');
    this.emit('lease-expired', oldLease);
    this.emit('lease-lost', 'expired');

    if (this.config.autoRetry && this.retryCount < this.config.maxRetries) {
      this.retryCount++;
      console.log(
        `[LeaseBasedElection] Re-campaigning after expiration (attempt ${this.retryCount})`
      );

      setTimeout(() => {
        this.campaign().catch((err) => {
          console.error('[LeaseBasedElection] Re-campaign failed:', err);
        });
      }, this.config.retryBackoff);
    } else {
      this.changeState('idle');
    }
  }


  /**
   * Handle a lease change notification from the backend watcher.
   * Emits 'no-leader' or 'leader-changed' events as appropriate.
   *
   * @param lease - The updated lease, or null if no lease exists
   */
  private handleLeaseChange(lease: Lease | null): void {
    console.log('[LeaseBasedElection] Lease changed:', lease);

    if (!lease) {
      this.emit('no-leader');
    } else if (lease.holderId === this.config.instanceId) {
    } else {
      this.emit('leader-changed', lease);
    }
  }


  private changeState(newState: LeaseState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== newState) {
      this.emit('state-change', oldState, newState);
      console.log(`[LeaseBasedElection] State: ${oldState} -> ${newState}`);
    }
  }

  private getHostname(): string {
    return 'localhost';
  }
}
