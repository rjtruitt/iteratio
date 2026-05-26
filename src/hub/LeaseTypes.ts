/**
 * Represents an active lease granting leadership to a single instance.
 * Includes a monotonically increasing fencing token to prevent stale writes.
 */
export interface Lease {
  /** Unique lease identifier. */
  id: string;

  /** Instance ID that currently holds this lease. */
  holderId: string;

  /** Unix timestamp when the lease was acquired. */
  acquiredAt: number;

  /** Unix timestamp when the lease expires (acquiredAt + ttl). */
  expiresAt: number;

  /** Lease time-to-live in milliseconds. */
  ttl: number;

  /** Monotonically increasing token for stale-write prevention. */
  fencingToken: number;

  /** Arbitrary metadata attached at acquisition time. */
  metadata?: Record<string, any>;
}

/**
 * Result of a lease acquisition attempt.
 */
export interface LeaseAcquisitionResult {
  /** Whether the lease was successfully acquired. */
  acquired: boolean;

  /** Lease details (present when acquired is true). */
  lease?: Lease;

  /** ID of the current holder (present when acquired is false). */
  currentHolder?: string;

  /** Human-readable failure reason (present when acquired is false). */
  reason?: string;
}

/**
 * Result of a lease renewal attempt.
 */
export interface LeaseRenewalResult {
  /** Whether the lease was successfully renewed. */
  renewed: boolean;

  /** New expiration timestamp (present when renewed is true). */
  expiresAt?: number;

  /** Human-readable failure reason (present when renewed is false). */
  reason?: string;
}

/**
 * Backend abstraction for lease storage and coordination.
 *
 * Implementations must provide atomic acquire (CAS semantics), renewal,
 * release, query, and watch capabilities. Concrete implementations may
 * target etcd, Redis, Consul, or in-memory stores.
 */
export interface ILeaseBackend {
  /**
   * Atomically acquire a lease. Only succeeds if no valid lease exists.
   *
   * @param leaseKey - The key identifying this election's lease slot
   * @param holderId - The instance attempting to acquire
   * @param ttl - Time-to-live in milliseconds
   * @param metadata - Optional metadata to attach to the lease
   */
  acquire(
    leaseKey: string,
    holderId: string,
    ttl: number,
    metadata?: Record<string, any>
  ): Promise<LeaseAcquisitionResult>;

  /**
   * Renew an existing lease, extending its TTL. Only succeeds if the
   * caller is the current holder and the lease has not expired.
   *
   * @param leaseKey - The lease slot key
   * @param holderId - The instance requesting renewal
   * @param ttl - New TTL in milliseconds
   */
  renew(leaseKey: string, holderId: string, ttl: number): Promise<LeaseRenewalResult>;

  /**
   * Voluntarily release a lease. Only succeeds if caller is the current holder.
   *
   * @param leaseKey - The lease slot key
   * @param holderId - The instance releasing the lease
   */
  release(leaseKey: string, holderId: string): Promise<boolean>;

  /**
   * Get the current lease, or null if none exists or it has expired.
   *
   * @param leaseKey - The lease slot key
   */
  getLease(leaseKey: string): Promise<Lease | null>;

  /**
   * Watch for lease changes. The callback fires on acquisition,
   * renewal, expiration, and release events.
   *
   * @param leaseKey - The lease slot key to watch
   * @param callback - Invoked with the new lease state (or null on release/expiry)
   */
  watch(leaseKey: string, callback: (lease: Lease | null) => void): Promise<void>;

  /**
   * Close the backend connection and release resources.
   */
  close(): Promise<void>;
}

/**
 * Configuration for lease-based election.
 */
export interface LeaseBasedElectionConfig {
  /** Unique instance ID (must be unique across the cluster). */
  instanceId: string;

  /** Lease backend implementation. */
  backend: ILeaseBackend;

  /** Lease TTL in milliseconds (default: 30000). */
  leaseTTL?: number;

  /** Interval between renewal attempts in milliseconds (default: ttl / 3). */
  renewalInterval?: number;

  /**
   * Grace period after renewal failure before losing leadership (default: ttl / 2).
   * Prevents flapping during transient network issues.
   */
  gracePeriod?: number;

  /** Whether to begin campaigning immediately on start (default: false). */
  autoCampaign?: boolean;

  /** Whether to re-campaign automatically after lease loss (default: true). */
  autoRetry?: boolean;

  /** Maximum number of retry attempts (default: Infinity). */
  maxRetries?: number;

  /** Delay between retry attempts in milliseconds (default: 2000). */
  retryBackoff?: number;
}

/**
 * States in the lease-based election state machine.
 */
export type LeaseState =
  | 'idle'           // Not campaigning
  | 'campaigning'    // Trying to acquire lease
  | 'leader'         // Holding lease
  | 'renewing'       // Renewing lease
  | 'grace'          // In grace period (lease renewal failed)
  | 'expired';       // Lease expired, no longer leader
