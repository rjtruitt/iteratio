/**
 * Deterministic async scheduler for race condition tests.
 * Controls ordering of async operations to reproduce race conditions reliably.
 */

type DeferredOperation = {
  id: string;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
  label: string;
};

export class TestScheduler {
  private pending: DeferredOperation[] = [];
  private executed: string[] = [];
  private barriers = new Map<string, { count: number; waiting: Array<() => void> }>();

  get pendingCount(): number {
    return this.pending.length;
  }

  get executedOperations(): string[] {
    return [...this.executed];
  }

  defer<T = void>(label: string): Promise<T> {
    const id = `${label}-${this.pending.length}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ id, resolve: resolve as (value?: unknown) => void, reject, label });
    });
  }

  resolveNext(value?: unknown): void {
    const op = this.pending.shift();
    if (!op) throw new Error('No pending operations to resolve');
    this.executed.push(op.label);
    op.resolve(value);
  }

  rejectNext(reason?: unknown): void {
    const op = this.pending.shift();
    if (!op) throw new Error('No pending operations to reject');
    this.executed.push(`${op.label}:rejected`);
    op.reject(reason);
  }

  resolve(label: string, value?: unknown): void {
    const idx = this.pending.findIndex(op => op.label === label);
    if (idx === -1) throw new Error(`No pending operation with label: ${label}`);
    const [op] = this.pending.splice(idx, 1);
    this.executed.push(op.label);
    op.resolve(value);
  }

  reject(label: string, reason?: unknown): void {
    const idx = this.pending.findIndex(op => op.label === label);
    if (idx === -1) throw new Error(`No pending operation with label: ${label}`);
    const [op] = this.pending.splice(idx, 1);
    this.executed.push(`${op.label}:rejected`);
    op.reject(reason);
  }

  resolveAll(value?: unknown): void {
    while (this.pending.length > 0) {
      this.resolveNext(value);
    }
  }

  rejectAll(reason?: unknown): void {
    while (this.pending.length > 0) {
      this.rejectNext(reason);
    }
  }

  resolveInOrder(...labels: string[]): void {
    for (const label of labels) {
      this.resolve(label);
    }
  }

  hasPending(label: string): boolean {
    return this.pending.some(op => op.label === label);
  }

  createBarrier(name: string, count: number): void {
    this.barriers.set(name, { count, waiting: [] });
  }

  async waitAtBarrier(name: string): Promise<void> {
    const barrier = this.barriers.get(name);
    if (!barrier) throw new Error(`Unknown barrier: ${name}`);

    barrier.count--;
    if (barrier.count <= 0) {
      for (const resolve of barrier.waiting) {
        resolve();
      }
      barrier.waiting = [];
    } else {
      await new Promise<void>(resolve => barrier.waiting.push(resolve));
    }
  }

  releaseBarrier(name: string): void {
    const barrier = this.barriers.get(name);
    if (!barrier) return;
    for (const resolve of barrier.waiting) {
      resolve();
    }
    barrier.waiting = [];
    this.barriers.delete(name);
  }

  reset(): void {
    for (const op of this.pending) {
      op.reject(new Error('TestScheduler reset'));
    }
    this.pending = [];
    this.executed = [];
    this.barriers.clear();
  }
}
