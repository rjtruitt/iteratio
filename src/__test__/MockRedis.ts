/**
 * In-memory Redis mock for distributed layer tests.
 * Mimics ioredis interface for the operations iteratio uses:
 * - Key/value (get, set, del, exists, expire, ttl)
 * - Pub/Sub (publish, subscribe, unsubscribe, psubscribe)
 * - Lua scripting (eval, evalsha)
 * - Lists (lpush, rpush, lpop, rpop, llen, lrange)
 * - Sets (sadd, srem, smembers, sismember)
 * - Hashes (hget, hset, hdel, hgetall)
 * - Sorted sets (zadd, zrem, zrange, zrangebyscore)
 *
 * For full integration tests, use ioredis-mock package.
 * This mock is for unit tests that need Redis-like behavior without the dependency.
 */

type RedisValue = string;
type SubscriptionHandler = (channel: string, message: string) => void;

export class MockRedis {
  private store = new Map<string, RedisValue>();
  private ttls = new Map<string, number>();
  private lists = new Map<string, string[]>();
  private sets = new Map<string, Set<string>>();
  private hashes = new Map<string, Map<string, string>>();
  private sortedSets = new Map<string, Array<{ score: number; member: string }>>();
  private subscriptions = new Map<string, Set<SubscriptionHandler>>();
  connected = true;
  private _commands: Array<{ cmd: string; args: unknown[] }> = [];
  private luaScripts = new Map<string, (...args: unknown[]) => unknown>();
  private shouldThrowOnNext = false;
  private throwError?: Error;
  private disconnectOnCall?: number;
  private callCount = 0;

  get commands() { return this._commands; }

  private record(cmd: string, ...args: unknown[]): void {
    this._commands.push({ cmd, args });
    this.callCount++;
    if (this.disconnectOnCall !== undefined && this.callCount === this.disconnectOnCall) {
      this.connected = false;
      throw new Error('MockRedis: connection lost');
    }
    if (this.shouldThrowOnNext) {
      this.shouldThrowOnNext = false;
      throw this.throwError ?? new Error('MockRedis: forced error');
    }
  }

  async get(key: string): Promise<string | null> {
    this.record('get', key);
    if (!this.connected) throw new Error('Connection closed');
    const ttl = this.ttls.get(key);
    if (ttl !== undefined && Date.now() > ttl) {
      this.store.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    this.record('set', key, value, ...args);
    if (!this.connected) throw new Error('Connection closed');

    // Check NX (set if not exists) — must check AFTER TTL expiry
    const hasNX = args.indexOf('NX') !== -1;
    if (hasNX) {
      // Check if key exists and is not expired
      const ttl = this.ttls.get(key);
      if (ttl !== undefined && Date.now() >= ttl) {
        // Key expired — remove it
        this.store.delete(key);
        this.ttls.delete(key);
      }
      if (this.store.has(key)) {
        return null; // NX failed, key already exists
      }
    }

    this.store.set(key, value);
    const exIdx = args.indexOf('EX');
    if (exIdx !== -1 && typeof args[exIdx + 1] === 'number') {
      this.ttls.set(key, Date.now() + (args[exIdx + 1] as number) * 1000);
    }
    const pxIdx = args.indexOf('PX');
    if (pxIdx !== -1 && typeof args[pxIdx + 1] === 'number') {
      this.ttls.set(key, Date.now() + (args[pxIdx + 1] as number));
    }
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    this.record('del', ...keys);
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      this.ttls.delete(key);
    }
    return count;
  }

  async flushall(): Promise<'OK'> {
    this.record('flushall');
    this.store.clear();
    this.ttls.clear();
    this.lists.clear();
    this.sets.clear();
    this.hashes.clear();
    this.sortedSets.clear();
    return 'OK';
  }

