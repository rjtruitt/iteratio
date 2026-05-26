/**
 * Scenario Family 8: Session/Checkpoint Management
 * Tests checkpoint saving, restoration, crash recovery, cross-machine restore,
 * multiple backends, time-travel debugging, TTL, and thread isolation.
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
import { CheckpointManager } from '../../session/CheckpointManager';
import { MemoryCheckpointBackend } from '../../session/MemoryCheckpointBackend';
import { RedisCheckpointBackend } from '../../session/RedisCheckpointBackend';
import { SessionManager } from '../../session/SessionManager';

describe('Session Checkpoint - E2E', () => {
  let clock: TestClock;
  let eventBus: MockEventBus;

  beforeEach(() => {
    clock = new TestClock(1000000);
    clock.install();
    eventBus = new MockEventBus();
  });

  afterEach(() => {
    clock.uninstall();
  });

  describe('checkpoint save after successful turn', () => {
    it('should save a checkpoint after each successful agent turn', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });
      const stateManager = new MockStateManager();
      const messageManager = new MockMessageManager();

      const agent = new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager,
        messageManager,
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      await agent.runTurn('First message');

      const saved = await checkpoints.list('default');
      expect(saved).toHaveLength(1);
      expect(saved[0].turnIndex).toBe(0);
    });

    it('should include state and messages in checkpoint', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });
      const stateManager = new MockStateManager();
      stateManager.set('counter', 5);

      const messageManager = new MockMessageManager();
      messageManager.addMessage({ role: 'user', content: 'Hello' });

      const agent = new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager,
        messageManager,
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      await agent.runTurn('Another message');

      const checkpoint = await checkpoints.getLatest('default');
      expect(checkpoint.state.counter).toBe(5);
      expect(checkpoint.messages.length).toBeGreaterThanOrEqual(1);
    });

    it('should generate sequential checkpoint IDs', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      const agent = new AgentLoop({
        llm: MockLLMProvider.sequencedResponses(
          MockLLMProvider.simpleResponse('Response 1'),
          MockLLMProvider.simpleResponse('Response 2'),
          MockLLMProvider.simpleResponse('Response 3'),
        ),
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      await agent.runTurn('Turn 1');
      await agent.runTurn('Turn 2');
      await agent.runTurn('Turn 3');

      const all = await checkpoints.list('default');
      expect(all).toHaveLength(3);
      expect(all[0].turnIndex).toBe(0);
      expect(all[1].turnIndex).toBe(1);
      expect(all[2].turnIndex).toBe(2);
    });
  });

  describe('restore from checkpoint', () => {
    it('should restore agent state from a checkpoint', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });
      const stateManager = new MockStateManager();
      const messageManager = new MockMessageManager();

      // Save a checkpoint with known state
      await checkpoints.save('default', {
        turnIndex: 5,
        state: { progress: 0.8, results: ['a', 'b', 'c'] },
        messages: [
          { role: 'user', content: 'Previous conversation' },
          { role: 'assistant', content: 'Previous response' },
        ],
        timestamp: Date.now(),
      });

      // Restore from checkpoint
      const agent = new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager,
        messageManager,
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      await agent.restoreFromCheckpoint('default');

      expect(stateManager.get('progress')).toBe(0.8);
      expect(stateManager.get('results')).toEqual(['a', 'b', 'c']);
      expect(messageManager.count()).toBe(2);
    });

    it('should continue from restored state on next turn', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });
      const stateManager = new MockStateManager();
      const messageManager = new MockMessageManager();

      await checkpoints.save('default', {
        turnIndex: 2,
        state: { counter: 10 },
        messages: [{ role: 'user', content: 'Earlier' }],
        timestamp: Date.now(),
      });

      const llm = new MockLLMProvider({
        defaultResponse: MockLLMProvider.simpleResponse('Continuing from checkpoint'),
      });

      const agent = new AgentLoop({
        llm,
        stateManager,
        messageManager,
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      await agent.restoreFromCheckpoint('default');
      const result = await agent.runTurn('Continue');

      expect(result.content).toContain('Continuing');
      // Should have context from restored messages
      expect(llm.calls[0].messages.some(m => m.content?.includes('Earlier'))).toBe(true);
    });
  });

  describe('crash recovery', () => {
    it('should recover from crash mid-turn using last checkpoint', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });
      const stateManager = new MockStateManager();

      // Simulate: agent completed 3 turns, then crashes mid-turn-4
      await checkpoints.save('session-1', {
        turnIndex: 2,
        state: { progress: 0.6 },
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Turn 2' },
          { role: 'assistant', content: 'Response 2' },
          { role: 'user', content: 'Turn 3' },
          { role: 'assistant', content: 'Response 3' },
        ],
        timestamp: Date.now(),
      });

      // "Restart" the agent from checkpoint
      const agent = new AgentLoop({
        llm: new MockLLMProvider({
          defaultResponse: MockLLMProvider.simpleResponse('Recovered and continuing'),
        }),
        stateManager,
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      await agent.restoreFromCheckpoint('session-1');
      expect(stateManager.get('progress')).toBe(0.6);

      const result = await agent.runTurn('Continue after crash');
      expect(result.content).toContain('Recovered');
    });

    it('should include partial tool results in mid-turn checkpoint', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      // Checkpoint includes a partial tool result (tool ran but agent crashed before LLM response)
      await checkpoints.save('session-1', {
        turnIndex: 3,
        state: { progress: 0.7 },
        messages: [
          { role: 'user', content: 'Run analysis' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'analyze', arguments: '{}' }] },
          { role: 'tool', content: JSON.stringify({ result: 'analysis complete' }), tool_call_id: 'tc1' },
        ],
        partialToolResults: [{ toolCallId: 'tc1', result: { success: true, data: { score: 0.95 } } }],
        timestamp: Date.now(),
      });

      const checkpoint = await checkpoints.getLatest('session-1');
      expect(checkpoint.partialToolResults).toHaveLength(1);
      expect(checkpoint.partialToolResults[0].result.data.score).toBe(0.95);
    });

    it('should detect incomplete turn and offer recovery options', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      await checkpoints.save('session-1', {
        turnIndex: 5,
        state: {},
        messages: [],
        timestamp: Date.now(),
        status: 'in-progress', // Turn wasn't completed
      });

      const checkpoint = await checkpoints.getLatest('session-1');
      expect(checkpoint.status).toBe('in-progress');

      const recoveryOptions = await checkpoints.getRecoveryOptions('session-1');
      expect(recoveryOptions).toContain('retry-turn');
      expect(recoveryOptions).toContain('rollback-to-previous');
    });
  });

  describe('cross-machine restore', () => {
    it('should save checkpoint on machine A and restore on machine B via Redis', async () => {
      const redis = new MockRedis();
      const backendA = new RedisCheckpointBackend({ redis, machineId: 'machine-a' });
      const backendB = new RedisCheckpointBackend({ redis, machineId: 'machine-b' });

      const checkpointsA = new CheckpointManager({ backend: backendA });
      const checkpointsB = new CheckpointManager({ backend: backendB });

      // Save on machine A
      await checkpointsA.save('shared-session', {
        turnIndex: 10,
        state: { analysis: 'complete', score: 0.99 },
        messages: [{ role: 'user', content: 'Final review' }],
        timestamp: Date.now(),
      });

      // Restore on machine B
      const checkpoint = await checkpointsB.getLatest('shared-session');
      expect(checkpoint).toBeDefined();
      expect(checkpoint.state.score).toBe(0.99);
      expect(checkpoint.turnIndex).toBe(10);
    });

    it('should handle network latency during cross-machine restore', async () => {
      const redis = new MockRedis();
      const backend = new RedisCheckpointBackend({ redis, machineId: 'machine-b' });
      const checkpoints = new CheckpointManager({ backend });

      // Checkpoint exists
      await redis.set('checkpoint:session-x:latest', JSON.stringify({
        turnIndex: 3,
        state: { data: 'test' },
        messages: [],
        timestamp: Date.now(),
      }));

      const restored = await checkpoints.getLatest('session-x');
      expect(restored.state.data).toBe('test');
    });
  });

  describe('checkpoint backends', () => {
    it('should work with Memory backend for testing', async () => {
      const backend = new MemoryCheckpointBackend();
      const checkpoints = new CheckpointManager({ backend });

      await checkpoints.save('test', { turnIndex: 0, state: {}, messages: [], timestamp: Date.now() });
      const result = await checkpoints.getLatest('test');
      expect(result).toBeDefined();
      expect(result.turnIndex).toBe(0);
    });

    it('should work with Redis backend for production-like tests', async () => {
      const redis = new MockRedis();
      const backend = new RedisCheckpointBackend({ redis });
      const checkpoints = new CheckpointManager({ backend });

      await checkpoints.save('prod-test', { turnIndex: 7, state: { key: 'value' }, messages: [], timestamp: Date.now() });
      const result = await checkpoints.getLatest('prod-test');
      expect(result.state.key).toBe('value');
    });

    it('should list all checkpoints for a session in order', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      for (let i = 0; i < 5; i++) {
        await checkpoints.save('session-1', { turnIndex: i, state: { i }, messages: [], timestamp: Date.now() + i * 1000 });
        clock.advance(1000);
      }

      const all = await checkpoints.list('session-1');
      expect(all).toHaveLength(5);
      expect(all.map(c => c.turnIndex)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe('time-travel debugging', () => {
    it('should restore an old checkpoint and replay from that point', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      // Create 5 checkpoints
      for (let i = 0; i < 5; i++) {
        await checkpoints.save('debug-session', {
          turnIndex: i,
          state: { counter: i * 10 },
          messages: [{ role: 'user', content: `Turn ${i}` }],
          timestamp: Date.now() + i * 1000,
        });
        clock.advance(1000);
      }

      // Time-travel to turn 2
      const checkpoint = await checkpoints.getByIndex('debug-session', 2);
      expect(checkpoint.state.counter).toBe(20);
      expect(checkpoint.turnIndex).toBe(2);
    });

    it('should allow branching from an old checkpoint', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      await checkpoints.save('original', { turnIndex: 0, state: { path: 'A' }, messages: [], timestamp: Date.now() });
      clock.advance(1000);
      await checkpoints.save('original', { turnIndex: 1, state: { path: 'B' }, messages: [], timestamp: Date.now() });

      // Branch from turn 0
      const branchPoint = await checkpoints.getByIndex('original', 0);
      await checkpoints.save('branch-1', {
        ...branchPoint,
        state: { path: 'C' }, // Different path than original
      });

      const branch = await checkpoints.getLatest('branch-1');
      expect(branch.state.path).toBe('C');

      // Original unchanged
      const original = await checkpoints.getLatest('original');
      expect(original.state.path).toBe('B');
    });
  });

  describe('checkpoint TTL', () => {
    it('should auto-delete old checkpoints after TTL', async () => {
      const checkpoints = new CheckpointManager({
        backend: new MemoryCheckpointBackend(),
        checkpointTTL: 60000, // 1 minute TTL
      });

      await checkpoints.save('session-1', { turnIndex: 0, state: {}, messages: [], timestamp: Date.now() });
      clock.advance(30000);
      await checkpoints.save('session-1', { turnIndex: 1, state: {}, messages: [], timestamp: Date.now() });
      clock.advance(35000); // First checkpoint is now 65s old

      await checkpoints.cleanup('session-1');
      const remaining = await checkpoints.list('session-1');

      // Only the second checkpoint should remain
      expect(remaining).toHaveLength(1);
      expect(remaining[0].turnIndex).toBe(1);
    });

    it('should keep minimum number of checkpoints regardless of TTL', async () => {
      const checkpoints = new CheckpointManager({
        backend: new MemoryCheckpointBackend(),
        checkpointTTL: 1000, // Very short TTL
        minCheckpoints: 2,
      });

      await checkpoints.save('session', { turnIndex: 0, state: {}, messages: [], timestamp: Date.now() });
      clock.advance(500);
      await checkpoints.save('session', { turnIndex: 1, state: {}, messages: [], timestamp: Date.now() });
      clock.advance(500);
      await checkpoints.save('session', { turnIndex: 2, state: {}, messages: [], timestamp: Date.now() });
      clock.advance(2000); // All would be expired by TTL

      await checkpoints.cleanup('session');
      const remaining = await checkpoints.list('session');

      // Should keep at least 2 despite TTL
      expect(remaining.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('thread isolation', () => {
    it('should not mix checkpoints from different sessions', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      await checkpoints.save('session-A', { turnIndex: 0, state: { owner: 'A' }, messages: [], timestamp: Date.now() });
      await checkpoints.save('session-B', { turnIndex: 0, state: { owner: 'B' }, messages: [], timestamp: Date.now() });

      const a = await checkpoints.getLatest('session-A');
      const b = await checkpoints.getLatest('session-B');

      expect(a.state.owner).toBe('A');
      expect(b.state.owner).toBe('B');
    });

    it('should support concurrent sessions without interference', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      // Interleaved saves
      await checkpoints.save('s1', { turnIndex: 0, state: { s: 1 }, messages: [], timestamp: Date.now() });
      await checkpoints.save('s2', { turnIndex: 0, state: { s: 2 }, messages: [], timestamp: Date.now() });
      await checkpoints.save('s1', { turnIndex: 1, state: { s: 1, turn: 1 }, messages: [], timestamp: Date.now() });
      await checkpoints.save('s2', { turnIndex: 1, state: { s: 2, turn: 1 }, messages: [], timestamp: Date.now() });

      const s1 = await checkpoints.list('s1');
      const s2 = await checkpoints.list('s2');

      expect(s1).toHaveLength(2);
      expect(s2).toHaveLength(2);
      expect(s1[0].state.s).toBe(1);
      expect(s2[0].state.s).toBe(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle checkpoint saved but disk/storage full on restore', async () => {
      const backend = new MemoryCheckpointBackend();
      const checkpoints = new CheckpointManager({ backend });

      // Save checkpoint successfully
      await checkpoints.save('session-x', {
        turnIndex: 3,
        state: { data: 'important' },
        messages: [{ role: 'user', content: 'Hello' }],
        timestamp: Date.now(),
      });

      // Simulate storage full on read (corruption/unavailable)
      backend.simulateReadError(new Error('ENOSPC: no space left on device'));

      await expect(checkpoints.getLatest('session-x'))
        .rejects.toThrow(/ENOSPC|storage|space/i);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle checkpoint from different framework version (schema mismatch)', async () => {
      const checkpoints = new CheckpointManager({
        backend: new MemoryCheckpointBackend(),
        schemaVersion: '2.0',
      });

      // Inject a checkpoint with old schema version directly
      const oldCheckpoint = {
        turnIndex: 5,
        state: { oldFormat: true },
        messages: [],
        timestamp: Date.now(),
        _schemaVersion: '1.0', // Old version
      };

      const backend = new MemoryCheckpointBackend();
      await backend.write('legacy-session', oldCheckpoint);
      const legacyCheckpoints = new CheckpointManager({ backend, schemaVersion: '2.0' });

      await expect(legacyCheckpoints.getLatest('legacy-session'))
        .rejects.toThrow(/schema|version|incompatible/i);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle restore checkpoint while agent is mid-turn', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      await checkpoints.save('session-1', {
        turnIndex: 2,
        state: { counter: 10 },
        messages: [{ role: 'user', content: 'Hello' }],
        timestamp: Date.now(),
      });

      const agent = new AgentLoop({
        llm: new MockLLMProvider({ delayMs: 5000 }), // Slow LLM
        stateManager: new MockStateManager(),
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      // Start a turn (will be in-progress)
      const turnPromise = agent.runTurn('Processing...');

      // Attempt restore while turn is active
      await expect(agent.restoreFromCheckpoint('session-1'))
        .rejects.toThrow(/in-progress|busy|active/i);

      clock.advance(6000);
      await turnPromise;
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle checkpoint with 0 turns completed', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      // Checkpoint at turn 0 (no turns have completed yet)
      await checkpoints.save('fresh-session', {
        turnIndex: 0,
        state: {},
        messages: [],
        timestamp: Date.now(),
      });

      const stateManager = new MockStateManager();
      const agent = new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager,
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      await agent.restoreFromCheckpoint('fresh-session');

      // Should restore to empty state without error
      expect(stateManager.size()).toBe(0);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle checkpoint created during tool execution (partial state)', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      // Simulate mid-tool-execution checkpoint
      await checkpoints.save('mid-tool', {
        turnIndex: 3,
        state: { toolInProgress: 'file_write', toolStartedAt: Date.now() },
        messages: [
          { role: 'user', content: 'Write file' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', name: 'file_write', arguments: '{"path": "/tmp/x"}' }] },
          // No tool result yet - tool was still executing
        ],
        timestamp: Date.now(),
        status: 'tool-executing',
      });

      const checkpoint = await checkpoints.getLatest('mid-tool');
      expect(checkpoint.status).toBe('tool-executing');

      // Restoring should handle the incomplete tool execution
      const recoveryOptions = await checkpoints.getRecoveryOptions('mid-tool');
      expect(recoveryOptions).toContain('retry-tool');
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle concurrent checkpoint saves (last-write-wins vs error)', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      // Two concurrent saves to the same session
      const save1 = checkpoints.save('concurrent', {
        turnIndex: 5,
        state: { writer: 'A' },
        messages: [],
        timestamp: Date.now(),
      });
      const save2 = checkpoints.save('concurrent', {
        turnIndex: 5,
        state: { writer: 'B' },
        messages: [],
        timestamp: Date.now() + 1,
      });

      await Promise.all([save1, save2]);

      // Should have deterministic behavior (last-write-wins or conflict error)
      const latest = await checkpoints.getLatest('concurrent');
      expect(latest.state.writer).toBeDefined();
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle checkpoint file corruption (bit flip in middle)', async () => {
      const backend = new MemoryCheckpointBackend();
      const checkpoints = new CheckpointManager({ backend });

      await checkpoints.save('corrupted', {
        turnIndex: 7,
        state: { important: 'data' },
        messages: [{ role: 'user', content: 'Hello' }],
        timestamp: Date.now(),
      });

      // Simulate corruption (invalid JSON in stored data)
      backend.corruptEntry('corrupted');

      await expect(checkpoints.getLatest('corrupted'))
        .rejects.toThrow(/corrupt|parse|invalid/i);
      expect(true).toBe(false); // RED: not implemented
    });

    it('should handle restore from checkpoint then immediately save new one', async () => {
      const checkpoints = new CheckpointManager({ backend: new MemoryCheckpointBackend() });

      await checkpoints.save('session', {
        turnIndex: 3,
        state: { counter: 30 },
        messages: [{ role: 'user', content: 'Turn 3' }],
        timestamp: Date.now(),
      });

      const stateManager = new MockStateManager();
      const agent = new AgentLoop({
        llm: new MockLLMProvider(),
        stateManager,
        messageManager: new MockMessageManager(),
        toolExecutor: new MockToolExecutor(),
        eventBus,
        checkpointManager: checkpoints,
      });

      // Restore then immediately save (no turn executed in between)
      await agent.restoreFromCheckpoint('session');
      await checkpoints.save('session', {
        turnIndex: 3,
        state: stateManager.getAll(),
        messages: [],
        timestamp: Date.now(),
      });

      const all = await checkpoints.list('session');
      // Should not create duplicate or corrupt state
      expect(all.length).toBeGreaterThanOrEqual(1);
      expect(true).toBe(false); // RED: not implemented
    });
  });
});
