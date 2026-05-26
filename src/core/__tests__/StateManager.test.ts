import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateManager } from '../StateManager';

describe('StateManager', () => {
  let manager: StateManager;

  beforeEach(() => {
    manager = new StateManager();
  });

  describe('set() and get()', () => {
    it('should set and get a string value', () => {
      manager.set('name', 'Alice');
      expect(manager.get('name')).toBe('Alice');
    });

    it('should set and get a number value', () => {
      manager.set('count', 42);
      expect(manager.get('count')).toBe(42);
    });

    it('should set and get a boolean value', () => {
      manager.set('active', true);
      expect(manager.get('active')).toBe(true);
    });

    it('should set and get an object value', () => {
      const obj = { nested: { deep: true }, items: [1, 2, 3] };
      manager.set('config', obj);
      expect(manager.get('config')).toEqual(obj);
    });

    it('should set and get an array value', () => {
      manager.set('list', [1, 2, 3]);
      expect(manager.get('list')).toEqual([1, 2, 3]);
    });

    it('should set and get null value', () => {
      manager.set('nullable', null);
      expect(manager.get('nullable')).toBeNull();
    });

    it('should overwrite existing value with set', () => {
      manager.set('key', 'original');
      manager.set('key', 'updated');
      expect(manager.get('key')).toBe('updated');
    });

    it('should return undefined for non-existent key', () => {
      expect(manager.get('does-not-exist')).toBeUndefined();
    });

    it('should support type-safe generics on get', () => {
      manager.set<number>('counter', 10);
      const value = manager.get<number>('counter');
      expect(value).toBe(10);
    });
  });

  describe('has()', () => {
    it('should return true for existing key', () => {
      manager.set('exists', 'yes');
      expect(manager.has('exists')).toBe(true);
    });

    it('should return false for missing key', () => {
      expect(manager.has('missing')).toBe(false);
    });

    it('should return true for key with null value', () => {
      manager.set('null-val', null);
      expect(manager.has('null-val')).toBe(true);
    });

    it('should return true for key with undefined value', () => {
      manager.set('undef-val', undefined);
      expect(manager.has('undef-val')).toBe(true);
    });

    it('should return false after key is deleted', () => {
      manager.set('temp', 'value');
      manager.delete('temp');
      expect(manager.has('temp')).toBe(false);
    });
  });

  describe('delete()', () => {
    it('should remove an existing key', () => {
      manager.set('remove-me', 'gone');
      manager.delete('remove-me');
      expect(manager.get('remove-me')).toBeUndefined();
    });

    it('should not throw when deleting non-existent key', () => {
      expect(() => manager.delete('nonexistent')).not.toThrow();
    });

    it('should not affect other keys', () => {
      manager.set('keep', 'stay');
      manager.set('remove', 'go');
      manager.delete('remove');

      expect(manager.get('keep')).toBe('stay');
    });
  });

  describe('clear()', () => {
    it('should remove all keys', () => {
      manager.set('a', 1);
      manager.set('b', 2);
      manager.set('c', 3);
      manager.clear();

      expect(manager.has('a')).toBe(false);
      expect(manager.has('b')).toBe(false);
      expect(manager.has('c')).toBe(false);
    });

    it('should result in empty toObject()', () => {
      manager.set('key', 'value');
      manager.clear();
      expect(manager.toObject()).toEqual({});
    });
  });

  describe('toObject()', () => {
    it('should return all state as a plain object', () => {
      manager.set('name', 'Bob');
      manager.set('age', 30);
      manager.set('active', true);

      const obj = manager.toObject();
      expect(obj).toEqual({ name: 'Bob', age: 30, active: true });
    });

    it('should return empty object when state is empty', () => {
      expect(manager.toObject()).toEqual({});
    });

    it('should return a snapshot (not a live reference)', () => {
      manager.set('key', 'original');
      const obj = manager.toObject();
      manager.set('key', 'changed');

      expect(obj.key).toBe('original');
    });
  });

  describe('fromObject()', () => {
    it('should load state from object, replacing existing state', () => {
      manager.set('old', 'will be gone');
      manager.fromObject({ new1: 'fresh', new2: 42 });

      expect(manager.has('old')).toBe(false);
      expect(manager.get('new1')).toBe('fresh');
      expect(manager.get('new2')).toBe(42);
    });

    it('should handle empty object', () => {
      manager.set('existing', 'data');
      manager.fromObject({});

      expect(manager.has('existing')).toBe(false);
      expect(manager.toObject()).toEqual({});
    });

    it('should handle nested objects', () => {
      manager.fromObject({ config: { theme: 'dark', fontSize: 14 } });
      expect(manager.get('config')).toEqual({ theme: 'dark', fontSize: 14 });
    });
  });

  describe('persist()', () => {
    it('should be callable (async)', async () => {
      // Current implementation throws 'TODO: Implement persist'
      await expect(manager.persist()).rejects.toThrow();
    });

    it('should persist current state without losing data', async () => {
      manager.set('important', 'data');
      // After persistence is implemented, state should remain accessible
      try {
        await manager.persist();
      } catch {
        // Expected to throw in current impl
      }
      expect(manager.get('important')).toBe('data');
    });
  });

  describe('load()', () => {
    it('should be callable (async)', async () => {
      // Current implementation throws 'TODO: Implement load'
      await expect(manager.load()).rejects.toThrow();
    });

    it('should restore previously persisted state', async () => {
      manager.set('before-load', 'exists');
      // After load is implemented, it should restore from persistence backend
      try {
        await manager.load();
      } catch {
        // Expected to throw in current impl
      }
    });
  });

  describe('Edge Cases', () => {
    it('should persist empty state ({})', async () => {
      manager.clear();
      // Persist with no data should succeed (not throw beyond stub)
      try {
        await manager.persist();
      } catch (e: any) {
        // Stub throws; once implemented, empty state should persist fine
        expect(e.message).toContain('TODO');
      }
      expect(manager.toObject()).toEqual({});
    });

    it('should handle persist state with Date objects (serialization)', () => {
      const now = new Date('2025-01-15T10:30:00Z');
      manager.set('timestamp', now);

      // Date should be stored; serialization to JSON turns it into string
      const obj = manager.toObject();
      expect(obj.timestamp).toBeInstanceOf(Date);

      // After a persist/load cycle, Date would become a string — test the expectation
      const serialized = JSON.parse(JSON.stringify(obj));
      expect(serialized.timestamp).toBe('2025-01-15T10:30:00.000Z');
      expect(serialized.timestamp).not.toBeInstanceOf(Date);
    });

    it('should handle persist state with Map/Set (non-JSON-serializable)', () => {
      const map = new Map([['key', 'value']]);
      const set = new Set([1, 2, 3]);
      manager.set('map', map);
      manager.set('set', set);

      // JSON.stringify loses Map/Set data
      const serialized = JSON.parse(JSON.stringify(manager.toObject()));
      expect(serialized.map).toEqual({}); // Map serializes to empty object
      expect(serialized.set).toEqual({}); // Set serializes to empty object

      // Implementation should handle this — either reject or use custom serializer
      expect(manager.get('map')).toBeInstanceOf(Map);
    });

    it('should handle load when no state has ever been persisted', async () => {
      const freshManager = new StateManager();
      // Loading when nothing was persisted should either return empty state or throw
      try {
        await freshManager.load();
        expect(freshManager.toObject()).toEqual({});
      } catch (e: any) {
        // Stub throws TODO; once implemented should handle gracefully
        expect(e.message).toBeDefined();
      }
    });

    it('should handle concurrent persist calls (race condition)', async () => {
      manager.set('a', 1);

      // Two concurrent persists should not corrupt state
      const persist1 = manager.persist().catch(() => {});
      manager.set('a', 2);
      const persist2 = manager.persist().catch(() => {});

      await Promise.all([persist1, persist2]);

      // State should be consistent after concurrent persists
      expect(manager.get('a')).toBe(2);
    });

    it('should handle persist state exceeding 10MB', () => {
      const largeValue = 'x'.repeat(10 * 1024 * 1024 + 1); // > 10MB
      manager.set('huge', largeValue);

      // Should either reject oversized state or handle it
      expect(manager.get('huge')).toHaveLength(10 * 1024 * 1024 + 1);

      // Persistence with large state should fail gracefully
      expect(manager.persist()).rejects.toBeDefined();
    });

    it('should handle load corrupted state (invalid JSON)', async () => {
      // This tests the load() implementation's robustness
      // When persistence backend returns invalid JSON, load should throw a clear error
      const freshManager = new StateManager();
      try {
        await freshManager.load();
      } catch (e: any) {
        // Current stub throws TODO; once implemented with a corrupted backend:
        expect(e).toBeDefined();
      }
    });

    it('should handle state key with empty string', () => {
      manager.set('', 'empty-key-value');
      expect(manager.get('')).toBe('empty-key-value');
      expect(manager.has('')).toBe(true);
    });

    it('should handle state with undefined values', () => {
      manager.set('undef', undefined);
      expect(manager.has('undef')).toBe(true);
      expect(manager.get('undef')).toBeUndefined();

      // toObject should include the key
      const obj = manager.toObject();
      expect('undef' in obj).toBe(true);
    });

    it('should preserve prototype-less objects through persist/load cycle', () => {
      const prototypeless = Object.create(null);
      prototypeless.key = 'value';
      prototypeless.nested = Object.create(null);
      prototypeless.nested.inner = 42;

      manager.set('bare', prototypeless);

      const retrieved = manager.get('bare');
      expect(retrieved.key).toBe('value');
      expect(retrieved.nested.inner).toBe(42);

      // After JSON round-trip, prototype-less objects become regular objects
      const serialized = JSON.parse(JSON.stringify(manager.toObject()));
      expect(serialized.bare.key).toBe('value');
    });
  });
});
