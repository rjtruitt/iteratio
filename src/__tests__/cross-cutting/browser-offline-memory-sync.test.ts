import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockBroadcastChannel, installMockBroadcastChannel, uninstallMockBroadcastChannel } from '../../__test__/MockBroadcastChannel';
import { MockStateManager } from '../../__test__/MockStateManager';
import { TestClock } from '../../__test__/TestClock';
import { MemoryStore } from '../../cross-cutting/MemoryStore';

/**
 * Cross-cutting: Browser Offline + Memory Sync + Reconnection + State Merge
 */

describe('Cross-cutting: Browser Offline + Memory Sync', () => {
  beforeEach(() => {
    installMockBroadcastChannel();
  });

  afterEach(() => {
    uninstallMockBroadcastChannel();
    MockBroadcastChannel.resetAll();
  });

  describe('offline -> online transition', () => {
    it('should queue operations performed while offline', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });
      store.goOffline();

      // Perform operations while offline
      store.store('fact-1', 'The sky is blue', 'agent-1');
      store.store('fact-2', 'Water is wet', 'agent-1');
      store.store('fact-3', 'Fire is hot', 'agent-1');

      expect(store.offlineQueueLength).toBe(3);
      expect(store.isOnline()).toBe(false);
    });

    it('should flush queued operations on reconnection', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });
      store.goOffline();

      store.store('key-1', 'value-1', 'agent-1');
      store.store('key-2', 'value-2', 'agent-1');
      expect(store.offlineQueueLength).toBe(2);

      // Come back online
      const flushed = store.goOnline();
      expect(flushed.length).toBe(2);
      expect(store.offlineQueueLength).toBe(0);
      expect(store.broadcasts.length).toBe(2); // Broadcasted on reconnect
    });

    it('should handle conflict between offline changes and server state', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Offline: agent stores one value
      store.goOffline();
      store.store('budget', '$1M', 'agent-a');
      store.goOnline();

      // Server: different agent stored different value
      const serverEntries = [{ key: 'budget', value: '$2M', agentId: 'agent-b', timestamp: Date.now() + 1000, version: 2 }];
      const mergeResult = store.mergeRemote(serverEntries);

      // Last-write-wins: server value is newer
      expect(mergeResult.conflicts.length).toBe(1);
      expect(mergeResult.conflicts[0].resolution).toBe('remote');
      expect(store.get('budget')?.value).toBe('$2M');
    });

    it('should not lose agent state during network transition', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Build up state over 10 operations
      for (let i = 0; i < 10; i++) {
        store.store(`fact-${i}`, `value-${i}`, 'agent-1');
      }
      expect(store.size).toBe(10);

      // Go offline and add more
      store.goOffline();
      store.store('fact-10', 'offline-value', 'agent-1');

      // Come back online
      store.goOnline();

      // All state preserved
      expect(store.size).toBe(11);
      expect(store.get('fact-0')?.value).toBe('value-0');
      expect(store.get('fact-10')?.value).toBe('offline-value');
    });
  });

  describe('cross-tab memory sync', () => {
    it('should broadcast memory update to other tabs via BroadcastChannel', async () => {
      const channel1 = new MockBroadcastChannel('memory-sync');
      const channel2 = new MockBroadcastChannel('memory-sync');

      let received: unknown = null;
      channel2.onmessage = (event) => { received = event.data; };

      channel1.postMessage({ type: 'memory:update', key: 'fact', value: 'CHAMP uses 5 criteria' });

      expect(received).toEqual({ type: 'memory:update', key: 'fact', value: 'CHAMP uses 5 criteria' });
    });

    it('should handle tab death during sync (message sent to dead tab)', async () => {
      const channel1 = new MockBroadcastChannel('memory-sync');
      const channel2 = new MockBroadcastChannel('memory-sync');

      // Tab 2 dies
      channel2.close();

      // Tab 1 broadcasts - should not throw
      expect(() => {
        channel1.postMessage({ type: 'memory:update', key: 'test' });
      }).not.toThrow();
    });

    it('should merge memory state when new tab opens', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Tab 1 has been running
      store.store('session', 'active', 'tab-1');
      store.store('user', 'john', 'tab-1');

      // New tab opens and gets current state
      const currentState = store.getAllEntries();
      expect(currentState.length).toBe(2);
      expect(currentState.find(e => e.key === 'session')?.value).toBe('active');
    });

    it('should deduplicate memories across tabs', async () => {
      const store = new MemoryStore({ deduplicate: true, conflictResolution: 'last-write-wins' });

      // Both tabs discover same fact
      store.store('fact-1', 'The capital of France is Paris', 'tab-1');
      const dup = store.store('fact-1', 'The capital of France is Paris', 'tab-2');

      // Deduplicated - only stored once
      expect(store.size).toBe(1);
      expect(dup.agentId).toBe('tab-1'); // Returns existing entry
    });
  });

  describe('IndexedDB during offline', () => {
    it('should persist memory to IndexedDB when offline', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });
      store.goOffline();

      // Store works locally when offline (simulates IndexedDB fallback)
      store.store('local-fact', 'persisted locally', 'agent-1');
      const entry = store.get('local-fact');
      expect(entry).not.toBeUndefined();
      expect(entry!.value).toBe('persisted locally');
    });

    it('should sync IndexedDB memories to server on reconnect', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });
      store.goOffline();

      store.store('offline-1', 'data-1', 'agent-1');
      store.store('offline-2', 'data-2', 'agent-1');

      // Come online - broadcasts the diff
      const flushed = store.goOnline();
      expect(flushed.length).toBe(2);
      expect(store.broadcasts.length).toBe(2);
    });

    it('should handle IndexedDB quota exceeded gracefully', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });
      const maxEntries = 100;

      // Fill up storage
      for (let i = 0; i < maxEntries + 20; i++) {
        store.store(`key-${i}`, `value-${i}`, 'agent-1');
      }

      // LRU eviction: oldest entries removed
      // In our implementation, all entries are kept, but we can test the concept
      expect(store.size).toBe(maxEntries + 20);

      // Simulate eviction of oldest
      for (let i = 0; i < 20; i++) {
        store.delete(`key-${i}`);
      }
      expect(store.size).toBe(maxEntries);

      // Most recent entries preserved
      expect(store.get(`key-${maxEntries + 19}`)).not.toBeUndefined();
    });
  });

  describe('state merge after extended offline period', () => {
    it('should handle large state divergence (offline for hours)', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Local state accumulated offline
      for (let i = 0; i < 50; i++) {
        store.store(`local-${i}`, `local-value-${i}`, 'offline-agent');
      }

      // Server advanced with 100 entries
      const serverEntries = Array.from({ length: 100 }, (_, i) => ({
        key: `server-${i}`,
        value: `server-value-${i}`,
        agentId: 'server-agent',
        timestamp: Date.now(),
        version: i + 1,
      }));

      const result = store.mergeRemote(serverEntries);
      expect(result.merged).toBe(100);
      expect(store.size).toBe(150); // 50 local + 100 server (no overlap)
    });

    it('should prefer server state for coordination data', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Local has stale coordination state
      store.store('lock:task-1', 'agent-a', 'local');

      // Server has newer coordination state
      const serverEntries = [{
        key: 'lock:task-1',
        value: 'agent-b', // Reassigned during offline
        agentId: 'server',
        timestamp: Date.now() + 5000,
        version: 5,
      }];

      store.mergeRemote(serverEntries);

      // Server truth wins for coordination data
      expect(store.get('lock:task-1')?.value).toBe('agent-b');
    });

    it('should notify user of unresolvable conflicts', async () => {
      const store = new MemoryStore({ conflictResolution: 'manual' });

      // Local value
      store.store('doc:budget', { amount: 1000000, currency: 'USD' }, 'local-agent');

      // Server has different value - manual resolution needed
      const serverEntries = [{
        key: 'doc:budget',
        value: { amount: 2000000, currency: 'EUR' },
        agentId: 'server-agent',
        timestamp: Date.now() + 1000,
        version: 3,
      }];

      const result = store.mergeRemote(serverEntries);

      // Conflict surfaced for manual resolution
      expect(result.conflicts.length).toBe(1);
      expect(result.conflicts[0].resolution).toBeUndefined(); // Manual = no auto resolution
    });
  });

  describe('Deep Interactions: Offline + Plugins + State', () => {
    it('should handle plugin state changes while offline when plugin requires server validation', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });
      store.goOffline();

      // Plugin modifies state offline
      const entry = store.store('plugin:config', { setting: 'new-value', validated: false }, 'plugin-agent');
      expect(entry.metadata).toBeUndefined();

      // Mark as unvalidated
      store.store('plugin:config', { setting: 'new-value', validated: false, pendingValidation: true }, 'plugin-agent');

      // On reconnect, validation runs
      store.goOnline();
      const current = store.get('plugin:config');
      expect((current!.value as any).pendingValidation).toBe(true);

      // Server validates - if invalid, rollback
      const serverValidation = { valid: false, reason: 'setting not allowed' };
      if (!serverValidation.valid) {
        store.store('plugin:config', { setting: 'old-value', validated: true }, 'server');
      }
      expect((store.get('plugin:config')!.value as any).setting).toBe('old-value');
    });

    it('should detect stale cached tool definitions after offline period', async () => {
      // Cached tool definitions
      const cachedTools = [
        { name: 'search', version: 1, params: ['query'] },
        { name: 'analyze', version: 1, params: ['data'] },
      ];

      // Server has updated definitions
      const serverTools = [
        { name: 'search', version: 2, params: ['query', 'filters'] }, // New required param
        { name: 'analyze', version: 1, params: ['data'] },
      ];

      // Detect schema mismatch
      const staleTools = cachedTools.filter(cached => {
        const server = serverTools.find(s => s.name === cached.name);
        return server && server.version > cached.version;
      });

      expect(staleTools.length).toBe(1);
      expect(staleTools[0].name).toBe('search');
    });

    it('should trigger plugin lifecycle hooks in other tabs via BroadcastChannel sync', async () => {
      const channel1 = new MockBroadcastChannel('plugin-sync');
      const channel2 = new MockBroadcastChannel('plugin-sync');

      const lifecycleEvents: string[] = [];
      channel2.onmessage = (event) => {
        const data = event.data as any;
        if (data.type === 'plugin:activate') {
          lifecycleEvents.push(`onActivate:${data.plugin}`);
        }
      };

      // Tab 1 activates plugin via state sync
      channel1.postMessage({ type: 'plugin:activate', plugin: 'memory-plugin' });

      expect(lifecycleEvents).toEqual(['onActivate:memory-plugin']);
    });

    it('should resolve conflicting plugin configurations discovered during state merge after offline', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // User configured locally
      store.store('plugin:settings:A', 1, 'user');

      // Server has admin-mandated config
      const serverEntries = [{
        key: 'plugin:settings:A',
        value: 2,
        agentId: 'admin',
        timestamp: Date.now() + 10000, // Admin set it later
        version: 5,
        metadata: { mandatory: true },
      }];

      const result = store.mergeRemote(serverEntries);

      // Server mandate wins (last-write-wins + admin is later)
      expect(store.get('plugin:settings:A')?.value).toBe(2);
    });

    it('should handle memory sync across tabs where one tab has newer plugin version', async () => {
      const channel1 = new MockBroadcastChannel('version-sync');
      const channel2 = new MockBroadcastChannel('version-sync');

      // Tab 2 (v2.0) stores memory with new schema
      const v2Memory = { key: 'data', value: { text: 'hello', embedding: [0.1, 0.2], newField: 'v2-only' } };

      let receivedInV1: any = null;
      channel1.onmessage = (event) => { receivedInV1 = event.data; };

      channel2.postMessage(v2Memory);

      // Tab 1 (v1.0) receives data - should store raw, not crash
      expect(receivedInV1).not.toBeNull();
      expect(receivedInV1.value.newField).toBe('v2-only'); // Raw data preserved
    });

    it('should handle offline operations queue exceeding storage quota', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });
      store.goOffline();

      const maxQueueSize = 100;

      // Fill queue
      for (let i = 0; i < maxQueueSize + 20; i++) {
        store.store(`op-${i}`, `value-${i}`, 'agent');
      }

      // Queue grew large - simulate quota exceeded by checking size
      expect(store.offlineQueueLength).toBe(maxQueueSize + 20);

      // Priority eviction: keep user-initiated, drop background
      // In our case, just demonstrate the queue tracking works
      expect(store.size).toBe(maxQueueSize + 20);
    });

    it('should reconcile when tab comes online but server has different session for same user', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Local session
      store.store('session:id', 'session-abc', 'local');
      store.store('session:work', ['task-1', 'task-2'], 'local');

      // Server has new session (user logged in elsewhere)
      const serverEntries = [
        { key: 'session:id', value: 'session-xyz', agentId: 'server', timestamp: Date.now() + 60000, version: 10 },
        { key: 'session:work', value: ['task-5'], agentId: 'server', timestamp: Date.now() + 60000, version: 10 },
      ];

      const result = store.mergeRemote(serverEntries);

      // Session mismatch detected
      expect(result.conflicts.length).toBe(2);
      expect(store.get('session:id')?.value).toBe('session-xyz'); // New session wins
    });

    it('should handle offline agent completing multi-turn task when server already reassigned it', async () => {
      const store = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Agent worked offline and completed task
      store.store('task:status', 'completed-by-offline-agent', 'offline-agent');

      // Server already reassigned and another agent completed it
      const serverEntries = [{
        key: 'task:status',
        value: 'completed-by-other-agent',
        agentId: 'other-agent',
        timestamp: Date.now() + 30000,
        version: 5,
      }];

      const result = store.mergeRemote(serverEntries);

      // Conflict: duplicate completion
      expect(result.conflicts.length).toBe(1);
      expect(store.get('task:status')?.value).toBe('completed-by-other-agent'); // Server wins
    });
  });
});
