import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RedisPubSubTransport } from '../RedisPubSubTransport';
import { MockRedis } from '../../__test__/MockRedis';
import type { TransportConfig, TransportMessage } from '../../interfaces/ITransport';

describe('RedisPubSubTransport', () => {
  let transport: RedisPubSubTransport;
  let mockRedis: MockRedis;
  const config: TransportConfig = {
    backend: 'redis-pubsub',
    url: 'redis://localhost:6379',
  };

  beforeEach(() => {
    mockRedis = new MockRedis();
    transport = new RedisPubSubTransport(mockRedis as any);
  });

  afterEach(async () => {
    if (transport.isConnected()) {
      await transport.disconnect();
    }
    mockRedis.reset();
  });

  describe('connect', () => {
    it('should connect and set connected state', async () => {
      await transport.connect(config);
      expect(transport.isConnected()).toBe(true);
    });

    it('should pass auth credentials when provided', async () => {
      const authConfig: TransportConfig = {
        ...config,
        auth: {
          type: 'basic',
          credentials: { username: 'user', password: 'pass' },
        },
      };
      await transport.connect(authConfig);
      expect(transport.isConnected()).toBe(true);
    });

    it('should store config url in status', async () => {
      await transport.connect(config);
      const status = transport.getStatus();
      expect(status.url).toBe('redis://localhost:6379');
    });
  });

  describe('publish', () => {
    it('should call Redis publish with correct channel and message', async () => {
      await transport.connect(config);
      await transport.publish('events.user', { name: 'Alice' });

      const publishCmds = mockRedis.commands.filter(c => c.cmd === 'publish');
      expect(publishCmds.length).toBeGreaterThan(0);
    });

    it('should apply topicPrefix to published channel', async () => {
      const prefixedConfig: TransportConfig = {
        ...config,
        topicPrefix: 'myapp.',
      };
      await transport.connect(prefixedConfig);
      await transport.publish('events', { data: 1 });

      const publishCmds = mockRedis.commands.filter(c => c.cmd === 'publish');
      expect(publishCmds.length).toBeGreaterThan(0);
      const channelArg = publishCmds[0].args[0] as string;
      expect(channelArg).toContain('myapp.');
    });

    it('should throw when publishing while disconnected', async () => {
      await expect(transport.publish('topic', {})).rejects.toThrow();
    });

    it('should serialize message data as JSON string', async () => {
      await transport.connect(config);
      const payload = { nested: { arr: [1, 2, 3] } };
      await transport.publish('json-topic', payload);

      const publishCmds = mockRedis.commands.filter(c => c.cmd === 'publish');
      const messageArg = publishCmds[0].args[1] as string;
      expect(JSON.parse(messageArg)).toMatchObject(payload);
    });
  });

  describe('subscribe', () => {
    it('should register handler via Redis subscribe', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('notifications', handler);

      const subscribeCmds = mockRedis.commands.filter(c => c.cmd === 'subscribe');
      expect(subscribeCmds.length).toBeGreaterThan(0);
    });

    it('should deliver messages received via pub/sub to handler', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('events', handler);

      // Simulate a Redis message arriving
      await mockRedis.publish('events', JSON.stringify({ topic: 'events', data: { x: 1 } }));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'events',
          data: expect.objectContaining({ x: 1 }),
        })
      );
    });

    it('should return a subscription ID', async () => {
      await transport.connect(config);
      const subId = await transport.subscribe('topic', vi.fn());
      expect(subId).toBeTypeOf('string');
      expect(subId.length).toBeGreaterThan(0);
    });

    it('should handle multiple subscriptions to different channels', async () => {
      await transport.connect(config);
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      await transport.subscribe('channel-a', handler1);
      await transport.subscribe('channel-b', handler2);

      expect(transport.getStatus().subscriptions).toBe(2);
    });

    it('should apply topicPrefix to subscribed channels', async () => {
      const prefixedConfig: TransportConfig = { ...config, topicPrefix: 'ns.' };
      await transport.connect(prefixedConfig);
      await transport.subscribe('events', vi.fn());

      const subscribeCmds = mockRedis.commands.filter(c => c.cmd === 'subscribe');
      const channelArg = subscribeCmds[0].args[0] as string;
      expect(channelArg).toContain('ns.');
    });
  });

  describe('unsubscribe', () => {
    it('should stop delivering messages after unsubscribe', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      const subId = await transport.subscribe('unsub-test', handler);

      await mockRedis.publish('unsub-test', JSON.stringify({ topic: 'unsub-test', data: { n: 1 } }));
      expect(handler).toHaveBeenCalledTimes(1);

      await transport.unsubscribe(subId);
      await mockRedis.publish('unsub-test', JSON.stringify({ topic: 'unsub-test', data: { n: 2 } }));
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('request/reply', () => {
    it('should implement request/reply via temporary response channels', async () => {
      await transport.connect(config);
      await transport.reply('rpc.add', (msg: any) => ({ sum: msg.a + msg.b }));

      const response = await transport.request('rpc.add', { a: 3, b: 4 });
      expect(response).toEqual({ sum: 7 });
    });

    it('should timeout on request when no reply is received', async () => {
      await transport.connect(config);
      await expect(
        transport.request('no.reply', { data: 1 }, 50)
      ).rejects.toThrow();
    });
  });

  describe('reconnection', () => {
    it('should handle disconnection and reconnect gracefully', async () => {
      await transport.connect(config);
      expect(transport.isConnected()).toBe(true);

      mockRedis.disconnect();
      // After Redis goes down, isConnected should reflect the state
      expect(transport.isConnected()).toBe(false);

      mockRedis.reconnect();
      await transport.connect(config);
      expect(transport.isConnected()).toBe(true);
    });

    it('should fall back gracefully when Redis is unavailable', async () => {
      mockRedis.disconnect();
      // Transport should handle connection failure gracefully
      await expect(transport.connect(config)).rejects.toThrow();
    });
  });

  describe('getStatus', () => {
    it('should return correct backend type', async () => {
      await transport.connect(config);
      expect(transport.getStatus().backend).toBe('redis-pubsub');
    });

    it('should track messages published count', async () => {
      await transport.connect(config);
      await transport.publish('t', { a: 1 });
      await transport.publish('t', { a: 2 });
      expect(transport.getStatus().messagesPublished).toBe(2);
    });

    it('should track error count', async () => {
      await transport.connect(config);
      mockRedis.setThrowOnNext(new Error('Redis error'));
      try {
        await transport.publish('fail', {});
      } catch { /* expected */ }
      expect(transport.getStatus().errors).toBeGreaterThan(0);
    });

    it('should include subscription count', async () => {
      await transport.connect(config);
      await transport.subscribe('a', vi.fn());
      await transport.subscribe('b', vi.fn());
      expect(transport.getStatus().subscriptions).toBe(2);
    });
  });

  describe('disconnect', () => {
    it('should call Redis unsubscribe for all channels', async () => {
      await transport.connect(config);
      await transport.subscribe('ch1', vi.fn());
      await transport.subscribe('ch2', vi.fn());
      await transport.disconnect();

      const unsubCmds = mockRedis.commands.filter(c => c.cmd === 'unsubscribe');
      expect(unsubCmds.length).toBeGreaterThanOrEqual(2);
    });

    it('should set connected to false', async () => {
      await transport.connect(config);
      await transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle subscribe to pattern with wildcard *', async () => {
      await transport.connect(config);
      const handler = vi.fn();

      // Pattern subscribe with wildcard
      await transport.subscribe('events.*', handler);

      // Publish to a matching channel
      await mockRedis.publish('events.user', JSON.stringify({ topic: 'events.user', data: { x: 1 } }));

      expect(handler).toHaveBeenCalledTimes(1);

    });

    it('should handle publish during reconnection', async () => {
      await transport.connect(config);

      // Simulate Redis going down mid-operation
      mockRedis.disconnect();

      // Publish while disconnected should throw or queue
      await expect(
        transport.publish('events', { data: 'during-reconnect' })
      ).rejects.toThrow();

      // Reconnect
      mockRedis.reconnect();
      await transport.connect(config);

      // Should work again
      await expect(
        transport.publish('events', { data: 'after-reconnect' })
      ).resolves.not.toThrow();

    });

    it('should handle message received during unsubscribe', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      const subId = await transport.subscribe('race-channel', handler);

      // Simulate message arriving at the same time as unsubscribe
      const unsubPromise = transport.unsubscribe(subId);
      await mockRedis.publish('race-channel', JSON.stringify({ topic: 'race-channel', data: { n: 1 } }));
      await unsubPromise;

      // Handler might get called 0 or 1 times, but should not throw
      expect(handler.mock.calls.length).toBeLessThanOrEqual(1);

    });

    it('should handle Redis returns error on publish', async () => {
      await transport.connect(config);
      mockRedis.setThrowOnNext(new Error('Redis PUBLISH error'));

      await expect(
        transport.publish('error-channel', { data: 'fail' })
      ).rejects.toThrow('Redis PUBLISH error');

      // Error counter should increment
      expect(transport.getStatus().errors).toBeGreaterThan(0);

    });

    it('should handle subscribe to 1000 channels simultaneously', async () => {
      await transport.connect(config);
      const handlers = Array.from({ length: 1000 }, () => vi.fn());

      const subscriptions = await Promise.all(
        handlers.map((h, i) => transport.subscribe(`channel-${i}`, h))
      );

      expect(subscriptions).toHaveLength(1000);
      expect(transport.getStatus().subscriptions).toBe(1000);

    });

    it('should handle message larger than Redis max payload', async () => {
      await transport.connect(config);

      // Redis has a 512MB max, but in practice much less is sane
      // Simulate a message that exceeds reasonable limits (e.g., 64MB)
      const hugePayload = { data: 'x'.repeat(64 * 1024 * 1024) };

      // Should either throw a size error or handle gracefully
      await expect(
        transport.publish('huge-channel', hugePayload)
      ).rejects.toThrow();

    });

    it('should handle UTF-8 multi-byte characters in channel name', async () => {
      await transport.connect(config);
      const handler = vi.fn();

      const unicodeChannel = 'events.用户.données.🚀';
      await transport.subscribe(unicodeChannel, handler);
      await mockRedis.publish(unicodeChannel, JSON.stringify({ topic: unicodeChannel, data: { ok: true } }));

      expect(handler).toHaveBeenCalledTimes(1);

    });

    it('should handle rapid subscribe/unsubscribe cycle (100 times)', async () => {
      await transport.connect(config);

      for (let i = 0; i < 100; i++) {
        const subId = await transport.subscribe(`cycle-channel-${i % 5}`, vi.fn());
        await transport.unsubscribe(subId);
      }

      // All subscriptions should be cleaned up
      expect(transport.getStatus().subscriptions).toBe(0);

    });
  });
});
