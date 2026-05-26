import { ILeaseBackend } from './LeaseTypes.js';

/**
 * Guards state-mutating operations behind fencing token validation.
 *
 * After a leadership change, the old leader's in-flight writes could corrupt
 * state if they arrive after the new leader has begun. The fencing token
 * (a monotonically increasing counter) ensures that only the current leader's
 * operations are accepted.
 *
 * @example
 * ```typescript
 * const guard = new FencingTokenGuard(backend);
 * await guard.executeWithToken('hub-lease', currentToken, async () => {
 *   await database.update(record);
 * });
 * ```
 */
export class FencingTokenGuard {
  constructor(private backend: ILeaseBackend) {}

  /**
   * Execute an operation only if the provided fencing token matches the
   * current lease's token.
   *
   * @param leaseKey - The lease slot key to validate against
   * @param fencingToken - The caller's fencing token
   * @param operation - The state-mutating operation to execute
   * @returns The operation's return value
   * @throws Error if no lease exists or the token is stale
   */
  async executeWithToken<T>(
    leaseKey: string,
    fencingToken: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const lease = await this.backend.getLease(leaseKey);

    if (!lease) {
      throw new Error('No current lease - cannot execute operation');
    }

    if (lease.fencingToken !== fencingToken) {
      throw new Error(
        `Fencing token mismatch: expected ${lease.fencingToken}, got ${fencingToken} (stale leader)`
      );
    }

    return await operation();
  }
}