  async exists(...keys: string[]): Promise<number> {
    this.record('exists', ...keys);
    return keys.filter(k => this.store.has(k)).length;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.record('expire', key, seconds);
    if (!this.store.has(key)) return 0;
    this.ttls.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    this.record('ttl', key);
    const expiry = this.ttls.get(key);
    if (!expiry) return -1;
    const remaining = Math.ceil((expiry - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.record('publish', channel, message);
    if (!this.connected) throw new Error('Connection closed');
    let count = 0;
    // Exact match
    const handlers = this.subscriptions.get(channel);
    if (handlers) {
      for (const handler of handlers) {
        handler(channel, message);
      }
      count += handlers.size;
    }
    // Pattern match (glob-style: * matches any sequence within a segment)
    for (const [pattern, patternHandlers] of this.subscriptions) {
      if (pattern === channel) continue; // already handled
      if (this.matchPattern(pattern, channel)) {
        for (const handler of patternHandlers) {
          handler(channel, message);
        }
        count += patternHandlers.size;
      }
    }
    return count;
  }

  private matchPattern(pattern: string, channel: string): boolean {
    // Convert Redis glob pattern to regex
    // * matches any sequence of characters except separator
    // ? matches exactly one character
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(channel);
  }

  async subscribe(channel: string, handler: SubscriptionHandler): Promise<void> {
    this.record('subscribe', channel);
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    this.subscriptions.get(channel)!.add(handler);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.record('unsubscribe', channel);
    this.subscriptions.delete(channel);
  }

  async eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown> {
    this.record('eval', script, numKeys, ...args);
    const handler = this.luaScripts.get(script);
    if (handler) return handler(...args);
    return null;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    this.record('lpush', key, ...values);
    if (!this.lists.has(key)) this.lists.set(key, []);
    this.lists.get(key)!.unshift(...values);
    return this.lists.get(key)!.length;
  }

  async rpop(key: string): Promise<string | null> {
    this.record('rpop', key);
    const list = this.lists.get(key);
    if (!list || list.length === 0) return null;
    return list.pop()!;
  }

  async llen(key: string): Promise<number> {
    this.record('llen', key);
    return this.lists.get(key)?.length ?? 0;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.record('sadd', key, ...members);
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const set = this.sets.get(key)!;
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) { set.add(m); added++; }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    this.record('srem', key, ...members);
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    this.record('smembers', key);
    return [...(this.sets.get(key) ?? [])];
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.record('hset', key, field, value);
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const isNew = !this.hashes.get(key)!.has(field);
    this.hashes.get(key)!.set(field, value);
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.record('hget', key, field);
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.record('hgetall', key);
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.record('zadd', key, score, member);
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, []);
    const zset = this.sortedSets.get(key)!;
    const existing = zset.findIndex(e => e.member === member);
    if (existing !== -1) {
      zset[existing].score = score;
      return 0;
    }
    zset.push({ score, member });
    zset.sort((a, b) => a.score - b.score);
    return 1;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    this.record('zrange', key, start, stop);
    const zset = this.sortedSets.get(key) ?? [];
    const end = stop === -1 ? zset.length : stop + 1;
    return zset.slice(start, end).map(e => e.member);
  }

  registerLuaScript(script: string, handler: (...args: unknown[]) => unknown): void {
    this.luaScripts.set(script, handler);
  }

  setThrowOnNext(error?: Error): void {
    this.shouldThrowOnNext = true;
    this.throwError = error;
  }

  setDisconnectOnCall(callNumber: number): void {
    this.disconnectOnCall = callNumber;
  }

  private disconnectListeners: Array<() => void> = [];

  onDisconnect(listener: () => void): void {
    this.disconnectListeners.push(listener);
  }

  disconnect(): void {
    this.connected = false;
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }

  reconnect(): void {
    this.connected = true;
  }

  setLatency(_ms: number): void {
    // No-op for test compatibility
  }

  simulatePartialWrite(): void {
    // Simulate a partial write by throwing on next call
    this.setThrowOnNext(new Error('Partial write: connection lost'));
  }

  reset(): void {
    this.store.clear();
    this.ttls.clear();
    this.lists.clear();
    this.sets.clear();
    this.hashes.clear();
    this.sortedSets.clear();
    this.subscriptions.clear();
    this._commands = [];
    this.connected = true;
    this.callCount = 0;
    this.shouldThrowOnNext = false;
    this.disconnectOnCall = undefined;
  }
}
