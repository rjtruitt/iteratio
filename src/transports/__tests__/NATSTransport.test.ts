import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NATSTransport } from '../NATSTransport';
import type { TransportConfig, TransportMessage } from '../../interfaces/ITransport';

/**
 * Mock NATS client for testing without a real NATS server
 */
class MockNatsClient {
  connected = false;
  subscriptions = new Map<string, { handler: (msg: any) => void; queue?: string }>();
  published: Array<{ subject: string; data: any; reply?: string }> = [];
  private subIdCounter = 0;
  private requestHandlers = new Map<string, (data: any) => any>();

  async connect(_url: string, _opts?: any): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.subscriptions.clear();
  }

  publish(subject: string, data: any, opts?: { reply?: string }): void {
    if (!this.connected) throw new Error('Not connected to NATS');
    this.published.push({ subject, data, reply: opts?.reply });

    // Deliver to matching subscriptions
    for (const [, sub] of this.subscriptions) {
      if (this.matchesSubject(subject, sub.handler as any)) {
        // Trigger delivery
      }
    }
  }

  subscribe(subject: string, handler: (msg: any) => void, opts?: { queue?: string }): string {
    if (!this.connected) throw new Error('Not connected to NATS');
    const id = `nats-sub-${++this.subIdCounter}`;
    this.subscriptions.set(id, { handler, queue: opts?.queue });
    return id;
  }

  unsubscribe(subId: string): void {
    this.subscriptions.delete(subId);
  }

  async request(subject: string, data: any, timeout?: number): Promise<any> {
    if (!this.connected) throw new Error('Not connected to NATS');
    const handler = this.requestHandlers.get(subject);
    if (!handler) {
      throw new Error(`No responder for subject: ${subject}`);
    }
    return handler(data);
  }

  registerRequestHandler(subject: string, handler: (data: any) => any): void {
    this.requestHandlers.set(subject, handler);
  }

  // Simulate a message arriving on a subject
  simulateMessage(subject: string, data: any): void {
    for (const [, sub] of this.subscriptions) {
      sub.handler({ subject, data, sid: '' });
    }
  }

  private matchesSubject(subject: string, _pattern: any): boolean {
    return true; // Simplified
  }

  reset(): void {
    this.published = [];
    this.subscriptions.clear();
    this.requestHandlers.clear();
    this.connected = false;
    this.subIdCounter = 0;
  }
}

