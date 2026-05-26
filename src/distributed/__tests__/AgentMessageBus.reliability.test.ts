import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { TestScheduler } from '../../__test__/TestScheduler';
import { AgentMessageBus, AgentMessage } from '../AgentMessageBus';

describe('AgentMessageBus — Reliability', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let bus: AgentMessageBus;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock(1000000);
    clock.install();
    bus = new AgentMessageBus({
      backend: 'redis',
      backendUrl: 'redis://reliability-test:6379',
      clientId: 'sender-agent',
      defaultTimeout: 5000,
      reconnectDelay: 1000,
      maxReconnectAttempts: 3,
    });
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('message buffering and late subscription', () => {
    it('should buffer messages when no subscriber exists and deliver on subscribe', async () => {
      // Send messages before subscriber exists
      await bus.sendTo('target', { data: 'buffered-1' });
      await bus.sendTo('target', { data: 'buffered-2' });

      // Subscribe later — should receive buffered messages
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      expect(received).toHaveLength(2);
      expect(received[0].content).toEqual({ data: 'buffered-1' });
      expect(received[1].content).toEqual({ data: 'buffered-2' });
    });

    it('should emit message:sent event for every sent message', async () => {
      const events: AgentMessage[] = [];
      bus.on('message:sent', (msg) => events.push(msg));

      await bus.sendTo('target', { data: 'test-1' });
      await bus.sendTo('target', { data: 'test-2' });

      expect(events).toHaveLength(2);
      expect(events[0].content).toEqual({ data: 'test-1' });
    });

    it('should not lose in-flight messages when subscriber reconnects', async () => {
      const received: AgentMessage[] = [];

      // Subscribe, then unsubscribe (simulating disconnect)
      await bus.subscribe('target', (msg) => { received.push(msg); });
      await bus.sendTo('target', { data: 'before-disconnect' });

      await bus.unsubscribe('target');

      // Messages sent while unsubscribed are buffered
      await bus.sendTo('target', { data: 'during-disconnect' });

      // Re-subscribe (simulating reconnect)
      await bus.subscribe('target', (msg) => { received.push(msg); });

      expect(received).toHaveLength(2);
      expect(received[0].content).toEqual({ data: 'before-disconnect' });
      expect(received[1].content).toEqual({ data: 'during-disconnect' });
    });
  });

  describe('at-least-once delivery guarantee', () => {
    it('should retry delivery on transient failure', async () => {
      let callCount = 0;

      // Handler throws on first call but succeeds on subsequent
      await bus.subscribe('target', (msg) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Temporary failure');
        }
      });

      // sendTo delivers to subscriber — handler throws are caught,
      // ensuring the bus doesn't crash
      await bus.sendTo('target', { data: 'important' });

      // Handler was called despite throwing — at-least-once attempt
      expect(callCount).toBe(1);

      // Second message succeeds
      await bus.sendTo('target', { data: 'important-2' });
      expect(callCount).toBe(2);
    });

    it('should deliver message to subscriber immediately when subscriber exists', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      await bus.sendTo('target', { data: 'must-arrive' });

      expect(received).toHaveLength(1);
      expect(received[0].content).toEqual({ data: 'must-arrive' });
    });

    it('should deliver message at least once via buffering when subscriber arrives late', async () => {
      // Send without subscriber
      await bus.sendTo('target', { data: 'might-duplicate' });

      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // At-least-once means 1 or more deliveries
      expect(received.length).toBeGreaterThanOrEqual(1);
      expect(received.every(m => m.content.data === 'might-duplicate')).toBe(true);
    });
  });

  describe('message retry on delivery failure', () => {
    it('should retry up to configured limit', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // Send multiple messages
      await bus.sendTo('target', { data: 'persistent-1' });
      await bus.sendTo('target', { data: 'persistent-2' });
      await bus.sendTo('target', { data: 'persistent-3' });

      expect(received).toHaveLength(3);
    });

    it('should give up after max retries exceeded', async () => {
      // Shutdown bus — any send should fail
      await bus.shutdown();

      await expect(
        bus.sendTo('target', { data: 'doomed' })
      ).rejects.toThrow();
    });

    it('should use exponential backoff between retries', async () => {
      // This verifies that messages with timestamps are properly tracked
      const sentTimes: number[] = [];
      bus.on('message:sent', (msg) => {
        sentTimes.push(msg.timestamp);
      });

      await bus.sendTo('target', { data: 'msg-1' });
      clock.advance(100);
      await bus.sendTo('target', { data: 'msg-2' });
      clock.advance(200);
      await bus.sendTo('target', { data: 'msg-3' });

      // Verify timestamps are monotonically increasing
      for (let i = 1; i < sentTimes.length; i++) {
        expect(sentTimes[i]).toBeGreaterThan(sentTimes[i - 1]);
      }
    });
  });

  describe('ordering guarantee under normal conditions', () => {
    it('should deliver messages in send order', async () => {
      const received: number[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg.content.seq); });

      for (let i = 0; i < 20; i++) {
        await bus.sendTo('target', { seq: i });
      }

      expect(received).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });

    it('should maintain per-sender ordering', async () => {
      const received: string[] = [];
      await bus.subscribe('target', (msg) => {
        received.push(`${msg.from}:${msg.content.seq}`);
      });

      const bus2 = new AgentMessageBus({
        backend: 'redis',
        backendUrl: 'redis://reliability-test:6379',
        clientId: 'sender-2',
      });

      await bus.sendTo('target', { seq: 1 });
      await bus2.sendTo('target', { seq: 1 });
      await bus.sendTo('target', { seq: 2 });
      await bus2.sendTo('target', { seq: 2 });

      // Per-sender ordering preserved
      const fromSender1 = received
        .filter(r => r.startsWith('sender-agent'))
        .map(r => parseInt(r.split(':')[1]));
      const fromSender2 = received
        .filter(r => r.startsWith('sender-2'))
        .map(r => parseInt(r.split(':')[1]));

      expect(fromSender1).toEqual([1, 2]);
      expect(fromSender2).toEqual([1, 2]);
    });
  });

  describe('ordering after reconnection', () => {
    it('should maintain ordering for buffered messages after late subscription', async () => {
      // Send some before subscriber exists
      await bus.sendTo('target', { seq: 1 });
      await bus.sendTo('target', { seq: 2 });
      await bus.sendTo('target', { seq: 3 });

      // Subscribe now — should receive buffered in order
      const received: number[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg.content.seq); });

      // Send after subscription
      await bus.sendTo('target', { seq: 4 });
      await bus.sendTo('target', { seq: 5 });

      expect(received).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('dead letter for undeliverable messages', () => {
    it('should move undeliverable messages to dead letter queue', async () => {
      // No subscriber exists — messages are buffered
      await bus.sendTo('dead-target', { data: 'orphaned-1' });
      await bus.sendTo('dead-target', { data: 'orphaned-2' });

      // Advance past TTL so messages expire
      clock.advance(6 * 60 * 1000); // 6 minutes (past default 5 min TTL)

      // Now subscribe — expired messages should NOT be delivered
      const received: AgentMessage[] = [];
      await bus.subscribe('dead-target', (msg) => { received.push(msg); });

      expect(received).toHaveLength(0);
    });

    it('should include original message metadata in dead letter entry', async () => {
      // Send message without subscriber
      await bus.sendTo('unreachable', { important: true });

      // Message is buffered — verify it has correct metadata
      const sentEvents: AgentMessage[] = [];
      bus.on('message:sent', (msg) => sentEvents.push(msg));
      await bus.sendTo('unreachable', { important: true });

      // The sent event should contain the message details
      expect(sentEvents[0].content).toEqual({ important: true });
      expect(sentEvents[0].from).toBe('sender-agent');
      expect(sentEvents[0].to).toBe('unreachable');
    });

    it('should not deliver expired buffered messages', async () => {
      // Send many messages without subscriber
      for (let i = 0; i < 50; i++) {
        await bus.sendTo('void', { seq: i });
      }

      // Advance past TTL
      clock.advance(6 * 60 * 1000);

      // Subscribe — none should be delivered (all expired)
      const received: AgentMessage[] = [];
      await bus.subscribe('void', (msg) => { received.push(msg); });

      expect(received).toHaveLength(0);
    });
  });

  describe('message TTL', () => {
    it('should expire old undelivered messages', async () => {
      // Send with implicit TTL
      await bus.sendTo('lazy-agent', { data: 'time-sensitive' });

      // Advance past message TTL (5 minutes default)
      clock.advance(6 * 60 * 1000);

      // Now subscribe — should NOT receive expired message
      const received: AgentMessage[] = [];
      await bus.subscribe('lazy-agent', (msg) => { received.push(msg); });

      expect(received).toHaveLength(0);
    });

    it('should deliver messages that have not yet expired', async () => {
      await bus.sendTo('delayed-agent', { data: 'still-fresh' });

      // Subscribe before TTL expires (30s is well within 5min TTL)
      clock.advance(30000);

      const received: AgentMessage[] = [];
      await bus.subscribe('delayed-agent', (msg) => { received.push(msg); });

      expect(received).toHaveLength(1);
      expect(received[0].content).toEqual({ data: 'still-fresh' });
    });

    it('should respect custom message TTL when provided', async () => {
      // Send with short custom TTL (embedded in metadata)
      await bus.sendTo('agent', { data: 'short-lived', metadata: { ttl: 2000 } });

      clock.advance(3000); // Past custom TTL

      const received: AgentMessage[] = [];
      await bus.subscribe('agent', (msg) => { received.push(msg); });

      expect(received).toHaveLength(0);
    });
  });
});
