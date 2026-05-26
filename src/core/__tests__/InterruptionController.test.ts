import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InterruptionController } from '../InterruptionController';

describe('InterruptionController', () => {
  let controller: InterruptionController;

  beforeEach(() => {
    controller = new InterruptionController();
  });

  describe('initial state', () => {
    it('should not be interrupted initially', () => {
      expect(controller.isInterrupted()).toBe(false);
    });

    it('should not be paused initially', () => {
      expect(controller.isPaused()).toBe(false);
    });

    it('should not indicate stop initially', () => {
      expect(controller.shouldStop()).toBe(false);
    });

    it('should not throw on checkInterrupted initially', () => {
      expect(() => controller.checkInterrupted()).not.toThrow();
    });
  });

  describe('interrupt() / cancel()', () => {
    it('should set interrupted/cancelled state via cancel()', () => {
      controller.cancel();
      expect(controller.shouldStop()).toBe(true);
    });

    it('should make isInterrupted return true after interrupt/cancel', () => {
      controller.cancel();
      expect(controller.isInterrupted()).toBe(true);
    });

    it('should provide an interrupt() method that signals stop', () => {
      // The interface specifies interrupt(), implementation has cancel()
      // Test that the expected interrupt() method exists
      expect(typeof (controller as any).interrupt).toBe('function');
      (controller as any).interrupt();
      expect(controller.shouldStop()).toBe(true);
    });
  });

  describe('isInterrupted() / shouldStop()', () => {
    it('should return false when running', () => {
      expect(controller.shouldStop()).toBe(false);
    });

    it('should return true after cancel', () => {
      controller.cancel();
      expect(controller.shouldStop()).toBe(true);
    });

    it('should remain true after multiple calls to cancel', () => {
      controller.cancel();
      controller.cancel();
      controller.cancel();
      expect(controller.shouldStop()).toBe(true);
    });
  });

  describe('checkInterrupted()', () => {
    it('should throw when interrupted/cancelled', () => {
      controller.cancel();
      expect(() => controller.checkInterrupted()).toThrow();
    });

    it('should not throw when not interrupted', () => {
      expect(() => controller.checkInterrupted()).not.toThrow();
    });

    it('should throw a meaningful error message', () => {
      controller.cancel();
      expect(() => controller.checkInterrupted()).toThrow(/cancel|interrupt/i);
    });
  });

  describe('reset()', () => {
    it('should clear interrupted/cancelled state', () => {
      controller.cancel();
      controller.reset();
      expect(controller.shouldStop()).toBe(false);
    });

    it('should clear paused state', () => {
      controller.pause();
      controller.reset();
      expect(controller.isPaused()).toBe(false);
    });

    it('should allow normal operation after reset', () => {
      controller.cancel();
      controller.reset();
      expect(() => controller.checkInterrupted()).not.toThrow();
    });

    it('should be idempotent when called multiple times', () => {
      controller.reset();
      controller.reset();
      expect(controller.shouldStop()).toBe(false);
      expect(controller.isPaused()).toBe(false);
    });
  });

  describe('pause() and resume()', () => {
    it('should pause execution', () => {
      controller.pause();
      expect(controller.isPaused()).toBe(true);
    });

    it('should resume after pause', () => {
      controller.pause();
      controller.resume();
      expect(controller.isPaused()).toBe(false);
    });

    it('should not set shouldStop when paused', () => {
      controller.pause();
      expect(controller.shouldStop()).toBe(false);
    });

    it('should handle pause when already paused (idempotent)', () => {
      controller.pause();
      controller.pause();
      expect(controller.isPaused()).toBe(true);
    });
  });

  describe('multiple interrupts are idempotent', () => {
    it('should handle multiple cancel calls without error', () => {
      expect(() => {
        controller.cancel();
        controller.cancel();
        controller.cancel();
      }).not.toThrow();
    });

    it('should remain in cancelled state after multiple cancels', () => {
      controller.cancel();
      controller.cancel();
      expect(controller.shouldStop()).toBe(true);
    });
  });

  describe('interrupt during tool execution scenario', () => {
    it('should allow checking interruption between tool calls', async () => {
      // Simulate sequential tool execution with interruption check
      const toolResults: string[] = [];

      const executeTool = async (name: string) => {
        controller.checkInterrupted();
        toolResults.push(name);
      };

      await executeTool('tool-1');
      controller.cancel();

      expect(() => executeTool('tool-2')).rejects.toThrow();
      expect(toolResults).toEqual(['tool-1']);
    });

    it('should support waitForResume for pause during execution', async () => {
      controller.pause();

      // waitForResume should return a promise that resolves on resume
      const waitPromise = controller.waitForResume();
      expect(waitPromise).toBeInstanceOf(Promise);

      // Resume should resolve the promise
      setTimeout(() => controller.resume(), 10);
      await expect(waitPromise).resolves.toBeUndefined();
    });

    it('should reject waitForResume when cancelled during pause', async () => {
      controller.pause();

      const waitPromise = controller.waitForResume();

      setTimeout(() => controller.cancel(), 10);
      await expect(waitPromise).rejects.toThrow(/cancel/i);
    });
  });
});
