/**
 * Scenario Family 9: State Recovery from Corruption
 * Tests detection of corrupted state, fallback to last known good state,
 * partial state handling, schema migration, validation/repair, and conflict resolution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockLLMProvider,
  MockRedis,
  MockEventBus,
  MockStateManager,
  MockMessageManager,
  MockToolExecutor,
  TestAgentFactory,
  TestClock,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { AgentLoop } from '../../core/AgentLoop';
import { StateValidator } from '../../state/StateValidator';
import { StateRecovery } from '../../state/StateRecovery';
import { StateMigrator } from '../../state/StateMigrator';
import { StateConflictResolver } from '../../state/StateConflictResolver';

describe('State Recovery - E2E', () => {
  let eventBus: MockEventBus;
  let clock: TestClock;

  beforeEach(() => {
    eventBus = new MockEventBus();
    clock = new TestClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('corrupted state detection and fallback', () => {
    it('should detect corrupted state and fallback to last known good', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: {
            counter: { type: 'number', min: 0 },
            status: { type: 'string', enum: ['idle', 'running', 'done'] },
          },
        }),
      });

      // Last known good state
      recovery.saveGoodState({ counter: 5, status: 'running' });

      // Corrupted state (counter is negative, which is invalid)
      const corrupted = { counter: -1, status: 'running' };
      const result = await recovery.validateAndRecover(corrupted);

      expect(result.recovered).toBe(true);
      expect(result.state.counter).toBe(5); // Fell back to last good
      expect(result.corruption).toContain('counter');
    });

    it('should detect type corruption (string where number expected)', async () => {
      const validator = new StateValidator({
        schema: {
          counter: { type: 'number' },
          name: { type: 'string' },
        },
      });

      const corrupted = { counter: 'not a number', name: 42 };
      const errors = validator.validate(corrupted);

      expect(errors.length).toBe(2);
      expect(errors.some(e => e.field === 'counter' && e.reason === 'type_mismatch')).toBe(true);
      expect(errors.some(e => e.field === 'name' && e.reason === 'type_mismatch')).toBe(true);
    });

    it('should emit event when corruption is detected', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: { status: { type: 'string', enum: ['idle', 'running', 'done'] } },
        }),
        eventBus,
      });

      recovery.saveGoodState({ status: 'idle' });
      await recovery.validateAndRecover({ status: 'INVALID_STATUS' });

      expect(eventBus.emitted('state:corruption-detected')).toBe(true);
    });

    it('should keep history of good states for multi-level fallback', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: { value: { type: 'number', min: 0, max: 100 } },
        }),
        historySize: 3,
      });

      recovery.saveGoodState({ value: 10 });
      recovery.saveGoodState({ value: 20 });
      recovery.saveGoodState({ value: 30 });

      // All good states should be available for fallback
      const history = recovery.getGoodStateHistory();
      expect(history).toHaveLength(3);
      expect(history.map(s => s.value)).toEqual([10, 20, 30]);
    });
  });

  describe('partial state recovery', () => {
    it('should fill missing keys with defaults', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: {
            counter: { type: 'number', default: 0 },
            status: { type: 'string', default: 'idle' },
            items: { type: 'array', default: [] },
          },
        }),
      });

      // State with some keys missing
      const partial = { counter: 5 }; // Missing status and items
      const result = await recovery.validateAndRecover(partial);

      expect(result.state.counter).toBe(5); // Keep existing
      expect(result.state.status).toBe('idle'); // Filled default
      expect(result.state.items).toEqual([]); // Filled default
      expect(result.filledDefaults).toEqual(['status', 'items']);
    });

    it('should not overwrite valid existing values with defaults', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: {
            counter: { type: 'number', default: 0 },
            name: { type: 'string', default: 'unnamed' },
          },
        }),
      });

      const state = { counter: 42, name: 'Agent Alpha' };
      const result = await recovery.validateAndRecover(state);

      expect(result.state.counter).toBe(42);
      expect(result.state.name).toBe('Agent Alpha');
      expect(result.filledDefaults).toEqual([]);
    });

    it('should handle null state gracefully', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: {
            counter: { type: 'number', default: 0 },
            status: { type: 'string', default: 'idle' },
          },
        }),
      });

      const result = await recovery.validateAndRecover(null);
      expect(result.state.counter).toBe(0);
      expect(result.state.status).toBe('idle');
    });
  });

  describe('state migration between schema versions', () => {
    it('should migrate state from v1 schema to v2 schema', async () => {
      const migrator = new StateMigrator({
        migrations: [
          {
            from: 1,
            to: 2,
            migrate: (state: any) => ({
              ...state,
              // v2 renames 'count' to 'counter' and adds 'version'
              counter: state.count,
              version: 2,
              count: undefined,
            }),
          },
        ],
      });

      const v1State = { count: 10, status: 'running', schemaVersion: 1 };
      const v2State = await migrator.migrate(v1State, 2);

      expect(v2State.counter).toBe(10);
      expect(v2State.version).toBe(2);
      expect(v2State.count).toBeUndefined();
    });

    it('should chain multiple migrations (v1 → v2 → v3)', async () => {
      const migrator = new StateMigrator({
        migrations: [
          {
            from: 1,
            to: 2,
            migrate: (state: any) => ({ ...state, counter: state.count, schemaVersion: 2 }),
          },
          {
            from: 2,
            to: 3,
            migrate: (state: any) => ({ ...state, metrics: { counter: state.counter }, schemaVersion: 3 }),
          },
        ],
      });

      const v1State = { count: 7, schemaVersion: 1 };
      const v3State = await migrator.migrate(v1State, 3);

      expect(v3State.metrics.counter).toBe(7);
      expect(v3State.schemaVersion).toBe(3);
    });

    it('should throw if migration path does not exist', async () => {
      const migrator = new StateMigrator({
        migrations: [
          { from: 1, to: 2, migrate: (s: any) => s },
        ],
      });

      const state = { schemaVersion: 1 };
      await expect(migrator.migrate(state, 5)).rejects.toThrow(/no migration path/i);
    });

    it('should validate state after migration', async () => {
      const migrator = new StateMigrator({
        migrations: [
          {
            from: 1,
            to: 2,
            migrate: (state: any) => ({ counter: String(state.count), schemaVersion: 2 }), // Bug: counter should be number
          },
        ],
        validator: new StateValidator({
          schema: { counter: { type: 'number' } },
        }),
      });

      const v1State = { count: 10, schemaVersion: 1 };
      await expect(migrator.migrate(v1State, 2)).rejects.toThrow(/validation failed after migration/i);
    });
  });

  describe('invalid state value repair', () => {
    it('should clamp out-of-range numeric values', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: {
            progress: { type: 'number', min: 0, max: 1 },
            retries: { type: 'number', min: 0, max: 10 },
          },
        }),
        repairStrategy: 'clamp',
      });

      const invalid = { progress: 1.5, retries: -3 };
      const result = await recovery.validateAndRecover(invalid);

      expect(result.state.progress).toBe(1); // Clamped to max
      expect(result.state.retries).toBe(0); // Clamped to min
      expect(result.repaired).toBe(true);
    });

    it('should replace invalid enum values with default', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: {
            status: { type: 'string', enum: ['idle', 'running', 'done'], default: 'idle' },
          },
        }),
        repairStrategy: 'default',
      });

      const invalid = { status: 'broken_state_xyz' };
      const result = await recovery.validateAndRecover(invalid);

      expect(result.state.status).toBe('idle');
      expect(result.repaired).toBe(true);
    });

    it('should remove unknown keys not in schema', async () => {
      const recovery = new StateRecovery({
        validator: new StateValidator({
          schema: {
            counter: { type: 'number' },
            status: { type: 'string' },
          },
          strictMode: true, // No extra keys allowed
        }),
        repairStrategy: 'strip-unknown',
      });

      const stateWithExtra = { counter: 5, status: 'idle', hackedField: 'malicious', __proto__: {} };
      const result = await recovery.validateAndRecover(stateWithExtra);

      expect(result.state).toEqual({ counter: 5, status: 'idle' });
      expect(result.state).not.toHaveProperty('hackedField');
    });
  });

  describe('state conflict resolution', () => {
    it('should resolve conflict when two agents wrote the same key', async () => {
      const resolver = new StateConflictResolver({ strategy: 'last-write-wins' });

      const conflict = {
        key: 'counter',
        writes: [
          { agentId: 'agent-a', value: 10, timestamp: 1000 },
          { agentId: 'agent-b', value: 20, timestamp: 1001 },
        ],
      };

      const resolved = await resolver.resolve(conflict);
      expect(resolved.value).toBe(20); // Agent B wrote last
      expect(resolved.winner).toBe('agent-b');
    });

    it('should support merge strategy for object values', async () => {
      const resolver = new StateConflictResolver({ strategy: 'merge' });

      const conflict = {
        key: 'config',
        writes: [
          { agentId: 'agent-a', value: { theme: 'dark', lang: 'en' }, timestamp: 1000 },
          { agentId: 'agent-b', value: { theme: 'light', fontSize: 14 }, timestamp: 1001 },
        ],
      };

      const resolved = await resolver.resolve(conflict);
      // Merge: later values win for conflicting keys, all keys preserved
      expect(resolved.value.theme).toBe('light'); // B wins
      expect(resolved.value.lang).toBe('en'); // Only A had this
      expect(resolved.value.fontSize).toBe(14); // Only B had this
    });

    it('should support custom resolution function', async () => {
      const resolver = new StateConflictResolver({
        strategy: 'custom',
        customResolver: (conflict) => {
          // Always pick the higher value for numeric conflicts
          const values = conflict.writes.map(w => w.value as number);
          return { value: Math.max(...values), winner: 'custom' };
        },
      });

      const conflict = {
        key: 'score',
        writes: [
          { agentId: 'agent-a', value: 95, timestamp: 1000 },
          { agentId: 'agent-b', value: 87, timestamp: 1001 },
        ],
      };

      const resolved = await resolver.resolve(conflict);
      expect(resolved.value).toBe(95); // Higher value wins regardless of timestamp
    });

    it('should log conflict resolution for audit', async () => {
      const resolver = new StateConflictResolver({ strategy: 'last-write-wins', eventBus });

      const conflict = {
        key: 'status',
        writes: [
          { agentId: 'agent-a', value: 'done', timestamp: 1000 },
          { agentId: 'agent-b', value: 'running', timestamp: 999 },
        ],
      };

      await resolver.resolve(conflict);

      expect(eventBus.emitted('state:conflict-resolved')).toBe(true);
      const event = eventBus.lastEmitted<any>('state:conflict-resolved');
      expect(event.key).toBe('status');
      expect(event.winner).toBe('agent-a');
    });
  });
});
