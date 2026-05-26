import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../EventBus';
import { CoreEvents } from '../../interfaces/IEventBus';

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  describe('on()', () => {
    it('should register a handler and receive events', () => {
      const handler = vi.fn();
      eventBus.on('test:event', handler);
      eventBus.emit('test:event', { value: 42 });

      expect(handler).toHaveBeenCalledWith({ value: 42 });
    });

    it('should support multiple handlers for the same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      eventBus.on('multi', handler1);
      eventBus.on('multi', handler2);
      eventBus.on('multi', handler3);

      eventBus.emit('multi', 'payload');

      expect(handler1).toHaveBeenCalledWith('payload');
      expect(handler2).toHaveBeenCalledWith('payload');
      expect(handler3).toHaveBeenCalledWith('payload');
    });

    it('should not call handler for different events', () => {
      const handler = vi.fn();
      eventBus.on('event-a', handler);
      eventBus.emit('event-b', 'data');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should call handler for each emit', () => {
      const handler = vi.fn();
      eventBus.on('repeat', handler);

      eventBus.emit('repeat', 1);
      eventBus.emit('repeat', 2);
      eventBus.emit('repeat', 3);

      expect(handler).toHaveBeenCalledTimes(3);
    });
  });

  describe('off()', () => {
    it('should remove a specific handler', () => {
      const handler = vi.fn();
      eventBus.on('removable', handler);
      eventBus.off('removable', handler);
      eventBus.emit('removable', 'data');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should only remove the specified handler, not others', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.on('shared', handler1);
      eventBus.on('shared', handler2);
      eventBus.off('shared', handler1);

      eventBus.emit('shared', 'still here');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith('still here');
    });

    it('should not throw when removing non-existent handler', () => {
      const handler = vi.fn();
      expect(() => eventBus.off('nonexistent', handler)).not.toThrow();
    });
  });

  describe('once()', () => {
    it('should fire handler exactly once', () => {
      const handler = vi.fn();
      eventBus.once('one-time', handler);

      eventBus.emit('one-time', 'first');
      eventBus.emit('one-time', 'second');
      eventBus.emit('one-time', 'third');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('first');
    });

    it('should auto-unsubscribe after first call', () => {
      const handler = vi.fn();
      eventBus.once('auto-unsub', handler);

      eventBus.emit('auto-unsub', 'data');
      eventBus.emit('auto-unsub', 'data again');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should receive typed data on the single call', () => {
      const handler = vi.fn();
      eventBus.once<{ count: number }>('typed', handler);
      eventBus.emit('typed', { count: 99 });

      expect(handler).toHaveBeenCalledWith({ count: 99 });
    });
  });

  describe('emit()', () => {
    it('should deliver data to all registered handlers', () => {
      const results: number[] = [];
      eventBus.on('collect', (data: number) => results.push(data));
      eventBus.on('collect', (data: number) => results.push(data * 2));

      eventBus.emit('collect', 5);

      expect(results).toEqual([5, 10]);
    });

    it('should be a no-op when no handlers registered for event', () => {
      // Should not throw
      expect(() => eventBus.emit('nobody-listening', { data: true })).not.toThrow();
    });

    it('should deliver complex object data', () => {
      const handler = vi.fn();
      const payload = { nested: { deep: [1, 2, 3] }, flag: true };
      eventBus.on('complex', handler);
      eventBus.emit('complex', payload);

      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('should deliver null and undefined data', () => {
      const handler = vi.fn();
      eventBus.on('nullable', handler);

      eventBus.emit('nullable', null);
      expect(handler).toHaveBeenCalledWith(null);

      eventBus.emit('nullable', undefined);
      expect(handler).toHaveBeenCalledWith(undefined);
    });
  });

  describe('clear()', () => {
    it('should remove all handlers for all events', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.on('event-a', handler1);
      eventBus.on('event-b', handler2);
      eventBus.clear();

      eventBus.emit('event-a', 'a');
      eventBus.emit('event-b', 'b');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should allow new handlers to be registered after clear', () => {
      const handler = vi.fn();
      eventBus.on('pre-clear', handler);
      eventBus.clear();

      const newHandler = vi.fn();
      eventBus.on('post-clear', newHandler);
      eventBus.emit('post-clear', 'works');

      expect(newHandler).toHaveBeenCalledWith('works');
    });
  });

  describe('typed events', () => {
    it('should receive typed data matching the generic parameter', () => {
      interface TurnData { turnNumber: number; duration: number }
      const handler = vi.fn<[TurnData], void>();

      eventBus.on<TurnData>(CoreEvents.TURN_END, handler);
      eventBus.emit<TurnData>(CoreEvents.TURN_END, { turnNumber: 1, duration: 500 });

      expect(handler).toHaveBeenCalledWith({ turnNumber: 1, duration: 500 });
    });
  });

  describe('error handling', () => {
    it('should not crash other handlers when one throws synchronously', () => {
      const errorHandler = vi.fn(() => { throw new Error('Handler exploded'); });
      const safeHandler = vi.fn();

      eventBus.on('risky', errorHandler);
      eventBus.on('risky', safeHandler);

      // The EventBus uses Promise.resolve().catch() so errors are swallowed
      eventBus.emit('risky', 'data');

      // Both handlers should have been called (emit iterates all)
      expect(errorHandler).toHaveBeenCalled();
      expect(safeHandler).toHaveBeenCalled();
    });

    it('should not crash other handlers when one rejects (async)', () => {
      const asyncErrorHandler = vi.fn(async () => { throw new Error('Async fail'); });
      const safeHandler = vi.fn();

      eventBus.on('async-risky', asyncErrorHandler);
      eventBus.on('async-risky', safeHandler);

      eventBus.emit('async-risky', 'data');

      expect(asyncErrorHandler).toHaveBeenCalled();
      expect(safeHandler).toHaveBeenCalled();
    });
  });

  describe('CoreEvents integration', () => {
    it('should work with CoreEvents enum values', () => {
      const handler = vi.fn();
      eventBus.on(CoreEvents.STEP_START, handler);
      eventBus.emit(CoreEvents.STEP_START, { stepName: 'call-llm' });

      expect(handler).toHaveBeenCalledWith({ stepName: 'call-llm' });
    });

    it('should distinguish between different CoreEvents', () => {
      const startHandler = vi.fn();
      const endHandler = vi.fn();

      eventBus.on(CoreEvents.TURN_START, startHandler);
      eventBus.on(CoreEvents.TURN_END, endHandler);

      eventBus.emit(CoreEvents.TURN_START, { turn: 1 });

      expect(startHandler).toHaveBeenCalled();
      expect(endHandler).not.toHaveBeenCalled();
    });
  });

  describe('handler synchronous execution', () => {
    it('should call handlers synchronously during emit (fire-and-forget for async)', () => {
      const callOrder: string[] = [];

      eventBus.on('sync-check', () => { callOrder.push('handler'); });
      eventBus.emit('sync-check', null);
      callOrder.push('after-emit');

      // Handler is invoked synchronously within emit, but wraps in Promise.resolve
      expect(callOrder[0]).toBe('handler');
      expect(callOrder[1]).toBe('after-emit');
    });
  });

  describe('Edge Cases', () => {
    it('should handle emit with no subscribers (no-op)', () => {
      expect(() => eventBus.emit('nobody-cares', { data: true })).not.toThrow();
    });

    it('should not receive events when subscribe and immediately unsubscribe', () => {
      const handler = vi.fn();
      eventBus.on('fleeting', handler);
      eventBus.off('fleeting', handler);

      eventBus.emit('fleeting', 'missed');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should not block other subscribers when one throws', () => {
      const thrower = vi.fn(() => { throw new Error('I crash'); });
      const survivor = vi.fn();

      eventBus.on('risky-event', thrower);
      eventBus.on('risky-event', survivor);

      eventBus.emit('risky-event', 'payload');

      expect(thrower).toHaveBeenCalled();
      expect(survivor).toHaveBeenCalled();
    });

    it('should handle a subscriber that unsubscribes itself during callback', () => {
      const handler = vi.fn(() => {
        eventBus.off('self-remove', handler);
      });

      eventBus.on('self-remove', handler);
      eventBus.emit('self-remove', 'first');
      eventBus.emit('self-remove', 'second');

      // Handler should only be called once (it unsubscribes itself)
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('first');
    });

    it('should handle emit with undefined payload', () => {
      const handler = vi.fn();
      eventBus.on('undef-payload', handler);

      eventBus.emit('undef-payload', undefined);

      expect(handler).toHaveBeenCalledWith(undefined);
    });

    it('should handle emit with payload containing circular reference', () => {
      const handler = vi.fn();
      eventBus.on('circular', handler);

      const circular: any = { name: 'loop' };
      circular.self = circular;

      // Should not throw due to circular reference
      expect(() => eventBus.emit('circular', circular)).not.toThrow();
      expect(handler).toHaveBeenCalledWith(circular);
    });

    it('should handle 10000 subscribers on same event', () => {
      const handlers: ReturnType<typeof vi.fn>[] = [];
      for (let i = 0; i < 10000; i++) {
        const handler = vi.fn();
        handlers.push(handler);
        eventBus.on('mass-event', handler);
      }

      eventBus.emit('mass-event', 'broadcast');

      // All 10000 handlers should be called
      expect(handlers.every(h => h.mock.calls.length === 1)).toBe(true);
    });

    it('should handle event name with empty string', () => {
      const handler = vi.fn();
      eventBus.on('', handler);
      eventBus.emit('', 'empty-name-event');

      expect(handler).toHaveBeenCalledWith('empty-name-event');
    });

    it('should handle event name with special characters', () => {
      const handler = vi.fn();
      const specialName = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
      eventBus.on(specialName, handler);
      eventBus.emit(specialName, 'special');

      expect(handler).toHaveBeenCalledWith('special');
    });

    it('should handle emit during another emit (re-entrant emit)', () => {
      const innerHandler = vi.fn();
      eventBus.on('inner-event', innerHandler);

      const outerHandler = vi.fn(() => {
        eventBus.emit('inner-event', 'from-outer');
      });
      eventBus.on('outer-event', outerHandler);

      eventBus.emit('outer-event', 'trigger');

      expect(outerHandler).toHaveBeenCalledWith('trigger');
      expect(innerHandler).toHaveBeenCalledWith('from-outer');
    });
  });
});
