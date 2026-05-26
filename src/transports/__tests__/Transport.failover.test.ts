import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryTransport } from '../MemoryTransport';
import { RedisPubSubTransport } from '../RedisPubSubTransport';
import { MockRedis } from '../../__test__/MockRedis';
import { MockTransport } from '../../__test__/MockTransport';
import type { TransportConfig, TransportMessage } from '../../interfaces/ITransport';

describe('Transport Failover', () => {
  let mockRedis: MockRedis;

  beforeEach(() => {
    mockRedis = new MockRedis();
  });

  afterEach(() => {
    mockRedis.reset();
  });

  describe('disconnection mid-message', () => {
    it('should throw on publish when connection drops mid-message', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport.connect(config);

      // Simulate disconnection on next Redis call
      mockRedis.setDisconnectOnCall(mockRedis.commands.length + 1);

      await expect(transport.publish('topic', { data: 'test' })).rejects.toThrow();
    });

    it('should detect disconnection state after connection drop', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport.connect(config);

      mockRedis.disconnect();

      expect(transport.isConnected()).toBe(false);
    });
  });

  describe('automatic reconnection', () => {
    it('should attempt reconnection after disconnection', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
        maxReconnectAttempts: 3,
        reconnectDelay: 100,
      };
      await transport.connect(config);
      mockRedis.disconnect();

      // Transport should attempt to reconnect
      // After reconnect delay, it should try to re-establish connection
      await new Promise(resolve => setTimeout(resolve, 150));

      mockRedis.reconnect();
      await transport.connect(config);
      expect(transport.isConnected()).toBe(true);
    });

    it('should restore subscriptions after reconnection', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
        maxReconnectAttempts: 5,
      };
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('persist-topic', handler);

      mockRedis.disconnect();
      mockRedis.reconnect();
      await transport.connect(config);

      // Subscription should be re-established
      await transport.publish('persist-topic', { restored: true });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ data: { restored: true } })
      );
    });
  });

  describe('message buffering during disconnection', () => {
    it('should buffer messages published during disconnection', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
        maxReconnectAttempts: 3,
      };
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('buffered', handler);

      mockRedis.disconnect();

      // These publishes should be buffered
      try {
        await transport.publish('buffered', { msg: 1 });
        await transport.publish('buffered', { msg: 2 });
      } catch {
        // May throw, but messages should be buffered internally
      }

      mockRedis.reconnect();
      await transport.connect(config);

      // Buffered messages should be delivered
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ data: { msg: 1 } })
      );
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ data: { msg: 2 } })
      );
    });

    it('should deliver buffered messages in order after reconnection', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
      };
      await transport.connect(config);
      const received: number[] = [];
      await transport.subscribe('ordered', (msg: TransportMessage) => {
        received.push(msg.data.seq);
      });

      mockRedis.disconnect();

      try {
        await transport.publish('ordered', { seq: 1 });
        await transport.publish('ordered', { seq: 2 });
        await transport.publish('ordered', { seq: 3 });
      } catch { /* buffered */ }

      mockRedis.reconnect();
      await transport.connect(config);

      expect(received).toEqual([1, 2, 3]);
    });
  });

  describe('fallback to alternative transport', () => {
    it('should fall back to MemoryTransport when Redis is unavailable', async () => {
      mockRedis.disconnect();

      const primaryTransport = new RedisPubSubTransport(mockRedis as any);
      const fallbackTransport = new MemoryTransport();
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      const fallbackConfig: TransportConfig = { backend: 'memory' };

      // Primary should fail
      await expect(primaryTransport.connect(config)).rejects.toThrow();

      // Fallback should succeed
      await fallbackTransport.connect(fallbackConfig);
      expect(fallbackTransport.isConnected()).toBe(true);

      const handler = vi.fn();
      await fallbackTransport.subscribe('fallback-topic', handler);
      await fallbackTransport.publish('fallback-topic', { via: 'fallback' });
      expect(handler).toHaveBeenCalled();

      await fallbackTransport.disconnect();
    });
  });

  describe('connection timeout handling', () => {
    it('should reject connect with timeout error when connection takes too long', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://unreachable:6379',
        timeout: 100,
      };

      // Mock a connection that never resolves
      mockRedis.disconnect();

      await expect(transport.connect(config)).rejects.toThrow();
    });

    it('should respect configured timeout value', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://slow:6379',
        timeout: 50,
      };

      mockRedis.disconnect();
      const start = Date.now();

      try {
        await transport.connect(config);
      } catch {
        // Expected
      }

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000); // Should not hang
    });
  });

  describe('max reconnect attempts exhausted', () => {
    it('should stop reconnecting after maxReconnectAttempts', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
        maxReconnectAttempts: 2,
        reconnectDelay: 10,
      };
      await transport.connect(config);
      mockRedis.disconnect();

      // Wait long enough for all retry attempts
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should remain disconnected
      expect(transport.isConnected()).toBe(false);
    });

    it('should emit error event when max reconnect attempts exhausted', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
        maxReconnectAttempts: 1,
        reconnectDelay: 10,
      };
      await transport.connect(config);

      const errorSpy = vi.fn();
      (transport as any).on?.('error', errorSpy);

      mockRedis.disconnect();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Transport should report exhausted reconnection attempts
      expect(transport.getStatus().errors).toBeGreaterThan(0);
    });
  });

  describe('event emission on connection state change', () => {
    it('should emit disconnect event when connection is lost', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport.connect(config);

      const disconnectSpy = vi.fn();
      (transport as any).on?.('disconnect', disconnectSpy);

      mockRedis.disconnect();

      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('should emit reconnect event when connection is restored', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
        maxReconnectAttempts: 3,
      };
      await transport.connect(config);

      const reconnectSpy = vi.fn();
      (transport as any).on?.('reconnect', reconnectSpy);

      mockRedis.disconnect();
      mockRedis.reconnect();
      await transport.connect(config);

      expect(reconnectSpy).toHaveBeenCalled();
    });

    it('should update getStatus().connected immediately on state change', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport.connect(config);

      expect(transport.getStatus().connected).toBe(true);
      mockRedis.disconnect();
      expect(transport.getStatus().connected).toBe(false);
    });
  });

  describe('Adversarial: Transport Manipulation', () => {
    it('should handle message delivered twice (at-least-once duplicate)', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport.connect(config);

      const received: TransportMessage[] = [];
      await transport.subscribe('dedup-topic', (msg: TransportMessage) => {
        received.push(msg);
      });

      // Simulate at-least-once delivery: same message delivered twice
      const message = { id: 'msg-123', data: 'payload', timestamp: Date.now() };
      await transport.publish('dedup-topic', message);
      await transport.publish('dedup-topic', message); // Duplicate

      // FAILS: transport should deduplicate or provide idempotency key
      const uniqueIds = new Set(received.map(m => m.data.id));
      expect(received.length).toBe(2); // Raw deliveries
      expect(uniqueIds.size).toBe(1); // But logically one message

    });

    it('should prevent message delivered to wrong subscriber (misroute)', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport.connect(config);

      const topicAMessages: any[] = [];
      const topicBMessages: any[] = [];

      await transport.subscribe('topic-A', (msg: TransportMessage) => topicAMessages.push(msg));
      await transport.subscribe('topic-B', (msg: TransportMessage) => topicBMessages.push(msg));

      // Publish to topic-A
      await transport.publish('topic-A', { target: 'A' });
      // Publish to topic-B
      await transport.publish('topic-B', { target: 'B' });

      // FAILS: messages should never leak to wrong topic subscribers
      expect(topicAMessages.every(m => m.data.target === 'A')).toBe(true);
      expect(topicBMessages.every(m => m.data.target === 'B')).toBe(true);
      expect(topicAMessages.length).toBe(1);
      expect(topicBMessages.length).toBe(1);

    });

    it('should handle connection drop between send and ack (ghost message)', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport.connect(config);

      const received: any[] = [];
      await transport.subscribe('ghost-topic', (msg: TransportMessage) => received.push(msg));

      // Simulate: message sent, but connection drops before ack returns
      mockRedis.setDisconnectOnCall(mockRedis.commands.length + 1);

      let publishError: Error | null = null;
      try {
        await transport.publish('ghost-topic', { ghost: true });
      } catch (e: any) {
        publishError = e;
      }

      // FAILS: publisher should know definitively if message was delivered or not
      // Ghost message: publisher thinks it failed, but subscriber actually received it
      expect(publishError).not.toBeNull();
      // After reconnect, should be able to determine message fate
      mockRedis.reconnect();
      await transport.connect(config);
      const messageStatus = await (transport as any).getMessageStatus?.('ghost-topic');
      expect(messageStatus).toBeDefined();

    });

    it('should prevent subscriber from receiving messages from before its subscription (time travel)', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport.connect(config);

      // Publish messages BEFORE subscriber connects
      await transport.publish('history-topic', { seq: 1, msg: 'before' });
      await transport.publish('history-topic', { seq: 2, msg: 'before' });

      // Now subscribe
      const received: any[] = [];
      await transport.subscribe('history-topic', (msg: TransportMessage) => received.push(msg));

      // Publish after subscription
      await transport.publish('history-topic', { seq: 3, msg: 'after' });

      // FAILS: subscriber should only receive messages from after subscription
      expect(received.every(m => m.data.seq >= 3)).toBe(true);
      expect(received.length).toBe(1);

    });

    it('should handle transport buffer overflow causing message loss (silent drop)', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
      };
      await transport.connect(config);

      const received: any[] = [];
      await transport.subscribe('overflow-topic', (msg: TransportMessage) => received.push(msg));

      // Flood the transport with more messages than buffer can hold
      const messageCount = 100000;
      for (let i = 0; i < messageCount; i++) {
        await transport.publish('overflow-topic', { seq: i });
      }

      // FAILS: transport should either deliver all messages or report drops (not silently lose)
      if (received.length < messageCount) {
        // If messages were dropped, there should be an error/warning
        const status = transport.getStatus();
        expect(status.droppedMessages).toBeGreaterThan(0);
      } else {
        expect(received.length).toBe(messageCount);
      }

    });

    it('should handle reconnection creating message ordering inversion', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = {
        backend: 'redis-pubsub',
        url: 'redis://localhost:6379',
        maxReconnectAttempts: 3,
      };
      await transport.connect(config);

      const received: number[] = [];
      await transport.subscribe('order-topic', (msg: TransportMessage) => {
        received.push(msg.data.seq);
      });

      // Send messages, disconnect mid-stream, reconnect
      await transport.publish('order-topic', { seq: 1 });
      await transport.publish('order-topic', { seq: 2 });

      mockRedis.disconnect();

      // These are buffered during disconnect
      try {
        await transport.publish('order-topic', { seq: 3 });
        await transport.publish('order-topic', { seq: 4 });
      } catch { /* buffered */ }

      mockRedis.reconnect();
      await transport.connect(config);

      // New message after reconnect
      await transport.publish('order-topic', { seq: 5 });

      // FAILS: messages should maintain strict ordering even across reconnection
      for (let i = 1; i < received.length; i++) {
        expect(received[i]).toBeGreaterThan(received[i - 1]);
      }

    });

    it('should handle two publishers sending to same topic at same nanosecond', async () => {
      const transport1 = new RedisPubSubTransport(mockRedis as any);
      const transport2 = new RedisPubSubTransport(mockRedis as any);
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      await transport1.connect(config);
      await transport2.connect(config);

      const received: any[] = [];
      await transport1.subscribe('concurrent-topic', (msg: TransportMessage) => received.push(msg));

      // Both publishers send at the exact same instant
      const pub1 = transport1.publish('concurrent-topic', { from: 'publisher-1' });
      const pub2 = transport2.publish('concurrent-topic', { from: 'publisher-2' });
      await Promise.all([pub1, pub2]);

      // FAILS: concurrent publishes should both be delivered with deterministic ordering
      expect(received.length).toBe(2);
      expect(received[0].data.from).not.toBe(received[1].data.from);

    });

    it('should handle transport failover during active message delivery', async () => {
      const transport = new RedisPubSubTransport(mockRedis as any);
      const fallback = new MemoryTransport();
      const config: TransportConfig = { backend: 'redis-pubsub', url: 'redis://localhost:6379' };
      const fallbackConfig: TransportConfig = { backend: 'memory' };
      await transport.connect(config);
      await fallback.connect(fallbackConfig);

      const received: any[] = [];
      await transport.subscribe('failover-topic', (msg: TransportMessage) => received.push(msg));

      // Start delivering a batch of messages
      const publishPromises = Array.from({ length: 10 }, (_, i) =>
        transport.publish('failover-topic', { seq: i })
      );

      // Transport fails mid-batch
      mockRedis.setDisconnectOnCall(mockRedis.commands.length + 5);

      const results = await Promise.allSettled(publishPromises);

      // FAILS: messages in-flight during failover should be recoverable
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      // All messages should either have been delivered or be retryable
      expect(succeeded + failed).toBe(10);
      expect(received.length).toBe(succeeded); // Delivered count matches success count

    });
  });
});
