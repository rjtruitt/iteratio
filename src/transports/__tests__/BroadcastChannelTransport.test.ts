import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BroadcastChannelTransport } from '../BroadcastChannelTransport';
import type { TransportConfig, TransportMessage } from '../../interfaces/ITransport';

/**
 * Mock BroadcastChannel API for Node.js testing environment
 */
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: { data: any }) => void) | null = null;
  closed = false;
  private _postMessageSpy = vi.fn();

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: any): void {
    this._postMessageSpy(data);
    // Simulate delivery to other instances with same name
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

  get postMessageCalls() {
    return this._postMessageSpy.mock.calls;
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

describe('BroadcastChannelTransport', () => {
  let transport: BroadcastChannelTransport;
  const config: TransportConfig = { backend: 'broadcast-channel' };

  beforeEach(() => {
    MockBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    transport = new BroadcastChannelTransport();
  });

  afterEach(async () => {
    if (transport.isConnected()) {
      await transport.disconnect();
    }
    vi.unstubAllGlobals();
  });

  describe('connect', () => {
    it('should connect and create a BroadcastChannel', async () => {
      await transport.connect(config);
      expect(transport.isConnected()).toBe(true);
      expect(MockBroadcastChannel.instances.length).toBeGreaterThan(0);
    });

    it('should use topicPrefix in channel name when configured', async () => {
      const prefixedConfig: TransportConfig = {
        backend: 'broadcast-channel',
        topicPrefix: 'myapp.',
      };
      await transport.connect(prefixedConfig);

      const channelNames = MockBroadcastChannel.instances.map(i => i.name);
      expect(channelNames.some(n => n.includes('myapp.'))).toBe(true);
    });
  });

  describe('publish', () => {
    it('should post message to BroadcastChannel', async () => {
      await transport.connect(config);
      await transport.publish('test.topic', { hello: 'world' });

      const instance = MockBroadcastChannel.instances[0];
      expect(instance.postMessageCalls.length).toBeGreaterThan(0);
    });

    it('should serialize complex objects correctly', async () => {
      await transport.connect(config);
      const complexObj = {
        nested: { array: [1, 2, 3], date: '2024-01-01' },
        buffer: 'base64data',
      };
      await transport.publish('complex', complexObj);

      const instance = MockBroadcastChannel.instances[0];
      const postedData = instance.postMessageCalls[0][0];
      expect(postedData).toBeDefined();
      // Verify the data can be deserialized back
      expect(JSON.parse(JSON.stringify(postedData))).toBeDefined();
    });

    it('should throw when publishing while disconnected', async () => {
      await expect(transport.publish('topic', {})).rejects.toThrow();
    });
  });

  describe('subscribe', () => {
    it('should add message listener and receive messages', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('events', handler);

      await transport.publish('events', { msg: 'hi' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'events',
          data: { msg: 'hi' },
        })
      );
    });

    it('should support multiple subscriptions on same topic', async () => {
      await transport.connect(config);
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      await transport.subscribe('multi', handler1);
      await transport.subscribe('multi', handler2);

      await transport.publish('multi', { x: 1 });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should return a subscription ID', async () => {
      await transport.connect(config);
      const subId = await transport.subscribe('topic', vi.fn());
      expect(subId).toBeTypeOf('string');
      expect(subId.length).toBeGreaterThan(0);
    });
  });

  describe('tab-to-tab messaging', () => {
    it('should simulate cross-tab message delivery', async () => {
      // Create two transports simulating two tabs
      const transport2 = new BroadcastChannelTransport();
      await transport.connect(config);
      await transport2.connect(config);

      const handler = vi.fn();
      await transport2.subscribe('cross-tab', handler);

      await transport.publish('cross-tab', { from: 'tab1' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'cross-tab',
          data: { from: 'tab1' },
        })
      );

      await transport2.disconnect();
    });

    it('should not receive own messages (sender isolation)', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('self-topic', handler);

      await transport.publish('self-topic', { from: 'self' });

      // BroadcastChannel spec: sender does NOT receive its own messages
      // Our mock simulates this by excluding self from delivery
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('message metadata', () => {
    it('should populate timestamp in message metadata', async () => {
      const transport2 = new BroadcastChannelTransport();
      await transport.connect(config);
      await transport2.connect(config);

      const handler = vi.fn();
      await transport2.subscribe('meta', handler);
      await transport.publish('meta', { x: 1 });

      const message: TransportMessage = handler.mock.calls[0][0];
      expect(message.metadata).toBeDefined();
      expect(message.metadata!.timestamp).toBeTypeOf('number');

      await transport2.disconnect();
    });

    it('should populate messageId in message metadata', async () => {
      const transport2 = new BroadcastChannelTransport();
      await transport.connect(config);
      await transport2.connect(config);

      const handler = vi.fn();
      await transport2.subscribe('meta-id', handler);
      await transport.publish('meta-id', { y: 2 });

      const message: TransportMessage = handler.mock.calls[0][0];
      expect(message.metadata!.messageId).toBeTypeOf('string');
      expect(message.metadata!.messageId!.length).toBeGreaterThan(0);

      await transport2.disconnect();
    });
  });

  describe('disconnect', () => {
    it('should close BroadcastChannel on disconnect', async () => {
      await transport.connect(config);
      const instance = MockBroadcastChannel.instances[0];
      await transport.disconnect();

      expect(instance.closed).toBe(true);
      expect(transport.isConnected()).toBe(false);
    });

    it('should clear subscriptions on disconnect', async () => {
      await transport.connect(config);
      await transport.subscribe('topic', vi.fn());
      await transport.disconnect();

      expect(transport.getStatus().subscriptions).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('should return correct backend type', async () => {
      await transport.connect(config);
      const status = transport.getStatus();
      expect(status.backend).toBe('broadcast-channel');
    });

    it('should track subscription count', async () => {
      await transport.connect(config);
      await transport.subscribe('a', vi.fn());
      await transport.subscribe('b', vi.fn());
      expect(transport.getStatus().subscriptions).toBe(2);
    });
  });

  describe('Untested Methods', () => {
    it('request(subject, payload, timeout) — request/reply pattern', async () => {
      const transport2 = new BroadcastChannelTransport();
      await transport.connect(config);
      await transport2.connect(config);

      // Set up reply handler on transport2
      await transport2.reply('rpc.echo', (msg: any) => ({ echoed: msg.input }));

      // Send request from transport
      const response = await transport.request('rpc.echo', { input: 'hello' }, 5000);

      expect(response).toEqual({ echoed: 'hello' });


      await transport2.disconnect();
    });

    it('request(subject, payload, timeout) — times out when no reply', async () => {
      await transport.connect(config);

      // No reply handler registered anywhere
      await expect(
        transport.request('rpc.no-handler', { data: 'test' }, 100)
      ).rejects.toThrow();

    });

    it('reply(subject, handler) — register reply handler', async () => {
      const transport2 = new BroadcastChannelTransport();
      await transport.connect(config);
      await transport2.connect(config);

      const handler = vi.fn().mockReturnValue({ result: 42 });
      await transport.reply('math.compute', handler);

      // Send request from transport2
      const response = await transport2.request('math.compute', { op: 'add', a: 20, b: 22 }, 5000);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'add', a: 20, b: 22 })
      );
      expect(response).toEqual({ result: 42 });


      await transport2.disconnect();
    });

    it('reply(subject, handler) — supports async handler', async () => {
      const transport2 = new BroadcastChannelTransport();
      await transport.connect(config);
      await transport2.connect(config);

      await transport.reply('async.op', async (msg: any) => {
        return { doubled: msg.value * 2 };
      });

      const response = await transport2.request('async.op', { value: 7 }, 5000);

      expect(response).toEqual({ doubled: 14 });


      await transport2.disconnect();
    });
  });
});
