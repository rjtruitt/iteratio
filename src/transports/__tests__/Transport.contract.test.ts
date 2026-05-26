import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryTransport } from '../MemoryTransport';
import { BroadcastChannelTransport } from '../BroadcastChannelTransport';
import { RedisPubSubTransport } from '../RedisPubSubTransport';
import { NATSTransport } from '../NATSTransport';
import { MockRedis } from '../../__test__/MockRedis';
import type { ITransport, TransportConfig, TransportMessage } from '../../interfaces/ITransport';

/**
 * Mock BroadcastChannel for Node testing
 */
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: { data: any }) => void) | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: any): void {
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name && !instance.closed && instance.onmessage) {
        instance.onmessage({ data });
      }
    }
  }

  close(): void {
    this.closed = true;
    MockBroadcastChannel.instances = MockBroadcastChannel.instances.filter(i => i !== this);
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

/**
 * Minimal mock NATS client for contract tests
 */
class MockNatsClient {
  connected = false;
  subscriptions = new Map<string, (msg: any) => void>();
  requestHandlers = new Map<string, (data: any) => any>();
  private subId = 0;

  async connect(): Promise<void> { this.connected = true; }
  async close(): Promise<void> { this.connected = false; this.subscriptions.clear(); }

  publish(subject: string, data: any): void {
    for (const [, handler] of this.subscriptions) {
      handler({ subject, data, sid: '' });
    }
  }

  subscribe(subject: string, handler: (msg: any) => void): string {
    const id = `sub-${++this.subId}`;
    this.subscriptions.set(id, handler);
    return id;
  }

  unsubscribe(id: string): void { this.subscriptions.delete(id); }

  async request(subject: string, data: any): Promise<any> {
    const handler = this.requestHandlers.get(subject);
    if (!handler) throw new Error('No responder');
    return handler(data);
  }

  registerRequestHandler(subject: string, handler: (data: any) => any): void {
    this.requestHandlers.set(subject, handler);
  }

  simulateMessage(subject: string, data: any): void {
    for (const [, handler] of this.subscriptions) {
      handler({ subject, data, sid: '' });
    }
  }

  reset(): void {
    this.subscriptions.clear();
    this.requestHandlers.clear();
    this.connected = false;
  }
}

/**
 * Transport factory for creating instances with their configs
 */
interface TransportFactory {
  name: string;
  create: () => ITransport;
  config: TransportConfig;
  setup?: () => void;
  teardown?: () => void;
}

describe('Transport Contract Tests', () => {
  let mockRedis: MockRedis;
  let mockNats: MockNatsClient;

  beforeEach(() => {
    MockBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    mockRedis = new MockRedis();
    mockNats = new MockNatsClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockRedis.reset();
    mockNats.reset();
  });

  const factories: TransportFactory[] = [
    {
      name: 'MemoryTransport',
      create: () => new MemoryTransport(),
      config: { backend: 'memory' },
    },
    {
      name: 'BroadcastChannelTransport',
      create: () => new BroadcastChannelTransport(),
      config: { backend: 'broadcast-channel' },
    },
    {
      name: 'RedisPubSubTransport',
      create: () => new RedisPubSubTransport(mockRedis as any),
      config: { backend: 'redis-pubsub', url: 'redis://localhost:6379' },
    },
    {
      name: 'NATSTransport',
      create: () => new NATSTransport(mockNats as any),
      config: { backend: 'nats', url: 'nats://localhost:4222' },
    },
  ];

  describe.each(factories)('$name', ({ create, config }) => {
    let transport: ITransport;

    beforeEach(async () => {
      transport = create();
    });

    afterEach(async () => {
      if (transport.isConnected()) {
        await transport.disconnect();
      }
    });

    describe('connect/disconnect lifecycle', () => {
      it('should connect successfully', async () => {
        await transport.connect(config);
        expect(transport.isConnected()).toBe(true);
      });

      it('should disconnect successfully', async () => {
        await transport.connect(config);
        await transport.disconnect();
        expect(transport.isConnected()).toBe(false);
      });

      it('should report not connected before connect', () => {
        expect(transport.isConnected()).toBe(false);
      });
    });

    describe('publish/subscribe', () => {
      it('should deliver published messages to subscribers', async () => {
        await transport.connect(config);
        const handler = vi.fn();
        await transport.subscribe('contract.topic', handler);

        await transport.publish('contract.topic', { value: 42 });

        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            topic: expect.stringContaining('contract.topic'),
            data: expect.objectContaining({ value: 42 }),
          })
        );
      });

      it('should support multiple subscribers on same topic', async () => {
        await transport.connect(config);
        const handler1 = vi.fn();
        const handler2 = vi.fn();
        await transport.subscribe('multi', handler1);
        await transport.subscribe('multi', handler2);

        await transport.publish('multi', { x: 1 });

        expect(handler1).toHaveBeenCalled();
        expect(handler2).toHaveBeenCalled();
      });

      it('should isolate topics (messages to A not delivered to B)', async () => {
        await transport.connect(config);
        const handlerA = vi.fn();
        const handlerB = vi.fn();
        await transport.subscribe('topic-a', handlerA);
        await transport.subscribe('topic-b', handlerB);

        await transport.publish('topic-a', { target: 'a' });

        expect(handlerA).toHaveBeenCalled();
        expect(handlerB).not.toHaveBeenCalled();
      });

      it('should throw when publishing while disconnected', async () => {
        await expect(transport.publish('topic', { data: 1 })).rejects.toThrow();
      });
    });

    describe('unsubscribe', () => {
      it('should stop delivering messages after unsubscribe', async () => {
        await transport.connect(config);
        const handler = vi.fn();
        const subId = await transport.subscribe('unsub', handler);

        await transport.publish('unsub', { n: 1 });
        expect(handler).toHaveBeenCalledTimes(1);

        await transport.unsubscribe(subId);
        await transport.publish('unsub', { n: 2 });
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });

    describe('request/reply', () => {
      it('should support request/reply RPC pattern', async () => {
        await transport.connect(config);
        await transport.reply('echo', (msg: any) => ({ echoed: msg }));

        const response = await transport.request('echo', { input: 'hello' });
        expect(response).toEqual({ echoed: { input: 'hello' } });
      });

      it('should timeout request when no handler exists', async () => {
        await transport.connect(config);
        await expect(
          transport.request('missing.handler', {}, 50)
        ).rejects.toThrow();
      });
    });

    describe('isConnected', () => {
      it('should return false initially', () => {
        expect(transport.isConnected()).toBe(false);
      });

      it('should return true after connect', async () => {
        await transport.connect(config);
        expect(transport.isConnected()).toBe(true);
      });

      it('should return false after disconnect', async () => {
        await transport.connect(config);
        await transport.disconnect();
        expect(transport.isConnected()).toBe(false);
      });
    });

    describe('getStatus', () => {
      it('should return connected status', async () => {
        await transport.connect(config);
        const status = transport.getStatus();
        expect(status.connected).toBe(true);
      });

      it('should return backend type', async () => {
        await transport.connect(config);
        const status = transport.getStatus();
        expect(status.backend).toBe(config.backend);
      });

      it('should return subscription count', async () => {
        await transport.connect(config);
        await transport.subscribe('s1', vi.fn());
        await transport.subscribe('s2', vi.fn());
        expect(transport.getStatus().subscriptions).toBe(2);
      });

      it('should track messages published', async () => {
        await transport.connect(config);
        await transport.subscribe('pub-count', vi.fn());
        await transport.publish('pub-count', { a: 1 });
        expect(transport.getStatus().messagesPublished).toBeGreaterThanOrEqual(1);
      });

      it('should initialize error count at zero', async () => {
        await transport.connect(config);
        expect(transport.getStatus().errors).toBe(0);
      });
    });
  });
});
