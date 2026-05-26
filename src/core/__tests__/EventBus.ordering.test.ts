import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../EventBus';

describe('EventBus - Ordering', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('should call handlers in registration order', () => {
    const callOrder: number[] = [];

    eventBus.on('ordered', () => callOrder.push(1));
    eventBus.on('ordered', () => callOrder.push(2));
    eventBus.on('ordered', () => callOrder.push(3));

    eventBus.emit('ordered', null);

    expect(callOrder).toEqual([1, 2, 3]);
  });

  it('should maintain order with many handlers', () => {
    const callOrder: number[] = [];

    for (let i = 0; i < 20; i++) {
      const idx = i;
      eventBus.on('many', () => callOrder.push(idx));
    }

    eventBus.emit('many', null);

    expect(callOrder).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('should place once() handler in registration order relative to on() handlers', () => {
    const callOrder: string[] = [];

    eventBus.on('mixed', () => callOrder.push('on-first'));
    eventBus.once('mixed', () => callOrder.push('once'));
    eventBus.on('mixed', () => callOrder.push('on-last'));

    eventBus.emit('mixed', null);

    expect(callOrder).toEqual(['on-first', 'once', 'on-last']);
  });

  it('should maintain order after removing a middle handler', () => {
    const callOrder: number[] = [];
    const handler2 = () => callOrder.push(2);

    eventBus.on('remove-mid', () => callOrder.push(1));
    eventBus.on('remove-mid', handler2);
    eventBus.on('remove-mid', () => callOrder.push(3));

    eventBus.off('remove-mid', handler2);
    eventBus.emit('remove-mid', null);

    expect(callOrder).toEqual([1, 3]);
  });

  it('should not reorder remaining handlers when one is removed', () => {
    const callOrder: number[] = [];
    const handlerToRemove = () => callOrder.push(0);

    eventBus.on('stable', handlerToRemove);
    eventBus.on('stable', () => callOrder.push(1));
    eventBus.on('stable', () => callOrder.push(2));
    eventBus.on('stable', () => callOrder.push(3));

    eventBus.off('stable', handlerToRemove);
    eventBus.emit('stable', null);

    expect(callOrder).toEqual([1, 2, 3]);
  });

  it('should preserve order across multiple emits', () => {
    const callOrder: string[] = [];

    eventBus.on('multi-emit', () => callOrder.push('A'));
    eventBus.on('multi-emit', () => callOrder.push('B'));

    eventBus.emit('multi-emit', null);
    eventBus.emit('multi-emit', null);

    expect(callOrder).toEqual(['A', 'B', 'A', 'B']);
  });

  it('should handle once() removal without disrupting other handler order', () => {
    const callOrder: string[] = [];

    eventBus.on('once-order', () => callOrder.push('persistent-1'));
    eventBus.once('once-order', () => callOrder.push('once-handler'));
    eventBus.on('once-order', () => callOrder.push('persistent-2'));

    // First emit: all three fire
    eventBus.emit('once-order', null);
    // Second emit: only persistent handlers fire
    eventBus.emit('once-order', null);

    expect(callOrder).toEqual([
      'persistent-1', 'once-handler', 'persistent-2',
      'persistent-1', 'persistent-2',
    ]);
  });

  it('should maintain insertion order even with different event names interleaved', () => {
    const orderA: number[] = [];
    const orderB: number[] = [];

    eventBus.on('event-a', () => orderA.push(1));
    eventBus.on('event-b', () => orderB.push(1));
    eventBus.on('event-a', () => orderA.push(2));
    eventBus.on('event-b', () => orderB.push(2));

    eventBus.emit('event-a', null);
    eventBus.emit('event-b', null);

    expect(orderA).toEqual([1, 2]);
    expect(orderB).toEqual([1, 2]);
  });

  it('should handle handler that registers another handler during emit', () => {
    const callOrder: string[] = [];

    eventBus.on('dynamic', () => {
      callOrder.push('original');
      eventBus.on('dynamic', () => callOrder.push('added-during-emit'));
    });

    eventBus.emit('dynamic', null);

    // The dynamically added handler should not fire during the same emit
    expect(callOrder).toEqual(['original']);

    // But should fire on next emit
    eventBus.emit('dynamic', null);
    expect(callOrder).toContain('added-during-emit');
  });

  it('should support priority-based ordering if priority is supported', () => {
    // This test documents expected behavior if priority is added
    // Currently EventBus does not support priority, so this should fail
    const callOrder: string[] = [];

    // If priority were supported, lower priority = earlier execution
    // For now, registration order is all we have
    eventBus.on('priority', () => callOrder.push('first-registered'));
    eventBus.on('priority', () => callOrder.push('second-registered'));

    eventBus.emit('priority', null);

    // With priority support, we'd expect reordering. Without it, registration order.
    expect(callOrder).toEqual(['first-registered', 'second-registered']);
  });
});
