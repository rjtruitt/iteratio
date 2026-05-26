/**
 * Mock BroadcastChannel for browser transport tests.
 * Simulates the browser BroadcastChannel API for Node.js test environments.
 */

type BroadcastHandler = (event: MessageEvent) => void;

const channelRegistry = new Map<string, Set<MockBroadcastChannel>>();

export class MockBroadcastChannel {
  readonly name: string;
  onmessage: BroadcastHandler | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private closed = false;
  private _postedMessages: unknown[] = [];

  constructor(name: string) {
    this.name = name;
    if (!channelRegistry.has(name)) {
      channelRegistry.set(name, new Set());
    }
    channelRegistry.get(name)!.add(this);
  }

  get postedMessages() { return this._postedMessages; }

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('BroadcastChannel is closed');
    this._postedMessages.push(message);

    const event = new MessageEvent('message', { data: message });
    const channels = channelRegistry.get(this.name);
    if (channels) {
      for (const channel of channels) {
        if (channel !== this && !channel.closed && channel.onmessage) {
          channel.onmessage(event);
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    channelRegistry.get(this.name)?.delete(this);
    if (channelRegistry.get(this.name)?.size === 0) {
      channelRegistry.delete(this.name);
    }
  }

  addEventListener(type: string, handler: BroadcastHandler): void {
    if (type === 'message') this.onmessage = handler;
    if (type === 'messageerror') this.onmessageerror = handler as any;
  }

  removeEventListener(type: string, handler: BroadcastHandler): void {
    if (type === 'message' && this.onmessage === handler) this.onmessage = null;
  }

  get isClosed() { return this.closed; }

  static resetAll(): void {
    channelRegistry.clear();
  }

  static getChannelCount(name: string): number {
    return channelRegistry.get(name)?.size ?? 0;
  }

  static getAllChannelNames(): string[] {
    return [...channelRegistry.keys()];
  }
}

export class MessageEvent {
  readonly type: string;
  readonly data: unknown;

  constructor(type: string, init: { data: unknown }) {
    this.type = type;
    this.data = init.data;
  }
}

export function installMockBroadcastChannel(): void {
  (globalThis as any).BroadcastChannel = MockBroadcastChannel;
  (globalThis as any).MessageEvent = MessageEvent;
}

export function uninstallMockBroadcastChannel(): void {
  delete (globalThis as any).BroadcastChannel;
}
