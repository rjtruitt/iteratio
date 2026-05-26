/**
 * Mock NATS client for NATSTransport tests.
 * Mimics the nats.js client interface.
 */

type NatsHandler = (err: Error | null, msg: NatsMessage) => void;
type NatsSubscription = { unsubscribe: () => void; subject: string };

export interface NatsMessage {
  subject: string;
  data: Uint8Array;
  reply?: string;
  headers?: Map<string, string[]>;
  respond(data: Uint8Array): void;
}

export class MockNatsClient {
  private connected = false;
  private subscriptions = new Map<string, Set<NatsHandler>>();
  private _published: Array<{ subject: string; data: Uint8Array; reply?: string }> = [];
  private shouldThrowOnConnect = false;
  private shouldThrowOnPublish = false;

  get published() { return this._published; }
  get isConnected() { return this.connected; }

  async connect(opts?: { servers?: string | string[]; token?: string }): Promise<MockNatsClient> {
    if (this.shouldThrowOnConnect) {
      throw new Error('MockNats: connection refused');
    }
    this.connected = true;
    return this;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.subscriptions.clear();
  }

  publish(subject: string, data: Uint8Array, opts?: { reply?: string }): void {
    if (!this.connected) throw new Error('MockNats: not connected');
    if (this.shouldThrowOnPublish) throw new Error('MockNats: publish failed');
    this._published.push({ subject, data, reply: opts?.reply });

    // Deliver to matching subscribers (including wildcards)
    for (const [pattern, handlers] of this.subscriptions) {
      if (this.matchSubject(pattern, subject)) {
        for (const handler of handlers) {
          const msg: NatsMessage = {
            subject,
            data,
            reply: opts?.reply,
            respond: (respData: Uint8Array) => {
              if (opts?.reply) {
                this.publish(opts.reply, respData);
              }
            },
          };
          handler(null, msg);
        }
      }
    }
  }

  subscribe(subject: string, handler: NatsHandler): NatsSubscription {
    if (!this.connected) throw new Error('MockNats: not connected');
    if (!this.subscriptions.has(subject)) {
      this.subscriptions.set(subject, new Set());
    }
    this.subscriptions.get(subject)!.add(handler);

    return {
      subject,
      unsubscribe: () => {
        this.subscriptions.get(subject)?.delete(handler);
      },
    };
  }

  async request(subject: string, data: Uint8Array, opts?: { timeout?: number }): Promise<NatsMessage> {
    if (!this.connected) throw new Error('MockNats: not connected');

    return new Promise((resolve, reject) => {
      const replySubject = `_INBOX.${Math.random().toString(36).slice(2)}`;
      const timeout = opts?.timeout ?? 5000;

      const timer = setTimeout(() => {
        reject(new Error(`MockNats: request timeout on ${subject}`));
      }, timeout);

      this.subscribe(replySubject, (err, msg) => {
        clearTimeout(timer);
        resolve(msg);
      });

      this.publish(subject, data, { reply: replySubject });
    });
  }

  private matchSubject(pattern: string, subject: string): boolean {
    if (pattern === subject) return true;
    if (pattern === '>') return true;

    const patternParts = pattern.split('.');
    const subjectParts = subject.split('.');

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '>') return true;
      if (patternParts[i] === '*') continue;
      if (patternParts[i] !== subjectParts[i]) return false;
    }

    return patternParts.length === subjectParts.length;
  }

  // Test control methods
  setThrowOnConnect(shouldThrow: boolean): void {
    this.shouldThrowOnConnect = shouldThrow;
  }

  setThrowOnPublish(shouldThrow: boolean): void {
    this.shouldThrowOnPublish = shouldThrow;
  }

  simulateDisconnect(): void {
    this.connected = false;
  }

  simulateReconnect(): void {
    this.connected = true;
  }

  getSubscriptionCount(subject?: string): number {
    if (subject) return this.subscriptions.get(subject)?.size ?? 0;
    let total = 0;
    for (const handlers of this.subscriptions.values()) total += handlers.size;
    return total;
  }

  reset(): void {
    this._published = [];
    this.subscriptions.clear();
    this.connected = false;
    this.shouldThrowOnConnect = false;
    this.shouldThrowOnPublish = false;
  }
}
