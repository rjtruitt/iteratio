/**
 * Scenario Family 10: Shadow Git for File Coordination
 * Tests conflict detection, merge resolution, multi-machine editing,
 * change tracking, rollback, concurrent edits, three-way merge, and persistence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MockRedis,
  MockEventBus,
  MockStateManager,
  MockTransport,
  TestClock,
} from '../../__test__';

// These imports will fail until the actual modules are implemented
import { ShadowGit } from '../../coordination/ShadowGit';
import { FileCoordinator } from '../../coordination/FileCoordinator';
import { MergeEngine } from '../../coordination/MergeEngine';
import { VersionStore } from '../../coordination/VersionStore';

describe('Shadow Git - E2E', () => {
  let redis: MockRedis;
  let eventBus: MockEventBus;
  let clock: TestClock;

  beforeEach(() => {
    redis = new MockRedis();
    eventBus = new MockEventBus();
    clock = new TestClock(1000000);
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
    redis.reset();
  });

  describe('conflict detection', () => {
    it('should detect when two agents edit the same file', async () => {
      const coordinator = new FileCoordinator({ redis, eventBus });

      // Agent A checks out and edits
      await coordinator.checkout('agent-a', 'src/index.ts');
      await coordinator.write('agent-a', 'src/index.ts', 'console.log("hello from A");');

      // Agent B also checks out and edits the same file
      await coordinator.checkout('agent-b', 'src/index.ts');
      await coordinator.write('agent-b', 'src/index.ts', 'console.log("hello from B");');

      // Conflict should be detected when B tries to commit
      const result = await coordinator.commit('agent-b', 'src/index.ts');
      expect(result.conflict).toBe(true);
      expect(result.conflictWith).toBe('agent-a');
    });

    it('should not flag conflict for non-overlapping edits', async () => {
      const coordinator = new FileCoordinator({ redis, eventBus });

      await coordinator.checkout('agent-a', 'src/index.ts');
      await coordinator.checkout('agent-b', 'src/utils.ts'); // Different file

      await coordinator.write('agent-a', 'src/index.ts', 'export const main = () => {}');
      await coordinator.write('agent-b', 'src/utils.ts', 'export const helper = () => {}');

      const resultA = await coordinator.commit('agent-a', 'src/index.ts');
      const resultB = await coordinator.commit('agent-b', 'src/utils.ts');

      expect(resultA.conflict).toBe(false);
      expect(resultB.conflict).toBe(false);
    });

    it('should detect line-level conflicts in same file', async () => {
      const coordinator = new FileCoordinator({ redis, eventBus });
      const originalContent = 'line1\nline2\nline3\nline4\nline5';

      await coordinator.init('src/app.ts', originalContent);
      await coordinator.checkout('agent-a', 'src/app.ts');
      await coordinator.checkout('agent-b', 'src/app.ts');

      // Agent A edits line 3
      await coordinator.write('agent-a', 'src/app.ts', 'line1\nline2\nmodified-by-A\nline4\nline5');
      await coordinator.commit('agent-a', 'src/app.ts');

      // Agent B also edits line 3 (conflict!)
      await coordinator.write('agent-b', 'src/app.ts', 'line1\nline2\nmodified-by-B\nline4\nline5');
      const result = await coordinator.commit('agent-b', 'src/app.ts');

      expect(result.conflict).toBe(true);
      expect(result.conflictLines).toContain(3);
    });
  });

  describe('conflict resolution via merge', () => {
    it('should auto-merge non-overlapping changes', async () => {
      const merge = new MergeEngine();

      const base = 'line1\nline2\nline3\nline4\nline5';
      const ours = 'line1\nMODIFIED-A\nline3\nline4\nline5'; // Changed line 2
      const theirs = 'line1\nline2\nline3\nMODIFIED-B\nline5'; // Changed line 4

      const result = await merge.threeWay(base, ours, theirs);
      expect(result.success).toBe(true);
      expect(result.merged).toBe('line1\nMODIFIED-A\nline3\nMODIFIED-B\nline5');
      expect(result.conflicts).toHaveLength(0);
    });

    it('should report conflicts for overlapping changes', async () => {
      const merge = new MergeEngine();

      const base = 'line1\nline2\nline3';
      const ours = 'line1\nOURS\nline3'; // Changed line 2
      const theirs = 'line1\nTHEIRS\nline3'; // Also changed line 2

      const result = await merge.threeWay(base, ours, theirs);
      expect(result.success).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].ours).toBe('OURS');
      expect(result.conflicts[0].theirs).toBe('THEIRS');
    });

    it('should support manual conflict resolution', async () => {
      const coordinator = new FileCoordinator({ redis, eventBus });
      const merge = new MergeEngine();

      const base = 'function main() {\n  return 1;\n}';
      const agentAVersion = 'function main() {\n  return 2;\n}';
      const agentBVersion = 'function main() {\n  return 3;\n}';

      const mergeResult = await merge.threeWay(base, agentAVersion, agentBVersion);
      expect(mergeResult.success).toBe(false);

      // Manual resolution: pick agent A's version
      const resolved = await coordinator.resolveConflict('src/main.ts', {
        resolution: 'pick-ours',
        content: agentAVersion,
      });

      expect(resolved.content).toContain('return 2');
    });
  });

  describe('multi-machine file coordination', () => {
    it('should coordinate edits across machines via Redis', async () => {
      const coordMachine1 = new FileCoordinator({ redis, eventBus, machineId: 'machine-1' });
      const coordMachine2 = new FileCoordinator({ redis, eventBus, machineId: 'machine-2' });

      // Machine 1 edits
      await coordMachine1.checkout('agent-a', 'shared/config.json');
      await coordMachine1.write('agent-a', 'shared/config.json', '{"port": 3000}');
      await coordMachine1.commit('agent-a', 'shared/config.json');

      // Machine 2 should see the update
      const content = await coordMachine2.getLatest('shared/config.json');
      expect(content).toBe('{"port": 3000}');
    });

    it('should detect cross-machine conflicts', async () => {
      const coordMachine1 = new FileCoordinator({ redis, eventBus, machineId: 'machine-1' });
      const coordMachine2 = new FileCoordinator({ redis, eventBus, machineId: 'machine-2' });

      await coordMachine1.init('shared/app.ts', 'original');

      // Both machines edit same file
      await coordMachine1.checkout('agent-a', 'shared/app.ts');
      await coordMachine2.checkout('agent-b', 'shared/app.ts');

      await coordMachine1.write('agent-a', 'shared/app.ts', 'machine-1-edit');
      await coordMachine1.commit('agent-a', 'shared/app.ts');

      await coordMachine2.write('agent-b', 'shared/app.ts', 'machine-2-edit');
      const result = await coordMachine2.commit('agent-b', 'shared/app.ts');

      expect(result.conflict).toBe(true);
    });
  });

  describe('change tracking', () => {
    it('should track diffs between versions', async () => {
      const versionStore = new VersionStore({ redis });

      await versionStore.commit('file.ts', 'version 1 content', 'agent-a');
      await versionStore.commit('file.ts', 'version 2 content', 'agent-b');

      const diff = await versionStore.diff('file.ts', 0, 1);
      expect(diff.additions).toContain('version 2');
      expect(diff.deletions).toContain('version 1');
    });

    it('should list file history with metadata', async () => {
      const versionStore = new VersionStore({ redis });

      await versionStore.commit('file.ts', 'v1', 'agent-a');
      clock.advance(1000);
      await versionStore.commit('file.ts', 'v2', 'agent-b');
      clock.advance(1000);
      await versionStore.commit('file.ts', 'v3', 'agent-a');

      const history = await versionStore.getHistory('file.ts');
      expect(history).toHaveLength(3);
      expect(history[0].author).toBe('agent-a');
      expect(history[1].author).toBe('agent-b');
      expect(history[2].author).toBe('agent-a');
      expect(history[1].timestamp).toBeGreaterThan(history[0].timestamp);
    });

    it('should support getting content at specific version', async () => {
      const versionStore = new VersionStore({ redis });

      await versionStore.commit('file.ts', 'first', 'agent-a');
      await versionStore.commit('file.ts', 'second', 'agent-b');
      await versionStore.commit('file.ts', 'third', 'agent-a');

      const v1 = await versionStore.getAtVersion('file.ts', 0);
      const v2 = await versionStore.getAtVersion('file.ts', 1);

      expect(v1).toBe('first');
      expect(v2).toBe('second');
    });
  });

  describe('rollback', () => {
    it('should rollback to a previous version', async () => {
      const versionStore = new VersionStore({ redis });

      await versionStore.commit('file.ts', 'good version', 'agent-a');
      await versionStore.commit('file.ts', 'broken version', 'agent-b');

      await versionStore.rollback('file.ts', 0); // Back to "good version"

      const current = await versionStore.getLatest('file.ts');
      expect(current).toBe('good version');
    });

    it('should create a new version entry for rollback (not destructive)', async () => {
      const versionStore = new VersionStore({ redis });

      await versionStore.commit('file.ts', 'v1', 'agent-a');
      await versionStore.commit('file.ts', 'v2', 'agent-b');
      await versionStore.rollback('file.ts', 0);

      const history = await versionStore.getHistory('file.ts');
      // Rollback should be a new commit, not deletion of v2
      expect(history.length).toBe(3);
      expect(history[2].content).toBe('v1');
      expect(history[2].isRollback).toBe(true);
    });
  });

  describe('concurrent edits to different files', () => {
    it('should allow concurrent edits to different files without conflict', async () => {
      const coordinator = new FileCoordinator({ redis, eventBus });

      // Multiple agents editing different files simultaneously
      const results = await Promise.all([
        (async () => {
          await coordinator.checkout('agent-a', 'file-a.ts');
          await coordinator.write('agent-a', 'file-a.ts', 'content-a');
          return coordinator.commit('agent-a', 'file-a.ts');
        })(),
        (async () => {
          await coordinator.checkout('agent-b', 'file-b.ts');
          await coordinator.write('agent-b', 'file-b.ts', 'content-b');
          return coordinator.commit('agent-b', 'file-b.ts');
        })(),
        (async () => {
          await coordinator.checkout('agent-c', 'file-c.ts');
          await coordinator.write('agent-c', 'file-c.ts', 'content-c');
          return coordinator.commit('agent-c', 'file-c.ts');
        })(),
      ]);

      expect(results.every(r => r.conflict === false)).toBe(true);
    });
  });

  describe('three-way merge', () => {
    it('should perform three-way merge for complex conflicts', async () => {
      const merge = new MergeEngine();

      const base = [
        'import { foo } from "./foo";',
        '',
        'function main() {',
        '  const x = foo();',
        '  return x;',
        '}',
      ].join('\n');

      const ours = [
        'import { foo } from "./foo";',
        'import { bar } from "./bar";', // Added import
        '',
        'function main() {',
        '  const x = foo();',
        '  return x;',
        '}',
      ].join('\n');

      const theirs = [
        'import { foo } from "./foo";',
        '',
        'function main() {',
        '  const x = foo();',
        '  console.log(x);', // Added log
        '  return x;',
        '}',
      ].join('\n');

      const result = await merge.threeWay(base, ours, theirs);
      expect(result.success).toBe(true);
      // Should have both the new import AND the console.log
      expect(result.merged).toContain('import { bar }');
      expect(result.merged).toContain('console.log(x)');
    });

    it('should handle insertion at same location by both parties', async () => {
      const merge = new MergeEngine();

      const base = 'A\nB\nC';
      const ours = 'A\nX\nB\nC'; // Inserted X between A and B
      const theirs = 'A\nY\nB\nC'; // Inserted Y between A and B

      const result = await merge.threeWay(base, ours, theirs);
      // This is a conflict since both inserted at same location
      expect(result.success).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
    });
  });

  describe('persistence across sessions', () => {
    it('should persist shadow git state across agent restarts', async () => {
      const shadowGit = new ShadowGit({ redis, namespace: 'project-1' });

      // First session: make edits
      await shadowGit.init('src/app.ts', 'initial content');
      await shadowGit.commit('src/app.ts', 'modified content', 'agent-a');

      // Simulate agent restart - new ShadowGit instance, same Redis
      const shadowGit2 = new ShadowGit({ redis, namespace: 'project-1' });

      const content = await shadowGit2.getLatest('src/app.ts');
      expect(content).toBe('modified content');

      const history = await shadowGit2.getHistory('src/app.ts');
      expect(history).toHaveLength(2); // init + commit
    });

    it('should recover file state after Redis reconnection', async () => {
      const shadowGit = new ShadowGit({ redis, namespace: 'project-1' });
      await shadowGit.init('file.ts', 'content');
      await shadowGit.commit('file.ts', 'updated', 'agent-a');

      // Redis disconnect and reconnect
      redis.disconnect();
      redis.reconnect();

      const content = await shadowGit.getLatest('file.ts');
      expect(content).toBe('updated');
    });
  });
});
