import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TestAgentFactory,
  MockEventBus,
  MockStateManager,
  MockBroadcastChannel,
  installMockBroadcastChannel,
  uninstallMockBroadcastChannel,
  TestClock,
  TestScheduler,
} from '../../__test__';

// --- E2E Scenario 26: Browser Environment Constraints ---
// Tests offline/online transitions, tab death detection, Web Worker crashes,
// IndexedDB quota, cross-tab coordination, Service Worker, memory limits,
// Page Visibility API, and WebSocket reconnection.

describe('E2E Scenario 26: Browser-Specific Constraints', () => {
  let eventBus: MockEventBus;
  let stateManager: MockStateManager;
  let clock: TestClock;
  let scheduler: TestScheduler;

  beforeEach(() => {
    const ctx = TestAgentFactory.create();
    eventBus = ctx.eventBus;
    stateManager = ctx.stateManager;
    clock = new TestClock();
    scheduler = new TestScheduler();
    clock.install();
    installMockBroadcastChannel();
  });

  afterEach(() => {
    clock.uninstall();
    scheduler.reset();
    uninstallMockBroadcastChannel();
    MockBroadcastChannel.resetAll();
  });

  describe('Offline/Online Transition', () => {
    it('should queue operations while offline', async () => {
      const agent = stateManager.get<any>('browserAgent');
      agent.setNetworkStatus('offline');

      // Operations should queue instead of fail
      await agent.submitTask({ id: 'offline-task', input: 'data' });
      await agent.submitTask({ id: 'offline-task-2', input: 'data' });

      expect(agent.offlineQueue.length).toBe(2);
    });

    it('should flush queued operations when transitioning to online', async () => {
      const agent = stateManager.get<any>('browserAgent');
      agent.setNetworkStatus('offline');

      await agent.submitTask({ id: 'task-1', input: 'data' });
      await agent.submitTask({ id: 'task-2', input: 'data' });

      // Come back online
      agent.setNetworkStatus('online');
      await agent.flush();

      expect(agent.offlineQueue.length).toBe(0);
      expect(agent.submittedCount).toBe(2);
    });

    it('should emit connectivity change events', async () => {
      const agent = stateManager.get<any>('browserAgent');

      agent.setNetworkStatus('offline');
      expect(eventBus.emitted('network:offline')).toBe(true);

      agent.setNetworkStatus('online');
      expect(eventBus.emitted('network:online')).toBe(true);
    });

    it('should handle rapid online/offline toggling gracefully', async () => {
      const agent = stateManager.get<any>('browserAgent');

      agent.setNetworkStatus('offline');
      agent.setNetworkStatus('online');
      agent.setNetworkStatus('offline');
      agent.setNetworkStatus('online');

      // Should not corrupt state
      expect(agent.getNetworkStatus()).toBe('online');
      expect(agent.offlineQueue.length).toBe(0);
    });
  });

  describe('Tab Death Detection', () => {
    it('should detect lost tab via BroadcastChannel heartbeat timeout', async () => {
      const coordinator = stateManager.get<any>('tabCoordinator');
      coordinator.setHeartbeatInterval(1000);
      coordinator.setDeathTimeout(3000);

      // Register tab
      coordinator.registerTab('tab-1');
      coordinator.registerTab('tab-2');

      // tab-2 stops sending heartbeats
      coordinator.simulateTabDeath('tab-2');
      clock.advance(3500);

      expect(coordinator.getDeadTabs()).toContain('tab-2');
      expect(eventBus.emitted('tab:died')).toBe(true);
    });

    it('should reassign work from dead tab to surviving tabs', async () => {
      const coordinator = stateManager.get<any>('tabCoordinator');
      coordinator.registerTab('tab-1');
      coordinator.registerTab('tab-2');

      // tab-2 had tasks assigned
      coordinator.assignTask('tab-2', { id: 'orphaned-task', input: 'data' });

      coordinator.simulateTabDeath('tab-2');
      clock.advance(3500);

      // Tasks should be reassigned to tab-1
      const tab1Tasks = coordinator.getTabTasks('tab-1');
      expect(tab1Tasks.some((t: any) => t.id === 'orphaned-task')).toBe(true);
    });

    it('should clean up resources for dead tab', async () => {
      const coordinator = stateManager.get<any>('tabCoordinator');
      coordinator.registerTab('tab-1');

      coordinator.simulateTabDeath('tab-1');
      clock.advance(3500);

      expect(coordinator.isRegistered('tab-1')).toBe(false);
    });
  });

  describe('Web Worker Crash', () => {
    it('should detect Web Worker crash from main thread', async () => {
      const workerManager = stateManager.get<any>('workerManager');

      workerManager.spawnWorker('worker-1');
      workerManager.simulateWorkerCrash('worker-1');

      expect(eventBus.emitted('worker:crashed')).toBe(true);
      expect(workerManager.getWorkerStatus('worker-1')).toBe('crashed');
    });

    it('should restart crashed worker automatically', async () => {
      const workerManager = stateManager.get<any>('workerManager');
      workerManager.setAutoRestart(true);

      workerManager.spawnWorker('worker-1');
      workerManager.simulateWorkerCrash('worker-1');

      clock.advance(100); // restart delay

      expect(workerManager.getWorkerStatus('worker-1')).toBe('running');
      expect(eventBus.emitted('worker:restarted')).toBe(true);
    });

    it('should not restart worker after max restart attempts', async () => {
      const workerManager = stateManager.get<any>('workerManager');
      workerManager.setAutoRestart(true);
      workerManager.setMaxRestarts(3);

      workerManager.spawnWorker('worker-1');

      // Crash 4 times
      for (let i = 0; i < 4; i++) {
        workerManager.simulateWorkerCrash('worker-1');
        clock.advance(100);
      }

      expect(workerManager.getWorkerStatus('worker-1')).toBe('terminated');
      expect(eventBus.emitted('worker:terminatedPermanently')).toBe(true);
    });
  });

  describe('IndexedDB Quota', () => {
    it('should handle quota exceeded error gracefully', async () => {
      const storage = stateManager.get<any>('browserStorage');
      storage.simulateQuotaExceeded();

      // Should not throw, instead degrade gracefully
      const result = await storage.persist({ key: 'large-data', value: 'x'.repeat(10000) });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('quota');
      expect(eventBus.emitted('storage:quotaExceeded')).toBe(true);
    });

    it('should fall back to in-memory storage when quota is exceeded', async () => {
      const storage = stateManager.get<any>('browserStorage');
      storage.simulateQuotaExceeded();

      await storage.persist({ key: 'fallback-data', value: 'important' });

      // Should be retrievable from memory fallback
      const retrieved = await storage.get('fallback-data');
      expect(retrieved).toBe('important');
    });

    it('should attempt cleanup of old data when quota is near', async () => {
      const storage = stateManager.get<any>('browserStorage');
      storage.setUsagePercent(90); // 90% full

      await storage.persist({ key: 'new-data', value: 'x' });

      expect(eventBus.emitted('storage:cleanupTriggered')).toBe(true);
    });
  });

  describe('Cross-Tab Agent Coordination', () => {
    it('should coordinate agents across tabs using BroadcastChannel', async () => {
      const tab1Channel = new MockBroadcastChannel('agent-coord');
      const tab2Channel = new MockBroadcastChannel('agent-coord');

      const received: any[] = [];
      tab2Channel.onmessage = (event) => received.push(event.data);

      // Tab 1 broadcasts task completion
      tab1Channel.postMessage({ type: 'task:complete', taskId: 'shared-1' });

      expect(received).toHaveLength(1);
      expect(received[0].taskId).toBe('shared-1');
    });

    it('should elect leader tab for coordination', async () => {
      const coordinator = stateManager.get<any>('tabCoordinator');
      coordinator.registerTab('tab-1');
      coordinator.registerTab('tab-2');
      coordinator.registerTab('tab-3');

      await coordinator.electLeaderTab();

      const leader = coordinator.getLeaderTab();
      expect(leader).toBeDefined();
      expect(['tab-1', 'tab-2', 'tab-3']).toContain(leader);
    });

    it('should prevent duplicate processing across tabs', async () => {
      const coordinator = stateManager.get<any>('tabCoordinator');
      coordinator.registerTab('tab-1');
      coordinator.registerTab('tab-2');

      // Both tabs try to claim same task
      const claim1 = coordinator.claimTask('tab-1', 'task-shared');
      const claim2 = coordinator.claimTask('tab-2', 'task-shared');

      // Only one should succeed
      expect([claim1, claim2].filter(Boolean).length).toBe(1);
    });
  });

  describe('Service Worker Background Processing', () => {
    it('should offload background tasks to Service Worker', async () => {
      const swManager = stateManager.get<any>('serviceWorkerManager');
      swManager.register();

      await swManager.submitBackgroundTask({ id: 'bg-1', type: 'sync' });

      expect(swManager.pendingBackgroundTasks).toBe(1);
    });

    it('should handle Service Worker lifecycle (install, activate)', async () => {
      const swManager = stateManager.get<any>('serviceWorkerManager');

      await swManager.register();
      expect(swManager.state).toBe('installing');

      await swManager.install();
      expect(swManager.state).toBe('installed');

      await swManager.activate();
      expect(swManager.state).toBe('activated');
    });

    it('should continue processing after page refresh via Service Worker', async () => {
      const swManager = stateManager.get<any>('serviceWorkerManager');
      await swManager.register();
      await swManager.install();
      await swManager.activate();

      // Submit long-running task
      await swManager.submitBackgroundTask({ id: 'long-task', duration: 30000 });

      // Simulate page unload
      swManager.simulatePageUnload();

      // Task should still be tracked in SW
      expect(swManager.getTaskStatus('long-task')).toBe('processing');
    });
  });

  describe('Memory Constraints', () => {
    it('should respect browser memory limits for conversation history', async () => {
      const agent = stateManager.get<any>('browserAgent');
      agent.setMemoryLimit(50); // max 50 messages

      // Add 60 messages
      for (let i = 0; i < 60; i++) {
        agent.addMessage({ role: 'user', content: `message ${i}` });
      }

      // Should cap at 50 (oldest evicted)
      expect(agent.getMessageCount()).toBeLessThanOrEqual(50);
    });

    it('should emit warning when approaching memory limit', async () => {
      const agent = stateManager.get<any>('browserAgent');
      agent.setMemoryLimit(100);
      agent.setMemoryWarningThreshold(0.8); // warn at 80%

      for (let i = 0; i < 85; i++) {
        agent.addMessage({ role: 'user', content: `msg ${i}` });
      }

      expect(eventBus.emitted('memory:warning')).toBe(true);
    });
  });

  describe('Page Visibility API', () => {
    it('should pause processing when tab becomes hidden', async () => {
      const agent = stateManager.get<any>('browserAgent');
      agent.start();

      agent.handleVisibilityChange('hidden');

      expect(agent.isPaused()).toBe(true);
      expect(eventBus.emitted('agent:paused')).toBe(true);
    });

    it('should resume processing when tab becomes visible', async () => {
      const agent = stateManager.get<any>('browserAgent');
      agent.start();
      agent.handleVisibilityChange('hidden');

      agent.handleVisibilityChange('visible');

      expect(agent.isPaused()).toBe(false);
      expect(eventBus.emitted('agent:resumed')).toBe(true);
    });

    it('should not drop queued tasks when pausing due to visibility', async () => {
      const agent = stateManager.get<any>('browserAgent');
      agent.start();

      agent.submitTask({ id: 'queued', input: 'data' });
      agent.handleVisibilityChange('hidden');

      // Task should still be queued
      expect(agent.getQueuedTaskCount()).toBe(1);

      agent.handleVisibilityChange('visible');
      // Task should process after resume
    });
  });

  describe('WebSocket Reconnection', () => {
    it('should detect WebSocket disconnection', async () => {
      const wsManager = stateManager.get<any>('websocketManager');
      await wsManager.connect('wss://api.example.com');

      wsManager.simulateDisconnect();

      expect(wsManager.isConnected()).toBe(false);
      expect(eventBus.emitted('ws:disconnected')).toBe(true);
    });

    it('should auto-reconnect with exponential backoff', async () => {
      const wsManager = stateManager.get<any>('websocketManager');
      wsManager.setReconnectPolicy({ maxAttempts: 5, backoffMs: [100, 200, 400, 800, 1600] });

      await wsManager.connect('wss://api.example.com');
      wsManager.simulateDisconnect();

      // First reconnect attempt
      clock.advance(100);
      expect(wsManager.reconnectAttempts).toBe(1);

      // Second attempt
      clock.advance(200);
      expect(wsManager.reconnectAttempts).toBe(2);
    });

    it('should buffer outgoing messages during disconnection', async () => {
      const wsManager = stateManager.get<any>('websocketManager');
      await wsManager.connect('wss://api.example.com');
      wsManager.simulateDisconnect();

      // Send while disconnected
      wsManager.send({ type: 'task', data: 'buffered' });
      wsManager.send({ type: 'task', data: 'also buffered' });

      expect(wsManager.outboundBuffer.length).toBe(2);
    });

    it('should flush buffer on successful reconnect', async () => {
      const wsManager = stateManager.get<any>('websocketManager');
      await wsManager.connect('wss://api.example.com');
      wsManager.simulateDisconnect();

      wsManager.send({ type: 'task', data: 'buffered' });

      // Reconnect
      await wsManager.reconnect();

      expect(wsManager.outboundBuffer.length).toBe(0);
      expect(wsManager.sentMessages.length).toBe(1);
    });
  });
});
