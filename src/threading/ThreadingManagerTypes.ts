/**
 * Runtime environment
 */
export enum RuntimeEnvironment {
  NODE = 'node',
  BROWSER = 'browser',
  WEB_WORKER = 'web_worker',
  WORKER_THREAD = 'worker_thread',
  UNKNOWN = 'unknown'
}

/**
 * Runner type
 */
export enum RunnerType {
  MAIN = 'main',  // Same thread
  WORKER_THREAD = 'worker_thread',  // Node.js Worker Thread
  WEB_WORKER = 'web_worker',  // Browser Web Worker
  CHILD_PROCESS = 'child_process',  // Node.js Child Process
  BROADCAST_CHANNEL = 'broadcast_channel'  // Browser multi-tab
}

/**
 * Runner pool configuration
 */
export interface RunnerPoolConfig {
  minSize?: number;  // Minimum runners to keep alive
  maxSize?: number;  // Maximum runners
  idleTimeout?: number;  // ms to keep idle runners
  strategy?: 'round-robin' | 'least-loaded' | 'random';
  healthCheckInterval?: number;  // ms between health checks
}

/**
 * Runner info for monitoring
 */
export interface RunnerInfo {
  id: string;
  type: RunnerType;
  status: 'initializing' | 'idle' | 'busy' | 'error' | 'shutdown';
  workload: number;  // Current number of tasks
  uptime: number;  // ms
  totalTasks: number;  // Total tasks executed
  errors: number;  // Total errors
  lastActivity?: number;  // Timestamp
}

/**
 * Threading Manager Options
 */
export interface ThreadingManagerOptions {
  defaultThreadingConfig?: import('../interfaces/IAgentConfig.js').ThreadingConfig;
  poolConfig?: RunnerPoolConfig;
  workerScriptPath?: string;  // For Node.js workers
  processScriptPath?: string;  // For child processes
  webWorkerScriptUrl?: string;  // For Web Workers
  autoDetectEnvironment?: boolean;  // Default: true
}
