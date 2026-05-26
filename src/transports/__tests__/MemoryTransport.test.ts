import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryTransport } from '../MemoryTransport';
import type { TransportConfig, TransportMessage } from '../../interfaces/ITransport';

describe('MemoryTransport', () => {
  let transport: MemoryTransport;
  const config: TransportConfig = { backend: 'memory' };

  beforeEach(() => {
    transport = new MemoryTransport();
  });

  afterEach(async () => {
    if (transport.isConnected()) {
      await transport.disconnect();
    }
  });

  describe('connect', () => {
    it('should connect successfully and set connected state', async () => {
      await transport.connect(config);
      expect(transport.isConnected()).toBe(true);
    });

    it('should reject connecting when already connected', async () => {
      await transport.connect(config);
      await expect(transport.connect(config)).rejects.toThrow();
    });
  });

  describe('disconnect', () => {
    it('should disconnect and clear all subscriptions', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('topic-a', handler);
      await transport.disconnect();

      expect(transport.isConnected()).toBe(false);
      expect(transport.getStatus().subscriptions).toBe(0);
    });

    it('should clear reply handlers on disconnect', async () => {
      await transport.connect(config);
      await transport.reply('rpc.echo', (msg) => msg);
      await transport.disconnect();

      await transport.connect(config);
      await expect(transport.request('rpc.echo', { data: 'hello' }, 100)).rejects.toThrow();
    });
  });

  describe('publish/subscribe', () => {
    it('should deliver published messages to subscribers', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('events.user', handler);

      await transport.publish('events.user', { name: 'Alice' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'events.user',
          data: { name: 'Alice' },
        })
      );
    });

    it('should deliver messages to multiple subscribers on same topic', async () => {
      await transport.connect(config);
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      await transport.subscribe('broadcast', handler1);
      await transport.subscribe('broadcast', handler2);

      await transport.publish('broadcast', { msg: 'hello all' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should not deliver messages to subscribers of different topics (channel isolation)', async () => {
      await transport.connect(config);
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      await transport.subscribe('topic-a', handlerA);
      await transport.subscribe('topic-b', handlerB);

      await transport.publish('topic-a', { value: 1 });

      expect(handlerA).toHaveBeenCalledTimes(1);
      expect(handlerB).not.toHaveBeenCalled();
    });

    it('should include metadata in delivered messages', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('meta-topic', handler);

      await transport.publish('meta-topic', { x: 1 });

      const message: TransportMessage = handler.mock.calls[0][0];
      expect(message.metadata).toBeDefined();
      expect(message.metadata!.timestamp).toBeTypeOf('number');
      expect(message.metadata!.messageId).toBeTypeOf('string');
    });

    it('should throw when publishing while disconnected', async () => {
      await expect(transport.publish('topic', { data: 1 })).rejects.toThrow();
    });

    it('should throw when subscribing while disconnected', async () => {
      await expect(transport.subscribe('topic', vi.fn())).rejects.toThrow();
    });
  });

  describe('unsubscribe', () => {
    it('should stop delivering messages after unsubscribe', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      const subId = await transport.subscribe('events', handler);

      await transport.publish('events', { n: 1 });
      expect(handler).toHaveBeenCalledTimes(1);

      await transport.unsubscribe(subId);
      await transport.publish('events', { n: 2 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should decrement subscription count on unsubscribe', async () => {
      await transport.connect(config);
      const subId = await transport.subscribe('x', vi.fn());
      expect(transport.getStatus().subscriptions).toBe(1);

      await transport.unsubscribe(subId);
      expect(transport.getStatus().subscriptions).toBe(0);
    });
  });

  describe('request/reply', () => {
    it('should support request/reply RPC pattern', async () => {
      await transport.connect(config);
      await transport.reply('math.double', (msg: any) => ({ result: msg.value * 2 }));

      const response = await transport.request('math.double', { value: 5 });
      expect(response).toEqual({ result: 10 });
    });

    it('should support async reply handlers', async () => {
      await transport.connect(config);
      await transport.reply('async.op', async (msg: any) => {
        return { echoed: msg.input };
      });

      const response = await transport.request('async.op', { input: 'hello' });
      expect(response).toEqual({ echoed: 'hello' });
    });

    it('should timeout if no reply handler is registered', async () => {
      await transport.connect(config);
      await expect(
        transport.request('no.handler', { data: 1 }, 50)
      ).rejects.toThrow();
    });

    it('should throw when requesting while disconnected', async () => {
      await expect(transport.request('topic', {})).rejects.toThrow();
    });
  });

  describe('isConnected', () => {
    it('should return false before connect', () => {
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
    it('should return accurate status with zero counts initially', async () => {
      await transport.connect(config);
      const status = transport.getStatus();

      expect(status.connected).toBe(true);
      expect(status.backend).toBe('memory');
      expect(status.subscriptions).toBe(0);
      expect(status.messagesPublished).toBe(0);
      expect(status.messagesReceived).toBe(0);
      expect(status.errors).toBe(0);
    });

    it('should increment messagesPublished count on publish', async () => {
      await transport.connect(config);
      await transport.subscribe('count-topic', vi.fn());
      await transport.publish('count-topic', { a: 1 });
      await transport.publish('count-topic', { a: 2 });

      expect(transport.getStatus().messagesPublished).toBe(2);
    });

    it('should increment messagesReceived count on delivery', async () => {
      await transport.connect(config);
      await transport.subscribe('recv-topic', vi.fn());
      await transport.publish('recv-topic', { a: 1 });

      expect(transport.getStatus().messagesReceived).toBe(1);
    });

    it('should track subscription count accurately', async () => {
      await transport.connect(config);
      const sub1 = await transport.subscribe('t1', vi.fn());
      await transport.subscribe('t2', vi.fn());
      expect(transport.getStatus().subscriptions).toBe(2);

      await transport.unsubscribe(sub1);
      expect(transport.getStatus().subscriptions).toBe(1);
    });
  });

  describe('topicPrefix', () => {
    it('should prepend topicPrefix to all published topics', async () => {
      const prefixedConfig: TransportConfig = { backend: 'memory', topicPrefix: 'app1.' };
      await transport.connect(prefixedConfig);
      const handler = vi.fn();
      await transport.subscribe('events', handler);

      await transport.publish('events', { x: 1 });

      const message: TransportMessage = handler.mock.calls[0][0];
      expect(message.topic).toContain('app1.');
    });
  });

  describe('Edge Cases', () => {
    it('should handle publish to channel with no subscribers', async () => {
      await transport.connect(config);

      // Publishing to a channel with zero subscribers should not throw
      await expect(
        transport.publish('ghost-channel', { data: 'nobody home' })
      ).resolves.not.toThrow();

      // messagesPublished should still increment
      expect(transport.getStatus().messagesPublished).toBe(1);
    });

    it('should handle subscribe to empty string channel', async () => {
      await transport.connect(config);
      const handler = vi.fn();

      // Empty string channel — should either reject or work correctly
      const subId = await transport.subscribe('', handler);
      await transport.publish('', { data: 'empty channel' });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle publish empty message', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('topic', handler);

      await transport.publish('topic', {});

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ data: {} })
      );

    });

    it('should handle publish message with undefined fields', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('topic', handler);

      await transport.publish('topic', { a: undefined, b: 'defined' });

      expect(handler).toHaveBeenCalledTimes(1);
      const received = handler.mock.calls[0][0];
      expect(received.data.b).toBe('defined');

    });

    it('should handle publish after disconnect', async () => {
      await transport.connect(config);
      await transport.disconnect();

      await expect(
        transport.publish('topic', { data: 'post-disconnect' })
      ).rejects.toThrow();

    });

    it('should handle subscribe after disconnect', async () => {
      await transport.connect(config);
      await transport.disconnect();

      await expect(
        transport.subscribe('topic', vi.fn())
      ).rejects.toThrow();

    });

    it('should handle 10000 messages published before any subscriber reads', async () => {
      await transport.connect(config);

      // Publish 10000 messages with no subscribers
      for (let i = 0; i < 10000; i++) {
        await transport.publish('firehose', { seq: i });
      }

      expect(transport.getStatus().messagesPublished).toBe(10000);

      // Now subscribe — should not receive old messages (pub/sub is live)
      const handler = vi.fn();
      await transport.subscribe('firehose', handler);
      expect(handler).not.toHaveBeenCalled();

    });

    it('should preserve message ordering with 100 rapid publishes', async () => {
      await transport.connect(config);
      const received: number[] = [];
      await transport.subscribe('ordered', (msg) => { received.push(msg.data.seq); });

      for (let i = 0; i < 100; i++) {
        await transport.publish('ordered', { seq: i });
      }

      expect(received).toHaveLength(100);
      for (let i = 0; i < 100; i++) {
        expect(received[i]).toBe(i);
      }

    });

    it('should handle unsubscribe during message delivery callback', async () => {
      await transport.connect(config);
      let subId: string;
      const handler = vi.fn(async () => {
        // Unsubscribe self during callback
        await transport.unsubscribe(subId);
      });

      subId = await transport.subscribe('self-unsub', handler);

      await transport.publish('self-unsub', { n: 1 });
      await transport.publish('self-unsub', { n: 2 });

      // Handler should have been called once (first message), then unsubscribed
      expect(handler).toHaveBeenCalledTimes(1);

    });

    it('should handle request/reply with no responder registered', async () => {
      await transport.connect(config);

      // No reply handler — should timeout
      await expect(
        transport.request('no.responder.topic', { data: 'hello' }, 50)
      ).rejects.toThrow();

    });
  });

  describe('Untested Methods', () => {
    it('reset() — clears all state', async () => {
      await transport.connect(config);
      await transport.subscribe('topic-a', vi.fn());
      await transport.subscribe('topic-b', vi.fn());
      await transport.publish('topic-a', { data: 1 });

      await transport.reset();

      // After reset, subscriptions should be cleared
      expect(transport.getStatus().subscriptions).toBe(0);
      expect(transport.getStatus().messagesPublished).toBe(0);
      expect(transport.getStatus().messagesReceived).toBe(0);

    });

    it('reset() — transport remains connected after reset', async () => {
      await transport.connect(config);
      await transport.subscribe('topic', vi.fn());

      await transport.reset();

      // Should still be connected and operational
      expect(transport.isConnected()).toBe(true);
      const handler = vi.fn();
      await transport.subscribe('post-reset', handler);
      await transport.publish('post-reset', { msg: 'after reset' });
      expect(handler).toHaveBeenCalledTimes(1);

    });

    it('getSubscriptions() — returns active subscriptions', async () => {
      await transport.connect(config);
      await transport.subscribe('topic-a', vi.fn());
      await transport.subscribe('topic-b', vi.fn());
      await transport.subscribe('topic-a', vi.fn()); // second handler on same topic

      const subscriptions = transport.getSubscriptions();

      expect(subscriptions).toBeDefined();
      expect(Array.isArray(subscriptions)).toBe(true);
      expect(subscriptions.length).toBe(3);

    });

    it('getSubscriptions() — returns empty array when no subscriptions', async () => {
      await transport.connect(config);

      const subscriptions = transport.getSubscriptions();

      expect(subscriptions).toEqual([]);

    });

    it('getSubscriptions() — reflects unsubscribe', async () => {
      await transport.connect(config);
      const subId = await transport.subscribe('topic', vi.fn());

      await transport.unsubscribe(subId);

      const subscriptions = transport.getSubscriptions();
      expect(subscriptions).toHaveLength(0);

    });
  });
});
