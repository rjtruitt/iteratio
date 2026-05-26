import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockTransport } from '../../__test__/MockTransport';
import { MockRedis } from '../../__test__/MockRedis';
import { MockLLMProvider } from '../../__test__/MockLLMProvider';
import { MockStateManager } from '../../__test__/MockStateManager';
import { TestScheduler } from '../../__test__/TestScheduler';
import { MemoryStore } from '../../cross-cutting/MemoryStore';
import { SessionCheckpoint } from '../../cross-cutting/SessionCheckpoint';
import { DistributedLock } from '../../cross-cutting/DistributedLock';

/**
 * Cross-cutting: Multi-Agent + Shared Memory + Transport Failover
 */

describe('Cross-cutting: Multi-Agent + Memory + Transport', () => {
  let transport: MockTransport;
  let redis: MockRedis;
  let scheduler: TestScheduler;

  beforeEach(() => {
    transport = new MockTransport();
    redis = new MockRedis();
    scheduler = new TestScheduler();
  });

  describe('memory sharing between agents', () => {
    it('should propagate memory discovery from agent A to agent B', async () => {
      const sharedMemory = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });

      // Agent A learns a fact
      sharedMemory.store('champ-criteria', 'CHAMP uses 5 criteria', 'agent-a');

      // Agent B can find it
      const found = sharedMemory.get('champ-criteria', 'agent-b');
      expect(found).not.toBeUndefined();
      expect(found!.value).toBe('CHAMP uses 5 criteria');

      // Broadcast was emitted
      expect(sharedMemory.broadcasts.length).toBe(1);
    });

    it('should not inject duplicate memories (same fact from multiple sources)', async () => {
      const sharedMemory = new MemoryStore({ deduplicate: true, conflictResolution: 'last-write-wins' });

      // Agent A and Agent C both discover same fact
      sharedMemory.store('fact-1', 'Water boils at 100C', 'agent-a');
      sharedMemory.store('fact-1', 'Water boils at 100C', 'agent-c');

      // Only stored once
      expect(sharedMemory.size).toBe(1);
      const entry = sharedMemory.get('fact-1');
      expect(entry!.agentId).toBe('agent-a'); // First writer kept
    });

    it('should handle memory conflict (two agents store contradictory facts)', async () => {
      const sharedMemory = new MemoryStore({ conflictResolution: 'last-write-wins' });

      sharedMemory.store('budget', '$1M', 'agent-a');
      sharedMemory.store('budget', '$2M', 'agent-b');

      // Conflict resolved (last-write-wins)
      expect(sharedMemory.conflicts.length).toBe(1);
      expect(sharedMemory.get('budget')!.value).toBe('$2M');
    });

    it('should isolate memory when isolation mode is enabled', async () => {
      const isolatedMemory = new MemoryStore({ isolationMode: true, conflictResolution: 'last-write-wins' });

      isolatedMemory.store('secret', 'agent-a-data', 'agent-a');

      // Agent B cannot see Agent A's memory
      const fromB = isolatedMemory.get('secret', 'agent-b');
      expect(fromB).toBeUndefined();

      // Agent A can see its own
      const fromA = isolatedMemory.get('secret', 'agent-a');
      expect(fromA!.value).toBe('agent-a-data');
    });
  });

  describe('transport failure during multi-agent communication', () => {
    it('should buffer messages when transport disconnects', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });

      // Transport goes down
      memory.goOffline();

      // Operations are buffered
      memory.store('msg-1', 'hello', 'agent-a');
      memory.store('msg-2', 'world', 'agent-a');

      expect(memory.offlineQueueLength).toBe(2);
    });

    it('should deliver buffered messages after transport reconnects', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });

      memory.goOffline();
      memory.store('buffered-1', 'data-1', 'agent-a');
      memory.store('buffered-2', 'data-2', 'agent-a');

      // Reconnect
      const flushed = memory.goOnline();
      expect(flushed.length).toBe(2);
      expect(memory.broadcasts.length).toBe(2);
      expect(memory.offlineQueueLength).toBe(0);
    });

    it('should not lose memory broadcasts during transport failure', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });

      // Store while online
      memory.store('pre-fail', 'value-1', 'agent-a');
      expect(memory.broadcasts.length).toBe(1);

      // Transport fails
      memory.goOffline();
      memory.store('during-fail', 'value-2', 'agent-a');

      // Reconnect
      memory.goOnline();

      // Both memories exist
      expect(memory.get('pre-fail')!.value).toBe('value-1');
      expect(memory.get('during-fail')!.value).toBe('value-2');
      expect(memory.broadcasts.length).toBe(2); // pre-fail + during-fail (flushed)
    });

    it('should handle partial delivery (some agents got message, some didnt)', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });

      // Agent A broadcasts - partially delivered
      memory.store('partial', 'data', 'agent-a');

      // Agent B got it, Agent C did not (simulate with merge)
      const agentBMemory = new MemoryStore({ conflictResolution: 'last-write-wins' });
      agentBMemory.mergeRemote(memory.getAllEntries());
      expect(agentBMemory.get('partial')!.value).toBe('data');

      // Agent C needs retry
      const agentCMemory = new MemoryStore({ conflictResolution: 'last-write-wins' });
      expect(agentCMemory.get('partial')).toBeUndefined();

      // Retry delivery to C
      agentCMemory.mergeRemote(memory.getAllEntries());
      expect(agentCMemory.get('partial')!.value).toBe('data');
    });
  });

  describe('agent coordination with shared memory', () => {
    it('should coordinate work distribution using shared state', async () => {
      const lock = new DistributedLock(redis);
      const sharedMemory = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // 3 agents claim tasks
      const tasks = ['task-a', 'task-b', 'task-c'];
      const assignments: Record<string, string> = {};

      for (let i = 0; i < 3; i++) {
        const taskId = tasks[i];
        const agentId = `agent-${i + 1}`;
        const lockResult = await lock.acquire({ key: taskId, owner: agentId, ttlMs: 5000 });
        if (lockResult.acquired) {
          assignments[taskId] = agentId;
          sharedMemory.store(`assignment:${taskId}`, agentId, agentId);
        }
      }

      // No duplicates
      expect(Object.keys(assignments).length).toBe(3);
      expect(new Set(Object.values(assignments)).size).toBe(3);
    });

    it('should handle agent death during memory write', async () => {
      const sharedMemory = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Agent A starts writing
      sharedMemory.store('partial-write', { step1: 'done', step2: 'pending' }, 'agent-a');

      // Agent A "dies" - partial state exists
      const current = sharedMemory.get('partial-write');
      expect(current).not.toBeUndefined();
      expect((current!.value as any).step2).toBe('pending');

      // Recovery: another agent detects incomplete state
      const isComplete = (current!.value as any).step2 !== 'pending';
      expect(isComplete).toBe(false);

      // Complete or rollback
      sharedMemory.store('partial-write', { step1: 'done', step2: 'done' }, 'agent-recovery');
    });

    it('should support memory-based discovery (ask who knows about X)', async () => {
      const sharedMemory = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Agent A stores relevant facts
      sharedMemory.store('knowledge:champ:1', 'CHAMP = Challenges, Authority, Money, Prioritization, Timeline', 'agent-a');
      sharedMemory.store('knowledge:champ:2', 'CHAMP qualifies leads', 'agent-a');
      sharedMemory.store('knowledge:meddic:1', 'MEDDIC is another framework', 'agent-c');

      // Agent B searches for CHAMP knowledge
      const champKnowledge = sharedMemory.search(entry => entry.key.includes('champ'));
      expect(champKnowledge.length).toBe(2);
      expect(champKnowledge[0].agentId).toBe('agent-a');
    });
  });

  describe('transport switchover', () => {
    it('should failover from primary transport to backup without message loss', async () => {
      await transport.connect({ backend: 'memory' });

      // Publish on primary
      await transport.publish('topic-a', { msg: 'before-failover' });
      expect(transport.publishedMessages.length).toBe(1);

      // Primary fails
      await transport.disconnect();
      expect(transport.isConnected()).toBe(false);

      // Switch to backup
      const backupTransport = new MockTransport();
      await backupTransport.connect({ backend: 'memory' });

      // Continue on backup
      await backupTransport.publish('topic-a', { msg: 'after-failover' });
      expect(backupTransport.publishedMessages.length).toBe(1);

      // Total messages: no loss
      const totalMessages = transport.publishedMessages.length + backupTransport.publishedMessages.length;
      expect(totalMessages).toBe(2);
    });

    it('should maintain memory consistency across transport change', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });

      // Store via first transport
      memory.store('key-1', 'value-1', 'agent-a');
      memory.store('key-2', 'value-2', 'agent-a');

      // Switch transport (memory is independent of transport)
      memory.goOffline();
      memory.goOnline();

      // Existing memories still accessible
      expect(memory.get('key-1')!.value).toBe('value-1');
      expect(memory.get('key-2')!.value).toBe('value-2');
    });
  });

  describe('Deep Interactions: Memory + Transport + Sessions', () => {
    it('should handle agent storing memory then transport dropping so other agent reads stale memory', async () => {
      const agentAMemory = new MemoryStore({ conflictResolution: 'last-write-wins', transport: true });
      const agentBMemory = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Agent A writes v2
      agentAMemory.store('data', 'v2', 'agent-a');

      // Transport drops - Agent B only has v1
      agentBMemory.store('data', 'v1', 'agent-b');

      // Agent B reads stale data
      expect(agentBMemory.get('data')!.value).toBe('v1'); // Stale!

      // Transport recovers - Agent B reconciles
      const reconcile = agentBMemory.mergeRemote(agentAMemory.getAllEntries());
      expect(reconcile.conflicts.length).toBe(1);
      // After merge, should have most recent value
      expect(agentBMemory.get('data')!.value).toBe('v2');
    });

    it('should handle session checkpoint including memory state but memory updated after checkpoint', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins' });
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis });

      // Checkpoint at T=10 with memory M1
      memory.store('counter', 1, 'agent-1');
      await checkpoint.save({ turn: 10, memorySnapshot: memory.getAllEntries() }, {});

      // Memory updated to M2 at T=11
      memory.store('counter', 2, 'agent-1');

      // Crash at T=12, restore from checkpoint
      const restored = await checkpoint.restore();
      const checkpointMemory = (restored!.state.memorySnapshot as any[])[0];
      expect(checkpointMemory.value).toBe(1); // Stale from checkpoint

      // Current live memory has v2
      expect(memory.get('counter')!.value).toBe(2);

      // Detect divergence and resolve
      const diverged = checkpointMemory.value !== memory.get('counter')!.value;
      expect(diverged).toBe(true);
    });

    it('should handle transport failover causing duplicate memory writes (idempotency needed)', async () => {
      const memory = new MemoryStore({ deduplicate: true, conflictResolution: 'last-write-wins' });

      // Agent writes via primary transport
      memory.store('unique-fact', 'earth is round', 'agent-a');

      // Failover - agent doesn't know if first write landed, retries
      memory.store('unique-fact', 'earth is round', 'agent-a');

      // Deduplication: stored only once
      expect(memory.size).toBe(1);
    });

    it('should handle memory eviction on one node while another node references that memory', async () => {
      const nodeA = new MemoryStore({ conflictResolution: 'last-write-wins' });
      const nodeB = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Both have memory X
      nodeA.store('memory-x', 'important data', 'system');
      nodeB.mergeRemote(nodeA.getAllEntries());

      expect(nodeB.get('memory-x')!.value).toBe('important data');

      // Node A evicts memory X (capacity limit)
      nodeA.delete('memory-x');
      expect(nodeA.get('memory-x')).toBeUndefined();

      // Node B still has reference - can still read
      expect(nodeB.get('memory-x')!.value).toBe('important data');
    });

    it('should handle session restore reconnecting to different transport than original', async () => {
      const checkpoint = new SessionCheckpoint({ agentId: 'agent-1', redis });

      // Original session on transport A
      await checkpoint.save({
        turn: 5,
        transportInfo: { backend: 'redis', subscriptions: ['topic-a', 'topic-b'] },
      }, {});

      // Restore on different transport
      const restored = await checkpoint.restore();
      const originalTransport = (restored!.state.transportInfo as any).backend;
      const newTransport = 'nats';

      expect(originalTransport).not.toBe(newTransport);

      // Must re-establish subscriptions on new transport
      const subscriptions = (restored!.state.transportInfo as any).subscriptions;
      expect(subscriptions).toEqual(['topic-a', 'topic-b']);
    });

    it('should handle memory search across agents during transport reconnection', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Some agents reachable, some not
      memory.store('from-agent-1', 'reachable', 'agent-1');
      memory.store('from-agent-2', 'reachable', 'agent-2');
      // Agent 3 is unreachable (transport reconnecting)

      // Search results are partial
      const results = memory.search(() => true);
      expect(results.length).toBe(2); // Only 2 of 3 agents' data available

      // Indicate incompleteness
      const totalExpectedAgents = 3;
      const isComplete = results.length >= totalExpectedAgents;
      expect(isComplete).toBe(false);
    });

    it('should handle agent dying mid-memory-write with session restore replaying partial write', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Agent writes embedding (step 1 of 2)
      memory.store('doc:embedding', [0.1, 0.2, 0.3], 'agent-a');
      // Agent dies before writing metadata (step 2)

      // Detect partial state
      const hasEmbedding = memory.get('doc:embedding') !== undefined;
      const hasMetadata = memory.get('doc:metadata') !== undefined;
      expect(hasEmbedding).toBe(true);
      expect(hasMetadata).toBe(false);

      // Session restore replays - must detect partial and complete
      const isPartial = hasEmbedding && !hasMetadata;
      expect(isPartial).toBe(true);

      // Complete the write
      memory.store('doc:metadata', { source: 'restored', timestamp: Date.now() }, 'recovery');
      expect(memory.get('doc:metadata')).not.toBeUndefined();
    });

    it('should handle shared memory conflict resolution during simultaneous multi-agent writes', async () => {
      const memory = new MemoryStore({ conflictResolution: 'last-write-wins' });

      // Three agents write to same key simultaneously
      memory.store('shared-key', 'from-a', 'agent-a');
      memory.store('shared-key', 'from-b', 'agent-b');
      memory.store('shared-key', 'from-c', 'agent-c');

      // Consistent final state (last-write-wins)
      const final = memory.get('shared-key');
      expect(final!.value).toBe('from-c');

      // Conflicts recorded
      expect(memory.conflicts.length).toBe(2); // B overwrites A, C overwrites B
    });
  });
});
