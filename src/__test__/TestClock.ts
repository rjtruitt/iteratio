/**
 * Controllable clock for testing timing-dependent behavior.
 * Replaces setTimeout/setInterval/Date.now with deterministic versions.
 */

interface ScheduledTimer {
  id: number;
  callback: () => void;
  triggerAt: number;
  interval?: number;
  type: 'timeout' | 'interval';
}

export class TestClock {
  private currentTime: number;
  private timers: ScheduledTimer[] = [];
  private nextId = 1;
  private originalSetTimeout = globalThis.setTimeout;
  private originalSetInterval = globalThis.setInterval;
  private originalClearTimeout = globalThis.clearTimeout;
  private originalClearInterval = globalThis.clearInterval;
  private originalDateNow = Date.now;
  private installed = false;

  constructor(startTime: number = 0) {
    this.currentTime = startTime;
  }

  get now(): number {
    return this.currentTime;
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;

    const self = this;

    (globalThis as any).setTimeout = (cb: () => void, ms: number = 0) => {
      const id = self.nextId++;
      self.timers.push({ id, callback: cb, triggerAt: self.currentTime + ms, type: 'timeout' });
      return id;
    };

    (globalThis as any).setInterval = (cb: () => void, ms: number) => {
      const id = self.nextId++;
      self.timers.push({ id, callback: cb, triggerAt: self.currentTime + ms, interval: ms, type: 'interval' });
      return id;
    };

    (globalThis as any).clearTimeout = (id: number) => {
      self.timers = self.timers.filter(t => t.id !== id);
    };

    (globalThis as any).clearInterval = (id: number) => {
      self.timers = self.timers.filter(t => t.id !== id);
    };

    Date.now = () => self.currentTime;
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    globalThis.setTimeout = this.originalSetTimeout;
    globalThis.setInterval = this.originalSetInterval;
    globalThis.clearTimeout = this.originalClearTimeout;
    globalThis.clearInterval = this.originalClearInterval;
    Date.now = this.originalDateNow;
  }

  advance(ms: number): void {
    const targetTime = this.currentTime + ms;
    while (true) {
      const next = this.getNextTimer(targetTime);
      if (!next) break;

      this.currentTime = next.triggerAt;
      this.timers = this.timers.filter(t => t.id !== next.id);

      if (next.type === 'interval' && next.interval) {
        this.timers.push({
          ...next,
          id: this.nextId++,
          triggerAt: this.currentTime + next.interval,
        });
      }

      next.callback();
    }
    this.currentTime = targetTime;
  }

  async advanceAsync(ms: number): Promise<void> {
    const targetTime = this.currentTime + ms;
    while (true) {
      const next = this.getNextTimer(targetTime);
      if (!next) break;

      this.currentTime = next.triggerAt;
      this.timers = this.timers.filter(t => t.id !== next.id);

      if (next.type === 'interval' && next.interval) {
        this.timers.push({
          ...next,
          id: this.nextId++,
          triggerAt: this.currentTime + next.interval,
        });
      }

      next.callback();
      await Promise.resolve();
    }
    this.currentTime = targetTime;
  }

  advanceTo(time: number): void {
    if (time < this.currentTime) throw new Error('Cannot go back in time');
    this.advance(time - this.currentTime);
  }

  tick(): void {
    this.advance(1);
  }

  runAllTimers(): void {
    let safety = 1000;
    while (this.timers.length > 0 && safety-- > 0) {
      const next = this.timers.reduce((a, b) => a.triggerAt < b.triggerAt ? a : b);
      this.advanceTo(next.triggerAt);
    }
  }

  private getNextTimer(beforeTime: number): ScheduledTimer | null {
    const eligible = this.timers.filter(t => t.triggerAt <= beforeTime);
    if (eligible.length === 0) return null;
    return eligible.reduce((a, b) => a.triggerAt < b.triggerAt ? a : b);
  }

  reset(): void {
    this.timers = [];
    this.currentTime = 0;
    this.nextId = 1;
  }
}
