import { AgentConfig } from '../interfaces/IAgentConfig.js';
import { IAgentLoop } from '../interfaces/IAgentLoop.js';

/**
 * Message types for BroadcastChannel communication
 */
export enum BroadcastMessageType {
  // Coordination
  HELLO = 'hello',
  GOODBYE = 'goodbye',
  HEARTBEAT = 'heartbeat',
  PING = 'ping',
  PONG = 'pong',

  // Leader election
  ELECTION = 'election',
  VICTORY = 'victory',
  LEADER_ANNOUNCE = 'leader_announce',

  // Work distribution
  WORK_OFFER = 'work_offer',
  WORK_CLAIM = 'work_claim',
  WORK_COMPLETE = 'work_complete',
  WORK_FAILED = 'work_failed',

  // State sync
  STATE_UPDATE = 'state_update',
  STATE_REQUEST = 'state_request',
  STATE_RESPONSE = 'state_response',

  // Agent operations
  RUN_TURN = 'run_turn',
  RUN_TURN_RESULT = 'run_turn_result',
  RUN = 'run',
  SHUTDOWN = 'shutdown'
}

export interface BroadcastMessage {
  type: BroadcastMessageType;
  tabId: string;
  timestamp: number;
  payload?: any;
}

export interface TabInfo {
  tabId: string;
  isLeader: boolean;
  lastHeartbeat: number;
  workload: number;  // Number of active tasks
  capabilities: string[];
}

export interface WorkItem {
  id: string;
  type: 'turn' | 'run';
  payload: any;
  priority: number;
  createdAt: number;
  claimedBy?: string;
  claimedAt?: number;
}

export interface BroadcastChannelCoordinatorOptions {
  agentConfig: AgentConfig;
  agentLoop: IAgentLoop;  // Local agent loop instance
  channelName?: string;  // Default: 'agent-coordinator'
  tabId?: string;  // Auto-generated if not provided
  heartbeatInterval?: number;  // ms, default 5000
  leaderTimeout?: number;  // ms, default 15000
  workStealingEnabled?: boolean;  // Default: true
  maxWorkloadPerTab?: number;  // Default: 5
}
