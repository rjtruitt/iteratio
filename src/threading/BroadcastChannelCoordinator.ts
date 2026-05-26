import type { AgentConfig } from '../interfaces/IAgentConfig.js';
import { IAgentLoop, LoopState } from '../interfaces/IAgentLoop.js';
import { IMessageManager } from '../interfaces/IMessageManager.js';
import { BroadcastMessageType, type BroadcastMessage, type TabInfo, type WorkItem, type BroadcastChannelCoordinatorOptions } from './BroadcastChannelTypes.js';

export { BroadcastMessageType, type BroadcastMessage, type TabInfo, type WorkItem, type BroadcastChannelCoordinatorOptions } from './BroadcastChannelTypes.js';

/** Coordinates AgentLoop across multiple browser tabs via BroadcastChannel. */
export class BroadcastChannelCoordinator implements IAgentLoop {
  private channel?: BroadcastChannel;
  private agentConfig: AgentConfig;
  private agentLoop: IAgentLoop;
  private channelName: string;
  private tabId: string;
  private isLeader = false;
  private knownTabs = new Map<string, TabInfo>();
  private heartbeatInterval?: number;
  private leaderTimeout: number;
  private workStealingEnabled: boolean;
  private maxWorkloadPerTab: number;
  private currentWorkload = 0;
  private workQueue: WorkItem[] = [];
  private pendingWork = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }>();
  private isShuttingDown = false;

  /**
   * Construct a new BroadcastChannelCoordinator.
   *
   * @param options - Options including agent config, local agent loop, and channel configuration
   */
  constructor(options: BroadcastChannelCoordinatorOptions) {
    this.agentConfig = options.agentConfig;
    this.agentLoop = options.agentLoop;
    this.channelName = options.channelName || 'agent-coordinator';
    this.tabId = options.tabId || this.generateTabId();
    this.leaderTimeout = options.leaderTimeout || 15000;
    this.workStealingEnabled = options.workStealingEnabled ?? true;
    this.maxWorkloadPerTab = options.maxWorkloadPerTab || 5;

  }

  /** Initialize coordinator: set up channel, announce presence, elect leader. */
  async initialize(): Promise<void> {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel is not supported in this browser');
    }

    this.channel = new BroadcastChannel(this.channelName);

    this.channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
      this.handleBroadcastMessage(event.data);
    };

    this.knownTabs.set(this.tabId, {
      tabId: this.tabId,
      isLeader: false,
      lastHeartbeat: Date.now(),
      workload: 0,
      capabilities: this.agentConfig.capabilities || []
    });

    this.broadcast({
      type: BroadcastMessageType.HELLO,
      tabId: this.tabId,
      timestamp: Date.now(),
      payload: {
        capabilities: this.agentConfig.capabilities || []
      }
    });

    this.startHeartbeat();
    this.startLeaderElection();
    this.startTabMonitoring();

    window.addEventListener('beforeunload', () => {
      this.handleTabClose();
    });
  }

  /** Execute one turn, distributed to the best-available tab. */
  async runTurn(input: string): Promise<string> {
    const workItem: WorkItem = {
      id: this.generateWorkId(),
      type: 'turn',
      payload: { input },
      priority: 1,
      createdAt: Date.now()
    };

    return this.executeWork(workItem);
  }

  /** Run the loop until completion. */
  async run(options?: any): Promise<void> {
    const workItem: WorkItem = {
      id: this.generateWorkId(),
      type: 'run',
      payload: { options },
      priority: 0,
      createdAt: Date.now()
    };

    await this.executeWork(workItem);
  }

  getMessageManager(): IMessageManager {
    throw new Error('getMessageManager not available in distributed context');
  }

  /** Get current loop state (returns local state). */
  getState(): LoopState {
    return this.agentLoop.getState();
  }

  /** Add plugin to local loop. */
  addPlugin(plugin: any): void {
    this.agentLoop.addPlugin(plugin);
  }

  /** Shutdown coordinator and broadcast goodbye. */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.broadcast({ type: BroadcastMessageType.GOODBYE, tabId: this.tabId, timestamp: Date.now() });
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.channel) this.channel.close();
    await this.agentLoop.shutdown();
  }

  /**
   * Execute work item by distributing to the appropriate tab or executing locally.
   * If leader, assigns the work; otherwise broadcasts a work offer.
   *
   * @param workItem - The work item to execute
   * @returns Promise resolving to the work result
   */
  private async executeWork(workItem: WorkItem): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pendingWork.set(workItem.id, { resolve, reject });

      if (this.isLeader) {
        this.assignWork(workItem);
      } else {
        this.broadcast({
          type: BroadcastMessageType.WORK_OFFER,
          tabId: this.tabId,
          timestamp: Date.now(),
          payload: { workItem }
        });
      }
    });
  }

  /**
   * Assign work item to the tab with the lowest workload (leader only).
   * Falls back to queueing if all tabs are at capacity.
   *
   * @param workItem - The work item to assign
   */
  private assignWork(workItem: WorkItem): void {
    let targetTab: TabInfo | undefined;
    let minWorkload = Infinity;

    for (const tab of this.knownTabs.values()) {
      if (tab.workload < minWorkload && tab.workload < this.maxWorkloadPerTab) {
        targetTab = tab;
        minWorkload = tab.workload;
      }
    }

    if (!targetTab) {
      this.workQueue.push(workItem);
      return;
    }

    workItem.claimedBy = targetTab.tabId;
    workItem.claimedAt = Date.now();
    targetTab.workload++;

    this.broadcast({
      type: BroadcastMessageType.WORK_CLAIM,
      tabId: this.tabId,
      timestamp: Date.now(),
      payload: { workItem }
    });
  }

  /**
   * Handle an incoming broadcast message and dispatch to the appropriate handler.
   * Ignores messages from the same tab.
   *
   * @param message - The incoming broadcast message
   */
  private handleBroadcastMessage(message: BroadcastMessage): void {
    if (message.tabId === this.tabId) {
      return;
    }

    switch (message.type) {
      case BroadcastMessageType.HELLO:
        this.handleTabHello(message);
        break;
      case BroadcastMessageType.GOODBYE:
        this.handleTabGoodbye(message);
        break;
      case BroadcastMessageType.HEARTBEAT:
        this.handleTabHeartbeat(message);
        break;
      case BroadcastMessageType.ELECTION:
        this.handleElection(message);
        break;
      case BroadcastMessageType.VICTORY:
        this.handleVictory(message);
        break;
      case BroadcastMessageType.LEADER_ANNOUNCE:
        this.handleLeaderAnnounce(message);
        break;
      case BroadcastMessageType.WORK_OFFER:
        this.handleWorkOffer(message);
        break;
      case BroadcastMessageType.WORK_CLAIM:
        this.handleWorkClaim(message);
        break;
      case BroadcastMessageType.WORK_COMPLETE:
        this.handleWorkComplete(message);
        break;
      case BroadcastMessageType.WORK_FAILED:
        this.handleWorkFailed(message);
        break;
    }
  }

  /** Start leader election (simplified Bully algorithm). */
  private startLeaderElection(): void {
    setTimeout(() => {
      if (this.knownTabs.size === 1) {
        this.becomeLeader();
      } else {
        this.broadcast({
          type: BroadcastMessageType.ELECTION,
          tabId: this.tabId,
          timestamp: Date.now()
        });
      }
    }, 1000);
  }

  private becomeLeader(): void {
    this.isLeader = true;
    const tabInfo = this.knownTabs.get(this.tabId);
    if (tabInfo) {
      tabInfo.isLeader = true;
    }

    this.broadcast({
      type: BroadcastMessageType.LEADER_ANNOUNCE,
      tabId: this.tabId,
      timestamp: Date.now()
    });

    console.log(`Tab ${this.tabId} is now leader`);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = window.setInterval(() => {
      this.broadcast({
        type: BroadcastMessageType.HEARTBEAT,
        tabId: this.tabId,
        timestamp: Date.now(),
        payload: {
          workload: this.currentWorkload,
          isLeader: this.isLeader
        }
      });
    }, 5000);
  }

  private startTabMonitoring(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [tabId, tab] of this.knownTabs) {
        if (tabId === this.tabId) continue;

        if (now - tab.lastHeartbeat > this.leaderTimeout) {
          console.log(`Tab ${tabId} is dead`);
          this.knownTabs.delete(tabId);

          if (tab.isLeader) {
            this.startLeaderElection();
          }
        }
      }
    }, 5000);
  }

  private handleTabHello(message: BroadcastMessage): void {
    this.knownTabs.set(message.tabId, {
      tabId: message.tabId,
      isLeader: false,
      lastHeartbeat: message.timestamp,
      workload: 0,
      capabilities: message.payload?.capabilities || []
    });

    this.broadcast({
      type: BroadcastMessageType.HEARTBEAT,
      tabId: this.tabId,
      timestamp: Date.now(),
      payload: {
        workload: this.currentWorkload,
        isLeader: this.isLeader
      }
    });
  }

  private handleTabGoodbye(message: BroadcastMessage): void { this.knownTabs.delete(message.tabId); }

  private handleTabHeartbeat(message: BroadcastMessage): void {
    const tab = this.knownTabs.get(message.tabId);
    if (tab) { tab.lastHeartbeat = message.timestamp; tab.workload = message.payload?.workload || 0; tab.isLeader = message.payload?.isLeader || false; }
  }

  private handleElection(_message: BroadcastMessage): void { /* Stub */ }
  private handleVictory(_message: BroadcastMessage): void { /* Stub */ }

  private handleLeaderAnnounce(message: BroadcastMessage): void {
    const tab = this.knownTabs.get(message.tabId);
    if (tab) {
      tab.isLeader = true;
    }
    this.isLeader = false;
  }

  private handleWorkOffer(message: BroadcastMessage): void {
    if (this.isLeader) {
      this.assignWork(message.payload.workItem);
    }
  }

  private handleWorkClaim(message: BroadcastMessage): void {
    const workItem: WorkItem = message.payload.workItem;
    if (workItem.claimedBy === this.tabId) {
      this.executeWorkLocally(workItem);
    }
  }

  private async executeWorkLocally(workItem: WorkItem): Promise<void> {
    this.currentWorkload++;

    try {
      let result: any;
      if (workItem.type === 'turn') {
        result = await this.agentLoop.runTurn(workItem.payload.input);
      } else if (workItem.type === 'run') {
        await this.agentLoop.run(workItem.payload.options);
        result = { success: true };
      }

      this.broadcast({
        type: BroadcastMessageType.WORK_COMPLETE,
        tabId: this.tabId,
        timestamp: Date.now(),
        payload: { workItem, result }
      });
    } catch (error) {
      this.broadcast({
        type: BroadcastMessageType.WORK_FAILED,
        tabId: this.tabId,
        timestamp: Date.now(),
        payload: { workItem, error: (error as Error).message }
      });
    } finally {
      this.currentWorkload--;
    }
  }

  private handleWorkComplete(message: BroadcastMessage): void {
    const workItem: WorkItem = message.payload.workItem;
    const pending = this.pendingWork.get(workItem.id);
    if (pending) {
      pending.resolve(message.payload.result);
      this.pendingWork.delete(workItem.id);
    }
  }

  private handleWorkFailed(message: BroadcastMessage): void {
    const workItem: WorkItem = message.payload.workItem;
    const pending = this.pendingWork.get(workItem.id);
    if (pending) {
      pending.reject(new Error(message.payload.error));
      this.pendingWork.delete(workItem.id);
    }
  }

  private handleTabClose(): void {
    if (!this.isShuttingDown) {
      this.shutdown();
    }
  }

  private broadcast(message: BroadcastMessage): void {
    if (this.channel) {
      this.channel.postMessage(message);
    }
  }

  private generateTabId(): string {
    return `tab_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`;
  }

  private generateWorkId(): string {
    return `work_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`;
  }
}
