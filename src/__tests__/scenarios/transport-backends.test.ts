import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockTransport,
  MockEventBus,
  MockRedis,
  MockNatsClient,
  MockBroadcastChannel,
  installMockBroadcastChannel,
  uninstallMockBroadcastChannel,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 22: Transport Backends ---
// Same agent communication flow tested over different transports:
// Memory, BroadcastChannel, Redis PubSub, NATS.
// Also tests transport failover and reconnection buffering.

describe('E2E Scenario 22: Transport Backends', () => {
  let eventBus: MockEventBus;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    scheduler = new TestScheduler();
  });

  afterEach(() => {
    scheduler.reset();
    MockBroadcastChannel.resetAll();
  });

  // Standard communication flow that all transports must support
  async function runStandardFlow(transportA: any, transportB: any) {
    const received: any[] = [];

    // Agent B subscribes
    await transportB.subscribe('tasks', (msg: any) => {
      received.push(msg.data);
    });

    // Agent A publishes
    await transportA.publish('tasks', { action: 'process', payload: 'item-1' });

    // Agent B replies
    await transportB.publish('results', { taskId: 'item-1', result: 'done' });

    return received;
  }

  describe('MemoryTransport', () => {
    it('should support Agent A publishes, Agent B receives flow', async () => {
      const transportA = new MockTransport();
      const transportB = transportA; // same instance = in-memory

      await transportA.connect({ backend: 'memory' });

      const received: any[] = [];
      await transportB.subscribe('tasks', (msg: any) => {
        received.push(msg.data);
      });

      await transportA.publish('tasks', { action: 'process', payload: 'item-1' });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ action: 'process', payload: 'item-1' });
    });

    it('should support request-reply pattern', async () => {
      const transport = new MockTransport();
      await transport.connect({ backend: 'memory' });

      await transport.reply('compute', async (data: any) => {
        return { result: (data as any).x + (data as any).y };
      });

      const response = await transport.request('compute', { x: 2, y: 3 });
      expect(response).toEqual({ result: 5 });
    });

    it('should deliver messages only to matching topic subscribers', async () => {
      const transport = new MockTransport();
      await transport.connect({ backend: 'memory' });

      const tasksReceived: any[] = [];
      const logsReceived: any[] = [];

      await transport.subscribe('tasks', (msg: any) => tasksReceived.push(msg.data));
      await transport.subscribe('logs', (msg: any) => logsReceived.push(msg.data));

      await transport.publish('tasks', { id: 1 });
      await transport.publish('logs', { level: 'info' });

      expect(tasksReceived).toHaveLength(1);
      expect(logsReceived).toHaveLength(1);
    });
  });

  describe('BroadcastChannelTransport', () => {
    beforeEach(() => {
      installMockBroadcastChannel();
    });

    afterEach(() => {
      uninstallMockBroadcastChannel();
    });

    it('should deliver messages between two BroadcastChannel instances', async () => {
      const channelA = new MockBroadcastChannel('agents');
      const channelB = new MockBroadcastChannel('agents');

      const received: any[] = [];
      channelB.onmessage = (event) => received.push(event.data);

      channelA.postMessage({ action: 'process', payload: 'item-1' });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ action: 'process', payload: 'item-1' });
    });

    it('should not receive own messages (no echo)', async () => {
      const channel = new MockBroadcastChannel('agents');
      const received: any[] = [];
      channel.onmessage = (event) => received.push(event.data);

      channel.postMessage({ self: true });

      expect(received).toHaveLength(0);
    });

    it('should stop delivering after channel is closed', async () => {
      const channelA = new MockBroadcastChannel('agents');
      const channelB = new MockBroadcastChannel('agents');

      const received: any[] = [];
      channelB.onmessage = (event) => received.push(event.data);

      channelB.close();
      channelA.postMessage({ afterClose: true });

      expect(received).toHaveLength(0);
    });

    it('should support multiple channels with different names', async () => {
      const taskChannel = new MockBroadcastChannel('tasks');
      const logChannel = new MockBroadcastChannel('logs');

      const taskReceiver = new MockBroadcastChannel('tasks');
      const logReceiver = new MockBroadcastChannel('logs');

      const tasks: any[] = [];
      const logs: any[] = [];
      taskReceiver.onmessage = (e) => tasks.push(e.data);
      logReceiver.onmessage = (e) => logs.push(e.data);

      taskChannel.postMessage({ task: 1 });
      logChannel.postMessage({ log: 'info' });

      expect(tasks).toEqual([{ task: 1 }]);
      expect(logs).toEqual([{ log: 'info' }]);
    });
  });

  describe('RedisPubSubTransport', () => {
    let redis: MockRedis;

    beforeEach(() => {
      redis = new MockRedis();
    });

    afterEach(() => {
      redis.reset();
    });

    it('should deliver messages via Redis pub/sub', async () => {
      const received: string[] = [];

      await redis.subscribe('agent:tasks', (channel, message) => {
        received.push(message);
      });

      await redis.publish('agent:tasks', JSON.stringify({ action: 'process', payload: 'item-1' }));

      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0])).toEqual({ action: 'process', payload: 'item-1' });
    });

    it('should support multiple subscribers on same channel', async () => {
      const sub1: string[] = [];
      const sub2: string[] = [];

      await redis.subscribe('shared', (ch, msg) => sub1.push(msg));
      await redis.subscribe('shared', (ch, msg) => sub2.push(msg));

      await redis.publish('shared', 'hello');

      expect(sub1).toEqual(['hello']);
      expect(sub2).toEqual(['hello']);
    });

    it('should not deliver to unsubscribed channels', async () => {
      const received: string[] = [];
      await redis.subscribe('channel-a', (ch, msg) => received.push(msg));

      await redis.publish('channel-b', 'wrong channel');

      expect(received).toHaveLength(0);
    });

    it('should handle unsubscribe correctly', async () => {
      const received: string[] = [];
      await redis.subscribe('ephemeral', (ch, msg) => received.push(msg));

      await redis.publish('ephemeral', 'first');
      await redis.unsubscribe('ephemeral');
      await redis.publish('ephemeral', 'second');

      expect(received).toEqual(['first']);
    });
  });

  describe('NATSTransport', () => {
    let nats: MockNatsClient;

    beforeEach(async () => {
      nats = new MockNatsClient();
      await nats.connect({ servers: 'nats://localhost:4222' });
    });

    afterEach(() => {
      nats.reset();
    });

    it('should deliver messages via NATS subjects', () => {
      const received: Uint8Array[] = [];

      nats.subscribe('agent.tasks', (err, msg) => {
        received.push(msg.data);
      });

      const payload = new TextEncoder().encode(JSON.stringify({ action: 'process' }));
      nats.publish('agent.tasks', payload);

      expect(received).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(received[0]))).toEqual({ action: 'process' });
    });

    it('should support wildcard subscriptions', () => {
      const received: string[] = [];

      nats.subscribe('agent.*', (err, msg) => {
        received.push(msg.subject);
      });

      nats.publish('agent.tasks', new Uint8Array());
      nats.publish('agent.logs', new Uint8Array());
      nats.publish('other.topic', new Uint8Array());

      expect(received).toEqual(['agent.tasks', 'agent.logs']);
    });

    it('should support request-reply pattern', async () => {
      nats.subscribe('math.add', (err, msg) => {
        const data = JSON.parse(new TextDecoder().decode(msg.data));
        const result = new TextEncoder().encode(JSON.stringify({ sum: data.a + data.b }));
        msg.respond(result);
      });

      const response = await nats.request(
        'math.add',
        new TextEncoder().encode(JSON.stringify({ a: 3, b: 4 })),
      );

      const result = JSON.parse(new TextDecoder().decode(response.data));
      expect(result.sum).toBe(7);
    });

    it('should support multi-level wildcard (>)', () => {
      const received: string[] = [];

      nats.subscribe('agent.>', (err, msg) => {
        received.push(msg.subject);
      });

      nats.publish('agent.tasks.high', new Uint8Array());
      nats.publish('agent.logs.error', new Uint8Array());
      nats.publish('other.topic', new Uint8Array());

      expect(received).toEqual(['agent.tasks.high', 'agent.logs.error']);
    });
  });

  describe('Transport Behavior Equivalence', () => {
    it('should produce identical behavior across MemoryTransport and Redis', async () => {
      // MemoryTransport flow
      const memTransport = new MockTransport();
      await memTransport.connect({ backend: 'memory' });
      const memReceived: any[] = [];
      await memTransport.subscribe('topic', (msg: any) => memReceived.push(msg.data));
      await memTransport.publish('topic', { value: 42 });

      // Redis flow
      const redis = new MockRedis();
      const redisReceived: any[] = [];
      await redis.subscribe('topic', (ch, msg) => redisReceived.push(JSON.parse(msg)));
      await redis.publish('topic', JSON.stringify({ value: 42 }));

      // Both should have received same data
      expect(memReceived[0]).toEqual({ value: 42 });
      expect(redisReceived[0]).toEqual({ value: 42 });
    });

    it('should produce identical behavior across all 4 transports for basic pub/sub', async () => {
      installMockBroadcastChannel();

      // Memory
      const mem = new MockTransport();
      await mem.connect({ backend: 'memory' });
      const memR: any[] = [];
      await mem.subscribe('t', (msg: any) => memR.push(msg.data));
      await mem.publish('t', { x: 1 });

      // BroadcastChannel
      const bcSend = new MockBroadcastChannel('t');
      const bcRecv = new MockBroadcastChannel('t');
      const bcR: any[] = [];
      bcRecv.onmessage = (e) => bcR.push(e.data);
      bcSend.postMessage({ x: 1 });

      // Redis
      const redis = new MockRedis();
      const redR: any[] = [];
      await redis.subscribe('t', (ch, msg) => redR.push(JSON.parse(msg)));
      await redis.publish('t', JSON.stringify({ x: 1 }));

      // NATS
      const nats = new MockNatsClient();
      await nats.connect();
      const natsR: any[] = [];
      nats.subscribe('t', (err, msg) => natsR.push(JSON.parse(new TextDecoder().decode(msg.data))));
      nats.publish('t', new TextEncoder().encode(JSON.stringify({ x: 1 })));

      // All 4 should produce equivalent results
      expect(memR[0]).toEqual({ x: 1 });
      expect(bcR[0]).toEqual({ x: 1 });
      expect(redR[0]).toEqual({ x: 1 });
      expect(natsR[0]).toEqual({ x: 1 });

      uninstallMockBroadcastChannel();
    });
  });

  describe('Transport Failover', () => {
    it('should switch to fallback transport when primary fails', async () => {
      const primary = new MockTransport();
      const fallback = new MockTransport();
      await primary.connect({ backend: 'primary' });
      await fallback.connect({ backend: 'fallback' });

      // Simulate primary failure
      await primary.disconnect();

      // TransportManager should failover
      const manager = stateManager.get<any>('transportManager');
      manager.setPrimary(primary);
      manager.setFallback(fallback);

      await manager.publish('topic', { important: true });

      // Message should have gone through fallback
      expect(fallback.publishedMessages).toHaveLength(1);
      expect(fallback.publishedMessages[0].message).toEqual({ important: true });
    });

    it('should emit failover event when switching transports', async () => {
      const manager = stateManager.get<any>('transportManager');
      const primary = new MockTransport();
      const fallback = new MockTransport();

      await primary.connect({ backend: 'primary' });
      await fallback.connect({ backend: 'fallback' });

      manager.setPrimary(primary);
      manager.setFallback(fallback);

      await primary.disconnect();
      await manager.publish('topic', { data: 1 });

      expect(eventBus.emitted('transport:failover')).toBe(true);
    });
  });

  describe('Transport Reconnection', () => {
    it('should buffer messages during disconnect', async () => {
      const manager = stateManager.get<any>('transportManager');
      const transport = new MockTransport();
      await transport.connect({ backend: 'memory' });
      manager.setPrimary(transport);

      // Disconnect
      await transport.disconnect();

      // These should be buffered
      await manager.publish('topic', { msg: 1 });
      await manager.publish('topic', { msg: 2 });

      expect(manager.bufferedCount).toBe(2);
    });

    it('should flush buffered messages on reconnect', async () => {
      const manager = stateManager.get<any>('transportManager');
      const transport = new MockTransport();
      await transport.connect({ backend: 'memory' });
      manager.setPrimary(transport);

      await transport.disconnect();
      await manager.publish('topic', { msg: 1 });
      await manager.publish('topic', { msg: 2 });

      // Reconnect
      await transport.connect({ backend: 'memory' });
      await manager.reconnect();

      // Buffered messages should now be delivered
      expect(transport.publishedMessages).toHaveLength(2);
      expect(manager.bufferedCount).toBe(0);
    });

    it('should maintain message ordering during buffer+flush', async () => {
      const manager = stateManager.get<any>('transportManager');
      const transport = new MockTransport();
      await transport.connect({ backend: 'memory' });
      manager.setPrimary(transport);

      // Send before disconnect
      await manager.publish('topic', { seq: 1 });

      // Disconnect + buffer
      await transport.disconnect();
      await manager.publish('topic', { seq: 2 });
      await manager.publish('topic', { seq: 3 });

      // Reconnect + flush
      await transport.connect({ backend: 'memory' });
      await manager.reconnect();

      // Send after reconnect
      await manager.publish('topic', { seq: 4 });

      const messages = transport.publishedMessages.map(m => (m.message as any).seq);
      expect(messages).toEqual([1, 2, 3, 4]);
    });
  });
});
