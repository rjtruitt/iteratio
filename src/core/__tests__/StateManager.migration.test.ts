import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateManager } from '../StateManager';

describe('StateManager - Migration & Robustness', () => {
  let manager: StateManager;

  beforeEach(() => {
    manager = new StateManager();
  });

  describe('state version migration', () => {
    it('should support a version field in state', () => {
      manager.set('__version', 1);
      expect(manager.get('__version')).toBe(1);
    });

    it('should provide a migrate method for version upgrades', () => {
      // Expected: StateManager has a migrate(fromVersion, toVersion, migrationFn) method
      expect(typeof (manager as any).migrate).toBe('function');
    });

    it('should apply migration function when loading old state version', async () => {
      const oldState = { __version: 1, userName: 'Alice', score: 100 };
      manager.fromObject(oldState);

      // Migration from v1 to v2: rename userName -> name
      const migrationFn = (state: Record<string, unknown>) => ({
        ...state,
        name: state.userName,
        userName: undefined,
        __version: 2,
      });

      (manager as any).migrate(1, 2, migrationFn);

      expect(manager.get('name')).toBe('Alice');
      expect(manager.get('__version')).toBe(2);
    });

    it('should chain multiple migrations sequentially (v1 -> v2 -> v3)', async () => {
      const oldState = { __version: 1, data: 'raw' };
      manager.fromObject(oldState);

      const migrate1to2 = (state: Record<string, unknown>) => ({
        ...state,
        data: (state.data as string).toUpperCase(),
        __version: 2,
      });

      const migrate2to3 = (state: Record<string, unknown>) => ({
        ...state,
        data: `processed:${state.data}`,
        __version: 3,
      });

      (manager as any).migrate(1, 2, migrate1to2);
      (manager as any).migrate(2, 3, migrate2to3);

      expect(manager.get('__version')).toBe(3);
      expect(manager.get('data')).toBe('processed:RAW');
    });

    it('should not apply migration if version already matches target', () => {
      manager.fromObject({ __version: 2, value: 'current' });

      const migrationFn = vi.fn((state: Record<string, unknown>) => ({
        ...state,
        __version: 2,
      }));

      (manager as any).migrate(1, 2, migrationFn);

      // Should not call migration since version is already 2
      expect(migrationFn).not.toHaveBeenCalled();
    });
  });

  describe('partial state (missing keys)', () => {
    it('should handle fromObject with fewer keys than expected', () => {
      // Load partial state — missing keys should just be absent
      manager.fromObject({ name: 'Bob' });

      expect(manager.get('name')).toBe('Bob');
      expect(manager.get('age')).toBeUndefined();
      expect(manager.get('email')).toBeUndefined();
    });

    it('should not throw when accessing missing keys after fromObject', () => {
      manager.fromObject({});
      expect(() => manager.get('anything')).not.toThrow();
    });

    it('should allow setting missing keys after partial load', () => {
      manager.fromObject({ partial: true });
      manager.set('added', 'later');

      expect(manager.get('partial')).toBe(true);
      expect(manager.get('added')).toBe('later');
    });

    it('should provide a getOrDefault method for graceful fallbacks', () => {
      manager.fromObject({});

      // Expected: getOrDefault(key, defaultValue) returns default when key missing
      const value = (manager as any).getOrDefault('missing', 'fallback');
      expect(value).toBe('fallback');
    });

    it('should handle getOrDefault when key exists', () => {
      manager.set('present', 'real-value');
      const value = (manager as any).getOrDefault('present', 'fallback');
      expect(value).toBe('real-value');
    });
  });

  describe('schema changes between versions', () => {
    it('should handle renamed keys via migration', () => {
      manager.fromObject({ __version: 1, old_key: 'value' });

      const migrationFn = (state: Record<string, unknown>) => {
        const { old_key, ...rest } = state;
        return { ...rest, new_key: old_key, __version: 2 };
      };

      (manager as any).migrate(1, 2, migrationFn);

      expect(manager.has('old_key')).toBe(false);
      expect(manager.get('new_key')).toBe('value');
    });

    it('should handle type changes in values via migration', () => {
      // v1 stored count as string, v2 stores as number
      manager.fromObject({ __version: 1, count: '42' });

      const migrationFn = (state: Record<string, unknown>) => ({
        ...state,
        count: parseInt(state.count as string, 10),
        __version: 2,
      });

      (manager as any).migrate(1, 2, migrationFn);

      expect(manager.get('count')).toBe(42);
      expect(typeof manager.get('count')).toBe('number');
    });

    it('should handle added required fields with defaults', () => {
      manager.fromObject({ __version: 1, name: 'Test' });

      const migrationFn = (state: Record<string, unknown>) => ({
        ...state,
        createdAt: Date.now(),
        isActive: true,
        __version: 2,
      });

      (manager as any).migrate(1, 2, migrationFn);

      expect(manager.has('createdAt')).toBe(true);
      expect(manager.get('isActive')).toBe(true);
    });

    it('should handle removed fields during migration', () => {
      manager.fromObject({ __version: 1, keepMe: 'yes', removeMe: 'gone', alsoRemove: 'bye' });

      const migrationFn = (state: Record<string, unknown>) => {
        const { removeMe, alsoRemove, ...rest } = state;
        return { ...rest, __version: 2 };
      };

      (manager as any).migrate(1, 2, migrationFn);

      expect(manager.has('keepMe')).toBe(true);
      expect(manager.has('removeMe')).toBe(false);
      expect(manager.has('alsoRemove')).toBe(false);
    });
  });

  describe('corrupted state detection', () => {
    it('should detect corrupted state on load', async () => {
      // Expected: validate() method checks state integrity
      expect(typeof (manager as any).validate).toBe('function');
    });

    it('should reject state with invalid version field', () => {
      const corrupted = { __version: 'not-a-number', data: 'something' };
      manager.fromObject(corrupted);

      const isValid = (manager as any).validate();
      expect(isValid).toBe(false);
    });

    it('should reject state with unexpected types', () => {
      // Define expected schema, load state that violates it
      (manager as any).setSchema({
        count: 'number',
        name: 'string',
      });

      manager.fromObject({ count: 'not-a-number', name: 123 });

      const isValid = (manager as any).validate();
      expect(isValid).toBe(false);
    });

    it('should provide a way to reset to default state on corruption', () => {
      const defaults = { __version: 1, name: 'default', count: 0 };

      manager.fromObject({ __version: 'broken' });
      (manager as any).resetToDefaults(defaults);

      expect(manager.get('__version')).toBe(1);
      expect(manager.get('name')).toBe('default');
      expect(manager.get('count')).toBe(0);
    });

    it('should detect missing required keys as corruption', () => {
      (manager as any).setRequiredKeys(['__version', 'userId']);
      manager.fromObject({ __version: 1 }); // Missing userId

      const isValid = (manager as any).validate();
      expect(isValid).toBe(false);
    });
  });
});
