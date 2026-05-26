import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageManager } from '../MessageManager';
import type { Message } from '../../interfaces/ILLMProvider';

describe('MessageManager', () => {
  let manager: MessageManager;

  beforeEach(() => {
    manager = new MessageManager();
  });

  describe('addMessage()', () => {
    it('should store a message', () => {
      manager.addMessage({ role: 'user', content: 'Hello' });
      expect(manager.count()).toBe(1);
    });

    it('should store multiple messages', () => {
      manager.addMessage({ role: 'user', content: 'First' });
      manager.addMessage({ role: 'assistant', content: 'Second' });
      manager.addMessage({ role: 'user', content: 'Third' });
      expect(manager.count()).toBe(3);
    });

    it('should store system messages', () => {
      manager.addMessage({ role: 'system', content: 'You are helpful' });
      const msgs = manager.getMessages();
      expect(msgs[0].role).toBe('system');
    });

    it('should store tool messages with tool_call_id', () => {
      manager.addMessage({ role: 'tool', content: '{"result": true}', tool_call_id: 'call_1' });
      const msgs = manager.getMessages();
      expect(msgs[0].tool_call_id).toBe('call_1');
    });

    it('should store messages with name field', () => {
      manager.addMessage({ role: 'user', content: 'Hi', name: 'alice' });
      const msgs = manager.getMessages();
      expect(msgs[0].name).toBe('alice');
    });
  });

  describe('getMessages()', () => {
    it('should return all messages in insertion order', () => {
      manager.addMessage({ role: 'system', content: 'System' });
      manager.addMessage({ role: 'user', content: 'User' });
      manager.addMessage({ role: 'assistant', content: 'Assistant' });

      const msgs = manager.getMessages();
      expect(msgs).toHaveLength(3);
      expect(msgs[0].content).toBe('System');
      expect(msgs[1].content).toBe('User');
      expect(msgs[2].content).toBe('Assistant');
    });

    it('should return empty array when no messages', () => {
      expect(manager.getMessages()).toEqual([]);
    });

    it('should return a copy (not mutate internal state)', () => {
      manager.addMessage({ role: 'user', content: 'Original' });
      const msgs = manager.getMessages();
      msgs.push({ role: 'user', content: 'Injected' });

      expect(manager.count()).toBe(1);
    });

    it('should filter by role when option provided', () => {
      manager.addMessage({ role: 'system', content: 'sys' });
      manager.addMessage({ role: 'user', content: 'u1' });
      manager.addMessage({ role: 'assistant', content: 'a1' });
      manager.addMessage({ role: 'user', content: 'u2' });

      const userMessages = manager.getMessages({ role: 'user' });
      expect(userMessages).toHaveLength(2);
      expect(userMessages.every(m => m.role === 'user')).toBe(true);
    });

    it('should respect limit option returning last N messages', () => {
      for (let i = 0; i < 10; i++) {
        manager.addMessage({ role: 'user', content: `msg-${i}` });
      }

      const limited = manager.getMessages({ limit: 3 });
      expect(limited).toHaveLength(3);
      expect(limited[0].content).toBe('msg-7');
      expect(limited[2].content).toBe('msg-9');
    });

    it('should combine role and limit filters', () => {
      manager.addMessage({ role: 'user', content: 'u1' });
      manager.addMessage({ role: 'assistant', content: 'a1' });
      manager.addMessage({ role: 'user', content: 'u2' });
      manager.addMessage({ role: 'assistant', content: 'a2' });
      manager.addMessage({ role: 'user', content: 'u3' });

      const result = manager.getMessages({ role: 'user', limit: 2 });
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('u2');
      expect(result[1].content).toBe('u3');
    });

    it('should return all messages when limit exceeds count', () => {
      manager.addMessage({ role: 'user', content: 'only one' });
      const result = manager.getMessages({ limit: 100 });
      expect(result).toHaveLength(1);
    });
  });

  describe('clear()', () => {
    it('should remove all messages', () => {
      manager.addMessage({ role: 'user', content: 'Will be cleared' });
      manager.addMessage({ role: 'assistant', content: 'Also cleared' });
      manager.clear();

      expect(manager.count()).toBe(0);
      expect(manager.getMessages()).toEqual([]);
    });

    it('should allow adding messages after clear', () => {
      manager.addMessage({ role: 'user', content: 'Before' });
      manager.clear();
      manager.addMessage({ role: 'user', content: 'After' });

      expect(manager.count()).toBe(1);
      expect(manager.getMessages()[0].content).toBe('After');
    });
  });

  describe('count()', () => {
    it('should return 0 for empty manager', () => {
      expect(manager.count()).toBe(0);
    });

    it('should return correct count after adds', () => {
      manager.addMessage({ role: 'user', content: '1' });
      manager.addMessage({ role: 'user', content: '2' });
      expect(manager.count()).toBe(2);
    });

    it('should return 0 after clear', () => {
      manager.addMessage({ role: 'user', content: 'x' });
      manager.clear();
      expect(manager.count()).toBe(0);
    });
  });

  describe('compress()', () => {
    it('should implement truncate strategy removing oldest messages', async () => {
      for (let i = 0; i < 10; i++) {
        manager.addMessage({ role: 'user', content: `msg-${i}` });
      }

      await manager.compress('truncate', 5);

      expect(manager.count()).toBe(5);
      const msgs = manager.getMessages();
      expect(msgs[0].content).toBe('msg-5');
      expect(msgs[4].content).toBe('msg-9');
    });

    it('should implement sliding-window strategy keeping recent N', async () => {
      for (let i = 0; i < 20; i++) {
        manager.addMessage({ role: 'user', content: `msg-${i}` });
      }

      await manager.compress('sliding-window', 5);

      expect(manager.count()).toBe(5);
      const msgs = manager.getMessages();
      expect(msgs[0].content).toBe('msg-15');
    });

    it('should do nothing if message count is within limit', async () => {
      manager.addMessage({ role: 'user', content: 'only one' });

      await manager.compress('truncate', 10);

      expect(manager.count()).toBe(1);
    });

    it('should handle summarize strategy', async () => {
      for (let i = 0; i < 10; i++) {
        manager.addMessage({ role: 'user', content: `msg-${i}` });
      }

      // Summarize requires LLM — should either work or throw meaningful error
      await expect(manager.compress('summarize', 3)).rejects.toThrow();
    });
  });

  describe('message ordering', () => {
    it('should maintain insertion order across mixed roles', () => {
      const sequence: Message[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'tool', content: 'tool result', tool_call_id: 'c1' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u2' },
      ];

      sequence.forEach(m => manager.addMessage(m));

      const msgs = manager.getMessages();
      expect(msgs.map(m => m.content)).toEqual([
        'sys', 'u1', 'a1', 'tool result', 'a2', 'u2'
      ]);
    });
  });

  describe('large history', () => {
    it('should handle 1000 messages without issues', () => {
      for (let i = 0; i < 1000; i++) {
        manager.addMessage({ role: 'user', content: `message-${i}` });
      }

      expect(manager.count()).toBe(1000);
      const msgs = manager.getMessages();
      expect(msgs[0].content).toBe('message-0');
      expect(msgs[999].content).toBe('message-999');
    });

    it('should handle getMessages with limit on large history', () => {
      for (let i = 0; i < 1000; i++) {
        manager.addMessage({ role: 'user', content: `m-${i}` });
      }

      const last10 = manager.getMessages({ limit: 10 });
      expect(last10).toHaveLength(10);
      expect(last10[0].content).toBe('m-990');
    });

    it('should handle clear on large history', () => {
      for (let i = 0; i < 1000; i++) {
        manager.addMessage({ role: 'user', content: `m-${i}` });
      }
      manager.clear();
      expect(manager.count()).toBe(0);
    });
  });

  describe('Adversarial: Message Flooding', () => {
    it.todo('should handle or reject adding 1 million messages rapidly');

    it.todo('should reject or truncate a single message with 100MB content');

    it.todo('should reject messages with no role field');

    it.todo('should reject messages with unexpected role values');

    it('should handle getMessages with limit = -1', () => {
      manager.addMessage({ role: 'user', content: 'test' });

      // Negative limit: slice(-1) returns last element
      const result = manager.getMessages({ limit: -1 });
      // Current behavior: negative limit is passed to slice which returns from end
      expect(result).toHaveLength(1);
    });

    it('should handle getMessages with unknown options gracefully', () => {
      manager.addMessage({ role: 'user', content: 'only one' });

      // Offset is not a recognized option; getMessages ignores unknown options
      const result = manager.getMessages({ offset: 9999 } as any);
      // Returns all messages since offset is not processed
      expect(result).toHaveLength(1);
    });

    it.todo('should not compress when all messages are system messages');

    it('should handle messages with content that triggers regex catastrophic backtracking', () => {
      // Content designed to cause ReDoS if any regex is applied to message content
      const evilContent = 'a'.repeat(50) + '!';
      manager.addMessage({ role: 'user', content: evilContent });

      // Operations on messages should complete in bounded time
      const start = performance.now();
      manager.getMessages();
      const elapsed = performance.now() - start;

      // MessageManager does not apply any regex to message content
      expect(elapsed).toBeLessThan(100);
    });

    it('should handle concurrent addMessage calls from multiple sources', async () => {
      // Simulate concurrent adds (race condition)
      const promises = Array.from({ length: 100 }, (_, i) =>
        Promise.resolve().then(() => manager.addMessage({ role: 'user', content: `concurrent-${i}` }))
      );

      await Promise.all(promises);

      // In single-threaded JS with microtask-level concurrency, all messages are stored
      expect(manager.count()).toBe(100);
      const msgs = manager.getMessages();
      const contents = msgs.map(m => m.content);
      const unique = new Set(contents);
      expect(unique.size).toBe(100);
    });

    it('should handle message with deeply nested JSON content (1000 levels)', () => {
      // Build deeply nested object
      let nested: any = { value: 'leaf' };
      for (let i = 0; i < 1000; i++) {
        nested = { child: nested };
      }
      const deepContent = JSON.stringify(nested);

      manager.addMessage({ role: 'user', content: deepContent });

      // Should not crash or exhaust stack on storage/retrieval
      const msgs = manager.getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content.length).toBeGreaterThan(0);
    });
  });
});
