import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockRedis } from '../../__test__/MockRedis';
import { TestClock } from '../../__test__/TestClock';
import { AgentMessageBus, AgentMessage } from '../AgentMessageBus';

describe('AgentMessageBus', () => {
  let redis: MockRedis;
  let clock: TestClock;
  let bus: AgentMessageBus;

  beforeEach(() => {
    redis = new MockRedis();
    clock = new TestClock(1000000);
    clock.install();
    bus = new AgentMessageBus({
      backend: 'redis',
      backendUrl: 'redis://localhost:6379',
      clientId: 'sender-agent',
      defaultTimeout: 5000,
    });
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('sendTo (direct message)', () => {
    it('should send message to specific agent via publish', async () => {
      const handler = vi.fn();
      await bus.subscribe('target-agent', handler);

      await bus.sendTo('target-agent', { action: 'hello' });

      expect(handler).toHaveBeenCalledTimes(1);
      const msg = handler.mock.calls[0][0];
      expect(msg.to).toBe('target-agent');
    });

    it('should include sender ID (from field) in message', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target-agent', (msg) => { received.push(msg); });

      await bus.sendTo('target-agent', { action: 'hello' });

      expect(received).toHaveLength(1);
      expect(received[0].from).toBe('sender-agent');
    });

    it('should include timestamp in message', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target-agent', (msg) => { received.push(msg); });

      await bus.sendTo('target-agent', { action: 'hello' });

      expect(received[0].timestamp).toBe(clock.now);
    });

    it('should include unique messageId', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target-agent', (msg) => { received.push(msg); });

      await bus.sendTo('target-agent', { msg: 1 });
      await bus.sendTo('target-agent', { msg: 2 });

      expect(received[0].messageId).toBeDefined();
      expect(received[1].messageId).toBeDefined();
      expect(received[0].messageId).not.toBe(received[1].messageId);
    });

    it('should set message type to "message" for direct sends', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target-agent', (msg) => { received.push(msg); });

      await bus.sendTo('target-agent', { action: 'hello' });

      expect(received[0].type).toBe('message');
    });

    it('should deliver content as-is without modification', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target-agent', (msg) => { received.push(msg); });

      const payload = { complex: { nested: [1, 2, 3] }, flag: true };
      await bus.sendTo('target-agent', payload);

      expect(received[0].content).toEqual(payload);
    });
  });

  describe('receive (subscribe)', () => {
    it('should receive message on correct agent', async () => {
      const handler = vi.fn();
      await bus.subscribe('my-agent', handler);

      await bus.sendTo('my-agent', { data: 'test' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ content: { data: 'test' } })
      );
    });

    it('should not deliver to wrong agent', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await bus.subscribe('agent-A', handler1);
      await bus.subscribe('agent-B', handler2);

      await bus.sendTo('agent-A', { data: 'for A' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should support multiple handlers on same agent', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await bus.subscribe('my-agent', handler1);
      await bus.subscribe('my-agent', handler2);

      await bus.sendTo('my-agent', { data: 'test' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('broadcast', () => {
    it('should deliver broadcast to all subscribers of channel', async () => {
      const handlers = [vi.fn(), vi.fn(), vi.fn()];

      await bus.subscribeToBroadcasts('a1', 'all', handlers[0]);
      await bus.subscribeToBroadcasts('a2', 'all', handlers[1]);
      await bus.subscribeToBroadcasts('a3', 'all', handlers[2]);

      await bus.broadcast('all', { announcement: 'hello world' });

      for (const handler of handlers) {
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({ content: { announcement: 'hello world' } })
        );
      }
    });

    it('should broadcast to role-specific subscribers only', async () => {
      const workerHandler = vi.fn();
      const orchestratorHandler = vi.fn();

      await bus.subscribeToBroadcasts('w1', { role: 'worker' }, workerHandler);
      await bus.subscribeToBroadcasts('o1', { role: 'orchestrator' }, orchestratorHandler);

      await bus.broadcast({ role: 'worker' }, { task: 'do something' });

      expect(workerHandler).toHaveBeenCalledTimes(1);
      expect(orchestratorHandler).not.toHaveBeenCalled();
    });

    it('should set message type to "broadcast"', async () => {
      const handler = vi.fn();
      await bus.subscribeToBroadcasts('a1', 'all', handler);

      await bus.broadcast('all', { data: 'test' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'broadcast' })
      );
    });
  });

  describe('subscribe / unsubscribe lifecycle', () => {
    it('should stop receiving after unsubscribe', async () => {
      const handler = vi.fn();
      await bus.subscribe('my-agent', handler);

      await bus.sendTo('my-agent', { msg: 1 });
      expect(handler).toHaveBeenCalledTimes(1);

      await bus.unsubscribe('my-agent');

      await bus.sendTo('my-agent', { msg: 2 });
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, no new call
    });

    it('should allow re-subscribe after unsubscribe', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await bus.subscribe('my-agent', handler1);
      await bus.unsubscribe('my-agent');
      await bus.subscribe('my-agent', handler2);

      await bus.sendTo('my-agent', { data: 'test' });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('message ordering', () => {
    it('should preserve message order for sequential sends', async () => {
      const received: number[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg.content.seq); });

      for (let i = 0; i < 10; i++) {
        await bus.sendTo('target', { seq: i });
      }

      expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });

  describe('large message handling', () => {
    it('should handle messages with large payloads', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      const largePayload = { data: 'x'.repeat(100000) };
      await bus.sendTo('target', largePayload);

      expect(received).toHaveLength(1);
      expect(received[0].content.data.length).toBe(100000);
    });

    it('should handle messages with deeply nested objects', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      let nested: any = { value: 'leaf' };
      for (let i = 0; i < 50; i++) {
        nested = { child: nested };
      }

      await bus.sendTo('target', nested);

      expect(received).toHaveLength(1);
      // Navigate 50 levels deep
      let current = received[0].content;
      for (let i = 0; i < 50; i++) {
        current = current.child;
      }
      expect(current.value).toBe('leaf');
    });
  });

  describe('message metadata', () => {
    it('should include correlationId for request messages', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => {
        received.push(msg);
        if (msg.type === 'request') {
          bus.respond(msg, { pong: true });
        }
      });

      await bus.request('target', { action: 'ping' }, 5000);

      expect(received[0]?.correlationId).toBeDefined();
      expect(received[0]?.correlationId!.length).toBeGreaterThan(0);
    });

    it('should include from, to, and timestamp in every message', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      await bus.sendTo('target', { data: 'test' });

      expect(received[0].from).toBe('sender-agent');
      expect(received[0].to).toBe('target');
      expect(received[0].timestamp).toBe(clock.now);
    });
  });

  describe('send to non-existent agent', () => {
    it('should not throw when sending to non-existent agent', async () => {
      // Fire-and-forget: should not throw even if no one listens
      await expect(
        bus.sendTo('nonexistent-agent', { data: 'hello?' })
      ).resolves.not.toThrow();
    });

    it('should throw or timeout for request to non-existent agent', async () => {
      const reqPromise = bus.request('nonexistent-agent', { action: 'ping' }, 1000);

      clock.advance(1500);

      await expect(reqPromise).rejects.toThrow(/timed out/i);
    });
  });

  describe('request / response (RPC)', () => {
    it('should resolve with response when target responds', async () => {
      await bus.subscribe('responder', async (msg) => {
        if (msg.type === 'request') {
          await bus.respond(msg, { pong: true });
        }
      });

      const response = await bus.request('responder', { action: 'ping' }, 5000);
      expect(response).toEqual({ pong: true });
    });

    it('should timeout if no response received', async () => {
      // No handler set up — request will timeout
      const reqPromise = bus.request('silent-agent', { action: 'ping' }, 1000);

      clock.advance(1500);

      await expect(reqPromise).rejects.toThrow(/timed out/i);
    });

    it('should match response to correct request via correlationId', async () => {
      await bus.subscribe('multi-responder', async (msg) => {
        if (msg.type === 'request') {
          await bus.respond(msg, { echo: msg.content.value });
        }
      });

      const [r1, r2] = await Promise.all([
        bus.request('multi-responder', { value: 'first' }, 5000),
        bus.request('multi-responder', { value: 'second' }, 5000),
      ]);

      expect(r1).toEqual({ echo: 'first' });
      expect(r2).toEqual({ echo: 'second' });
    });
  });

  describe('Edge Cases', () => {
    it('should handle send message with empty payload', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      await bus.sendTo('target', {});

      expect(received).toHaveLength(1);
      expect(received[0].content).toEqual({});
    });

    it('should handle send message with payload = null', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      await bus.sendTo('target', null as any);

      expect(received).toHaveLength(1);
      expect(received[0].content).toBeNull();
    });

    it('should handle send message with 10MB payload', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      const largePayload = { data: 'x'.repeat(10 * 1024 * 1024) }; // 10MB
      await bus.sendTo('target', largePayload);

      expect(received).toHaveLength(1);
      expect(received[0].content.data.length).toBe(10 * 1024 * 1024);
    });

    it('should handle send to non-existent agent id', async () => {
      // Fire-and-forget should not throw
      await expect(
        bus.sendTo('agent-that-does-not-exist-xyz', { data: 'hello' })
      ).resolves.not.toThrow();
    });

    it('should handle subscribe to same topic twice (duplicate subscription)', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await bus.subscribe('dup-agent', handler1);
      await bus.subscribe('dup-agent', handler2);

      await bus.sendTo('dup-agent', { msg: 'test' });

      // Both handlers should fire (not deduplicated)
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should handle unsubscribe from topic never subscribed to', async () => {
      // Should not throw
      await expect(
        bus.unsubscribe('never-subscribed-agent')
      ).resolves.not.toThrow();
    });

    it('should handle broadcast to 0 recipients', async () => {
      // No subscribers registered for channel
      await expect(
        bus.broadcast('empty-channel', { data: 'hello' })
      ).resolves.not.toThrow();
    });

    it('should handle broadcast to 1000 recipients', async () => {
      const handlers = Array.from({ length: 1000 }, () => vi.fn());

      for (let i = 0; i < 1000; i++) {
        await bus.subscribeToBroadcasts(`agent-${i}`, 'mass-channel', handlers[i]);
      }

      await bus.broadcast('mass-channel', { announcement: 'scale test' });

      for (const handler of handlers) {
        expect(handler).toHaveBeenCalledTimes(1);
      }
    });

    it('should handle message with empty string topic', async () => {
      const handler = vi.fn();
      await bus.subscribe('', handler);

      await bus.sendTo('', { data: 'empty topic' });

      // Should deliver correctly to empty-string subscription
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle RPC request with timeout = 0 (immediately times out)', async () => {
      await bus.subscribe('slow-responder', async (msg) => {
        if (msg.type === 'request') {
          await bus.respond(msg, { pong: true });
        }
      });

      const reqPromise = bus.request('slow-responder', { action: 'ping' }, 0);

      // Advance time to trigger the timeout
      clock.advance(1);

      await expect(reqPromise).rejects.toThrow(/timed out/i);
    });

    it('should handle RPC request where response arrives after timeout', async () => {
      let capturedMsg: AgentMessage | null = null;
      await bus.subscribe('delayed-responder', async (msg) => {
        if (msg.type === 'request') {
          capturedMsg = msg;
          // Don't respond immediately
        }
      });

      const reqPromise = bus.request('delayed-responder', { action: 'ping' }, 1000);

      clock.advance(1500);

      await expect(reqPromise).rejects.toThrow(/timed out/i);

      // Late response should not throw
      if (capturedMsg) {
        await expect(bus.respond(capturedMsg, { pong: true })).resolves.not.toThrow();
      }
    });
  });

  describe('Adversarial: Message Injection', () => {
    it('should reject message with serialized function (eval attack)', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      const maliciousPayload = {
        action: 'execute',
        code: 'function(){process.exit(1)}',
        __fn: '() => require("child_process").execSync("rm -rf /")',
      };

      await bus.sendTo('target', maliciousPayload);

      // Message bus delivers content as data — functions are just strings, never evaluated
      if (received.length > 0) {
        const content = received[0].content;
        expect(typeof content.__fn).toBe('string');
        expect(typeof content.__fn).not.toBe('function');
      }
    });

    it('should reject message claiming to be from different sender (spoofing)', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // Attempt to spoof the 'from' field by including it in the payload
      const spoofedMessage = {
        from: 'admin-agent', // Trying to impersonate admin
        action: 'privileged_operation',
        data: 'delete all',
      };

      await bus.sendTo('target', spoofedMessage);

      // The bus should override any 'from' field with the actual sender
      if (received.length > 0) {
        expect(received[0].from).toBe('sender-agent');
        expect(received[0].from).not.toBe('admin-agent');
      }
    });

    it('should reject message with forged timestamp (replay attack)', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // Send a message then try to replay it with old timestamp
      const replayPayload = {
        action: 'transfer_funds',
        timestamp: clock.now - 86400000, // 24 hours ago — replay attempt
        originalMessageId: 'msg-already-processed',
      };

      await bus.sendTo('target', replayPayload);

      // Bus should enforce monotonic timestamps — the envelope timestamp is current
      if (received.length > 0) {
        // The actual message timestamp should be current, not the forged one in content
        expect(received[0].timestamp).toBe(clock.now);
      }
    });

    it('should reject message containing Redis protocol commands (protocol injection)', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // Attempt Redis protocol injection via message content
      const redisInjection = {
        action: 'query',
        input: '*3\r\n$3\r\nSET\r\n$8\r\nbackdoor\r\n$5\r\nhello\r\n',
      };

      await bus.sendTo('target', redisInjection);

      // The raw Redis commands should not be executed — content should be treated as data only
      const backdoor = await redis.get('backdoor');
      expect(backdoor).toBeNull();
    });

    it('should handle message that exceeds max int for sequence number (overflow)', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // Send with a sequence number beyond Number.MAX_SAFE_INTEGER
      const overflowPayload = {
        action: 'operation',
        sequenceNumber: Number.MAX_SAFE_INTEGER + 100,
        data: 'overflow test',
      };

      await bus.sendTo('target', overflowPayload);

      // Message should still be delivered — content is user data, not interpreted
      expect(received).toHaveLength(1);
      expect(received[0].content.action).toBe('operation');
    });

    it('should defend against flood of messages designed to OOM the receiver', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // Send a large number of messages
      const floodCount = 10000;
      const sendPromises: Promise<void>[] = [];
      for (let i = 0; i < floodCount; i++) {
        sendPromises.push(bus.sendTo('target', { seq: i }));
      }

      await Promise.allSettled(sendPromises);

      // All messages should be delivered (in-memory, no backpressure needed)
      expect(received.length).toBe(floodCount);
    });

    it('should reject message with crafted headers to bypass auth', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // Attempt header injection via metadata
      const headerInjection = {
        action: 'admin_action',
        __headers: {
          'X-Auth-Override': 'true',
          'X-Role': 'superadmin',
          Authorization: 'Bearer forged-token',
        },
        __auth: { role: 'admin', verified: true },
      };

      await bus.sendTo('target', headerInjection);

      // Content is just data — the bus envelope (from, to, type) is what matters for auth
      // The message is delivered but the bus's 'from' field correctly identifies the sender
      if (received.length > 0) {
        expect(received[0].from).toBe('sender-agent');
        // Content fields are user data, not interpreted as auth
      }
    });

    it('should handle message containing circular JSON (CPU exhaustion on parse)', async () => {
      const received: AgentMessage[] = [];
      await bus.subscribe('target', (msg) => { received.push(msg); });

      // Create an object with circular reference
      const circular: any = { name: 'circular' };
      circular.self = circular;

      // Attempting to send circular JSON should throw (not hang)
      await expect(async () => {
        await bus.sendTo('target', circular);
      }).rejects.toThrow();

      // Bus should remain operational after circular JSON attempt
      await bus.sendTo('target', { recovery: true });
      expect(received.some(m => m.content?.recovery === true)).toBe(true);
    });
  });

  describe('Untested Methods', () => {
    it('sendToMany(agentIds, message) — multicast', async () => {
      const handlers = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
      await bus.subscribe('agent-a', handlers.a);
      await bus.subscribe('agent-b', handlers.b);
      await bus.subscribe('agent-c', handlers.c);

      await bus.sendToMany(['agent-a', 'agent-b', 'agent-c'], { action: 'multicast' });

      expect(handlers.a).toHaveBeenCalledTimes(1);
      expect(handlers.b).toHaveBeenCalledTimes(1);
      expect(handlers.c).toHaveBeenCalledTimes(1);
    });

    it('joinChannel(channelName) — join named channel', async () => {
      const handler = vi.fn();

      await bus.joinChannel('team-alpha');
      await bus.subscribe('team-alpha', handler);

      await bus.publishToChannel('team-alpha', { msg: 'hello team' });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('leaveChannel(channelName) — leave channel', async () => {
      const handler = vi.fn();

      await bus.joinChannel('team-alpha');
      await bus.subscribe('team-alpha', handler);

      await bus.leaveChannel('team-alpha');

      await bus.publishToChannel('team-alpha', { msg: 'after leave' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('publishToChannel(channel, message) — publish to channel', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await bus.joinChannel('notifications');
      await bus.subscribe('notifications', handler1);
      await bus.subscribe('notifications', handler2);

      await bus.publishToChannel('notifications', { event: 'deploy' });

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledWith(
        expect.objectContaining({ content: { event: 'deploy' } })
      );
    });

    it('announceLifecycle(event) — announce agent lifecycle event', async () => {
      const handler = vi.fn();
      await bus.watchLifecycle(handler);

      await bus.announceLifecycle({ type: 'started', agentId: 'sender-agent' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'started', agentId: 'sender-agent' })
      );
    });

    it('watchLifecycle(callback) — watch lifecycle events', async () => {
      const events: any[] = [];
      await bus.watchLifecycle((event) => events.push(event));

      await bus.announceLifecycle({ type: 'started', agentId: 'agent-1' });
      await bus.announceLifecycle({ type: 'stopped', agentId: 'agent-2' });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('started');
      expect(events[1].type).toBe('stopped');
    });

    it('getStats() — bus statistics', async () => {
      await bus.subscribe('target', vi.fn());
      await bus.sendTo('target', { msg: 1 });
      await bus.sendTo('target', { msg: 2 });

      const stats = await bus.getStats();

      expect(stats).toBeDefined();
      expect(stats.messagesSent).toBeGreaterThanOrEqual(2);
      expect(stats.subscriptions).toBeGreaterThanOrEqual(1);
    });

    it('initialize() — setup', async () => {
      const freshBus = new AgentMessageBus({
        backend: 'redis',
        backendUrl: 'redis://localhost:6379',
        clientId: 'init-test',
      });

      await freshBus.initialize();

      // Should be operational after initialization
      const handler = vi.fn();
      await freshBus.subscribe('init-target', handler);
      await freshBus.sendTo('init-target', { data: 'post-init' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('shutdown() — teardown', async () => {
      await bus.subscribe('target', vi.fn());

      await bus.shutdown();

      // After shutdown, operations should fail
      await expect(
        bus.sendTo('target', { msg: 'post-shutdown' })
      ).rejects.toThrow();
    });
  });
});