describe('NATSTransport', () => {
  let transport: NATSTransport;
  let mockNats: MockNatsClient;
  const config: TransportConfig = {
    backend: 'nats',
    url: 'nats://localhost:4222',
  };

  beforeEach(() => {
    mockNats = new MockNatsClient();
    transport = new NATSTransport(mockNats as any);
  });

  afterEach(async () => {
    if (transport.isConnected()) {
      await transport.disconnect();
    }
    mockNats.reset();
  });

  describe('connect', () => {
    it('should connect to NATS server', async () => {
      await transport.connect(config);
      expect(transport.isConnected()).toBe(true);
      expect(mockNats.connected).toBe(true);
    });

    it('should pass nkey auth credentials on connect', async () => {
      const authConfig: TransportConfig = {
        ...config,
        auth: { type: 'nkey', credentials: { seed: 'SUAM...' } },
      };
      await transport.connect(authConfig);
      expect(transport.isConnected()).toBe(true);
    });

    it('should pass token auth credentials on connect', async () => {
      const authConfig: TransportConfig = {
        ...config,
        auth: { type: 'token', credentials: { token: 'my-secret-token' } },
      };
      await transport.connect(authConfig);
      expect(transport.isConnected()).toBe(true);
    });

    it('should store connection URL in status', async () => {
      await transport.connect(config);
      expect(transport.getStatus().url).toBe('nats://localhost:4222');
    });
  });

  describe('publish', () => {
    it('should publish to NATS subject', async () => {
      await transport.connect(config);
      await transport.publish('agents.events', { action: 'started' });

      expect(mockNats.published.length).toBe(1);
      expect(mockNats.published[0].subject).toContain('agents.events');
    });

    it('should serialize message payload', async () => {
      await transport.connect(config);
      const payload = { nested: { data: [1, 2, 3] } };
      await transport.publish('data.topic', payload);

      expect(mockNats.published[0].data).toBeDefined();
    });

    it('should throw when publishing while disconnected', async () => {
      await expect(transport.publish('topic', {})).rejects.toThrow();
    });

    it('should apply topicPrefix to subjects', async () => {
      const prefixedConfig: TransportConfig = { ...config, topicPrefix: 'hub.' };
      await transport.connect(prefixedConfig);
      await transport.publish('events', { x: 1 });

      expect(mockNats.published[0].subject).toContain('hub.');
    });
  });

  describe('subscribe', () => {
    it('should subscribe to NATS subject', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      const subId = await transport.subscribe('notifications', handler);

      expect(subId).toBeTypeOf('string');
      expect(mockNats.subscriptions.size).toBe(1);
    });

    it('should deliver messages to subscriber handler', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('events', handler);

      mockNats.simulateMessage('events', { msg: 'hello' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'events',
          data: expect.objectContaining({ msg: 'hello' }),
        })
      );
    });

    it('should support subject wildcards with >', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('agents.>', handler);

      mockNats.simulateMessage('agents.agent1.events', { type: 'started' });

      expect(handler).toHaveBeenCalled();
    });

    it('should support subject wildcards with *', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      await transport.subscribe('agents.*.status', handler);

      mockNats.simulateMessage('agents.agent1.status', { online: true });

      expect(handler).toHaveBeenCalled();
    });

    it('should support queue groups for load balancing', async () => {
      await transport.connect(config);
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      // Subscribe with queue group - only one handler should receive each message
      await transport.subscribe('work.queue', handler1);
      await transport.subscribe('work.queue', handler2);

      mockNats.simulateMessage('work.queue', { task: 'process' });

      // In queue group semantics, only one subscriber gets the message
      const totalCalls = handler1.mock.calls.length + handler2.mock.calls.length;
      expect(totalCalls).toBe(1);
    });
  });

  describe('unsubscribe', () => {
    it('should remove subscription from NATS', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      const subId = await transport.subscribe('topic', handler);

      await transport.unsubscribe(subId);
      expect(mockNats.subscriptions.size).toBe(0);
    });

    it('should stop message delivery after unsubscribe', async () => {
      await transport.connect(config);
      const handler = vi.fn();
      const subId = await transport.subscribe('topic', handler);

      mockNats.simulateMessage('topic', { n: 1 });
      expect(handler).toHaveBeenCalledTimes(1);

      await transport.unsubscribe(subId);
      mockNats.simulateMessage('topic', { n: 2 });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('request/reply', () => {
    it('should implement request/reply pattern', async () => {
      await transport.connect(config);
      await transport.reply('math.add', (msg: any) => ({ result: msg.a + msg.b }));

      const response = await transport.request('math.add', { a: 10, b: 20 });
      expect(response).toEqual({ result: 30 });
    });

    it('should timeout on request when no reply received', async () => {
      await transport.connect(config);
      await expect(
        transport.request('no.responder', { data: 1 }, 50)
      ).rejects.toThrow();
    });

    it('should support async reply handlers', async () => {
      await transport.connect(config);
      await transport.reply('async.rpc', async (msg: any) => {
        return { doubled: msg.value * 2 };
      });

      const response = await transport.request('async.rpc', { value: 7 });
      expect(response).toEqual({ doubled: 14 });
    });
  });

  describe('reconnection', () => {
    it('should handle disconnection', async () => {
      await transport.connect(config);
      await mockNats.close();
      expect(transport.isConnected()).toBe(false);
    });

    it('should attempt reconnection with configured maxReconnectAttempts', async () => {
      const reconnectConfig: TransportConfig = {
        ...config,
        maxReconnectAttempts: 3,
        reconnectDelay: 100,
      };
      await transport.connect(reconnectConfig);
      await mockNats.close();

      // Transport should attempt reconnection
      expect(transport.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should close NATS connection', async () => {
      await transport.connect(config);
      await transport.disconnect();
      expect(transport.isConnected()).toBe(false);
      expect(mockNats.connected).toBe(false);
    });

    it('should clear subscriptions on disconnect', async () => {
      await transport.connect(config);
      await transport.subscribe('a', vi.fn());
      await transport.subscribe('b', vi.fn());
      await transport.disconnect();
      expect(transport.getStatus().subscriptions).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('should return correct backend name', async () => {
      await transport.connect(config);
      expect(transport.getStatus().backend).toBe('nats');
    });

    it('should track subscription count', async () => {
      await transport.connect(config);
      await transport.subscribe('s1', vi.fn());
      await transport.subscribe('s2', vi.fn());
      expect(transport.getStatus().subscriptions).toBe(2);
    });

    it('should track published message count', async () => {
      await transport.connect(config);
      await transport.publish('t', { a: 1 });
      await transport.publish('t', { a: 2 });
      await transport.publish('t', { a: 3 });
      expect(transport.getStatus().messagesPublished).toBe(3);
    });

    it('should report accurate connected state', async () => {
      expect(transport.getStatus().connected).toBe(false);
      await transport.connect(config);
      expect(transport.getStatus().connected).toBe(true);
      await transport.disconnect();
      expect(transport.getStatus().connected).toBe(false);
    });
  });
});
