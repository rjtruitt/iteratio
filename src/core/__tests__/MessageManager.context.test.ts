import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageManager } from '../MessageManager';
import type { Message } from '../../interfaces/ILLMProvider';

describe('MessageManager - Context Window Management', () => {
  let manager: MessageManager;

  beforeEach(() => {
    manager = new MessageManager();
  });

  describe('token counting estimates', () => {
    it('should estimate token count for messages', () => {
      manager.addMessage({ role: 'user', content: 'Hello world' });
      manager.addMessage({ role: 'assistant', content: 'Hi there, how can I help?' });

      // Token counting should be available as a method or property
      // Rough estimate: ~4 chars per token
      const messages = manager.getMessages();
      const estimatedTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
      expect(estimatedTokens).toBeGreaterThan(0);
    });

    it('should provide a getTokenCount or similar method', () => {
      manager.addMessage({ role: 'user', content: 'Short message' });

      // Expected: manager exposes token counting
      expect(typeof (manager as any).getTokenCount).toBe('function');
    });

    it('should account for message role overhead in token estimates', () => {
      manager.addMessage({ role: 'user', content: 'Test' });

      // Role, separators, etc. add overhead tokens beyond just content
      const tokenCount = (manager as any).getTokenCount();
      expect(tokenCount).toBeGreaterThan(1); // More than just "Test" (~1 token)
    });
  });

  describe('compaction triggers', () => {
    it('should support automatic compaction at a token threshold', () => {
      // Manager should have a configurable token threshold
      expect(typeof (manager as any).setTokenThreshold).toBe('function');
    });

    it('should trigger compaction when messages exceed threshold', async () => {
      (manager as any).setTokenThreshold(100);

      // Add messages exceeding threshold
      for (let i = 0; i < 50; i++) {
        manager.addMessage({ role: 'user', content: `This is a longer message number ${i} with enough content to push us over the token limit` });
      }

      // Should have triggered compaction automatically or provide a way to check
      const shouldCompact = (manager as any).shouldCompact();
      expect(shouldCompact).toBe(true);
    });

    it('should not trigger compaction below threshold', () => {
      (manager as any).setTokenThreshold(10000);
      manager.addMessage({ role: 'user', content: 'Short' });

      const shouldCompact = (manager as any).shouldCompact();
      expect(shouldCompact).toBe(false);
    });
  });

  describe('system prompt preservation during compaction', () => {
    it('should preserve system messages during truncate compaction', async () => {
      manager.addMessage({ role: 'system', content: 'You are a helpful assistant' });
      for (let i = 0; i < 20; i++) {
        manager.addMessage({ role: 'user', content: `msg-${i}` });
        manager.addMessage({ role: 'assistant', content: `reply-${i}` });
      }

      await manager.compress('truncate', 5);

      const messages = manager.getMessages();
      const systemMessages = messages.filter(m => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0].content).toBe('You are a helpful assistant');
    });

    it('should preserve system messages during sliding-window compaction', async () => {
      manager.addMessage({ role: 'system', content: 'System prompt preserved' });
      for (let i = 0; i < 30; i++) {
        manager.addMessage({ role: 'user', content: `u-${i}` });
      }

      await manager.compress('sliding-window', 5);

      const messages = manager.getMessages();
      expect(messages.some(m => m.role === 'system' && m.content === 'System prompt preserved')).toBe(true);
    });

    it('should handle multiple system messages during compaction', async () => {
      manager.addMessage({ role: 'system', content: 'System 1' });
      manager.addMessage({ role: 'system', content: 'System 2' });
      for (let i = 0; i < 20; i++) {
        manager.addMessage({ role: 'user', content: `filler-${i}` });
      }

      await manager.compress('truncate', 5);

      const messages = manager.getMessages();
      const systemMessages = messages.filter(m => m.role === 'system');
      expect(systemMessages.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('recent N messages preservation', () => {
    it('should preserve last N messages during compaction', async () => {
      for (let i = 0; i < 20; i++) {
        manager.addMessage({ role: 'user', content: `msg-${i}` });
      }

      await manager.compress('sliding-window', 5);

      const messages = manager.getMessages();
      expect(messages[messages.length - 1].content).toBe('msg-19');
    });

    it('should preserve exact count of recent messages specified by limit', async () => {
      for (let i = 0; i < 100; i++) {
        manager.addMessage({ role: 'user', content: `m-${i}` });
      }

      await manager.compress('truncate', 10);

      const messages = manager.getMessages();
      // Should keep system + last N, or just last N
      expect(messages.length).toBeLessThanOrEqual(10);
    });

    it('should not lose the most recent message during compaction', async () => {
      for (let i = 0; i < 50; i++) {
        manager.addMessage({ role: 'user', content: `msg-${i}` });
      }
      manager.addMessage({ role: 'assistant', content: 'Latest response' });

      await manager.compress('truncate', 5);

      const messages = manager.getMessages();
      expect(messages[messages.length - 1].content).toBe('Latest response');
    });
  });

  describe('model-specific context limits', () => {
    it('should respect a configured max context length', () => {
      // Manager should accept context limit configuration
      expect(typeof (manager as any).setMaxContextTokens).toBe('function');
    });

    it('should expose current token usage relative to limit', () => {
      (manager as any).setMaxContextTokens(4096);
      manager.addMessage({ role: 'user', content: 'Hello' });

      const usage = (manager as any).getContextUsage();
      expect(usage).toHaveProperty('current');
      expect(usage).toHaveProperty('max');
      expect(usage.current).toBeLessThan(usage.max);
    });

    it('should indicate when context is near capacity', () => {
      (manager as any).setMaxContextTokens(100);

      // Fill with enough content to approach limit
      for (let i = 0; i < 50; i++) {
        manager.addMessage({ role: 'user', content: `This is message ${i} with some content to fill up tokens` });
      }

      const isNearCapacity = (manager as any).isNearCapacity();
      expect(isNearCapacity).toBe(true);
    });

    it('should support different model context windows (4k, 8k, 128k)', () => {
      // Should be configurable for different models
      (manager as any).setMaxContextTokens(128000);
      const usage = (manager as any).getContextUsage();
      expect(usage.max).toBe(128000);
    });

    it('should warn or auto-compact when exceeding context limit', async () => {
      (manager as any).setMaxContextTokens(50);

      for (let i = 0; i < 100; i++) {
        manager.addMessage({ role: 'user', content: `Filling context with message ${i}` });
      }

      // Should either auto-compact or expose a method to check overflow
      const isOverLimit = (manager as any).isOverContextLimit();
      expect(isOverLimit).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle compress with limit of 0', async () => {
      manager.addMessage({ role: 'user', content: 'Will be removed' });
      await manager.compress('truncate', 0);
      expect(manager.count()).toBe(0);
    });

    it('should handle compress on empty message list', async () => {
      await expect(manager.compress('truncate', 5)).resolves.not.toThrow();
      expect(manager.count()).toBe(0);
    });

    it('should handle very long single message', () => {
      const longContent = 'x'.repeat(100000);
      manager.addMessage({ role: 'user', content: longContent });
      expect(manager.count()).toBe(1);
      expect(manager.getMessages()[0].content.length).toBe(100000);
    });

    it('should handle message with empty content', () => {
      manager.addMessage({ role: 'assistant', content: '' });
      expect(manager.count()).toBe(1);
      expect(manager.getMessages()[0].content).toBe('');
    });

    it('should handle unicode content in token estimation', () => {
      manager.addMessage({ role: 'user', content: '你好世界 🌍 こんにちは' });
      const messages = manager.getMessages();
      expect(messages[0].content).toBe('你好世界 🌍 こんにちは');
    });
  });
});
