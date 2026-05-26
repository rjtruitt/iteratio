import { Worker, WorkerOptions } from 'worker_threads';
import { AgentConfig, ThreadingConfig } from '../interfaces/IAgentConfig.js';
import { IAgentLoop, LoopState } from '../interfaces/IAgentLoop.js';
import { IMessageManager } from '../interfaces/IMessageManager.js';
import { EventEmitter } from 'events';

/**
 * Message types for worker communication
 */
export enum WorkerMessageType {
  INIT = 'init',
  RUN_TURN = 'run_turn',
  RUN = 'run',
  GET_STATE = 'get_state',
  SHUTDOWN = 'shutdown',
  RESPONSE = 'response',
  ERROR = 'error',
  EVENT = 'event',
  HEARTBEAT = 'heartbeat'
}

export interface WorkerMessage {
  type: WorkerMessageType;
  id: string;
  payload?: any;
  error?: any;
}

export interface WorkerThreadRunnerOptions {
  agentConfig: AgentConfig;
  threadingConfig: ThreadingConfig;
  workerScriptPath: string;  // Path to worker entry point
  heartbeatInterval?: number;  // ms, default 5000
  healthCheckTimeout?: number;  // ms, default 10000
}

/** Runs AgentLoop in a Node.js Worker Thread with message passing and resource isolation. */
export class WorkerThreadRunner extends EventEmitter implements IAgentLoop {
  private worker?: Worker;
  private agentConfig: AgentConfig;
  private threadingConfig: ThreadingConfig;
  private workerScriptPath: string;
  private messageId = 0;
  private pendingMessages = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timeout: NodeJS.Timeout;
  }>();
  private isInitialized = false;
  private isShuttingDown = false;
  private heartbeatInterval?: NodeJS.Timeout;
  private lastHeartbeat?: number;
  private healthCheckTimeout: number;

  /**
   * Construct a new WorkerThreadRunner.
   *
   * @param options - Options including agent config, threading config, and worker script path
   */
  constructor(options: WorkerThreadRunnerOptions) {
    super();
    this.agentConfig = options.agentConfig;
    this.threadingConfig = options.threadingConfig;
    this.workerScriptPath = options.workerScriptPath;
    this.healthCheckTimeout = options.healthCheckTimeout || 10000;

  }

  /** Initialize worker thread and set up message handlers. */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const workerOptions: WorkerOptions = {
      workerData: {
        agentConfig: this.agentConfig,
        ...(this.threadingConfig.workerData || {})
      },
      resourceLimits: this.threadingConfig.resourceLimits || {
        maxOldGenerationSizeMb: 512,
        maxYoungGenerationSizeMb: 64
      },
    };

    this.worker = new Worker(this.workerScriptPath, workerOptions);

    // Set up message handler
    this.worker.on('message', (message: WorkerMessage) => {
      this.handleWorkerMessage(message);
    });

    // Set up error handler
    this.worker.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Set up exit handler
    this.worker.on('exit', (code: number) => {
      if (!this.isShuttingDown && code !== 0) {
        this.emit('error', new Error(`Worker exited with code ${code}`));
      }
    });

    // Send initialization message
    await this.sendMessage({
      type: WorkerMessageType.INIT,
      id: this.generateMessageId(),
      payload: { agentConfig: this.agentConfig }
    });

    // Start heartbeat monitoring
    this.startHeartbeatMonitoring();

    this.isInitialized = true;
  }

  /**
   * Execute one turn in the worker thread.
   * Initializes the worker first if not already initialized.
   *
   * @param input - Input string for the turn
   * @returns The result from the worker thread
   */
  async runTurn(input: string): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const response = await this.sendMessage({
      type: WorkerMessageType.RUN_TURN,
      id: this.generateMessageId(),
      payload: { input }
    });

    return response.result;
  }

  /**
   * Run the loop until completion in the worker thread.
   * Initializes the worker first if not already initialized.
   *
   * @param options - Optional runtime options
   */
  async run(options?: any): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    await this.sendMessage({
      type: WorkerMessageType.RUN,
      id: this.generateMessageId(),
      payload: { options }
    });
  }

  /**
   * Get the MessageManager interface.
   *
   * @throws Error always - MessageManager is not available in a distributed worker thread context
   */
  getMessageManager(): IMessageManager {
    throw new Error('getMessageManager not available in distributed context');
  }

  /**
   * Get current loop state from worker (sync interface not supported).
   *
   * @throws Error always - use getStateAsync() instead
   */
  getState(): LoopState {
    throw new Error('getState must be async in worker context. Use getStateAsync()');
  }

  /**
   * Get the current loop state from the worker thread asynchronously.
   *
   * @returns Promise resolving to the current LoopState
   */
  async getStateAsync(): Promise<LoopState> {
    if (!this.isInitialized) {
      return {
        turnNumber: 0,
        isRunning: false,
        metadata: {}
      };
    }

    const response = await this.sendMessage({
      type: WorkerMessageType.GET_STATE,
      id: this.generateMessageId()
    });

    return response.state;
  }

  /**
   * Add a plugin to the runner.
   *
   * @throws Error always - plugins must be configured in agentConfig prior to worker creation
   */
  addPlugin(plugin: any): void {
    throw new Error('Cannot add plugins to worker thread runner. Configure plugins in agentConfig instead.');
  }

  /**
   * Gracefully shutdown the worker thread by sending a shutdown message,
   * stopping heartbeat monitoring, and terminating the worker.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown || !this.worker) {
      return;
    }

    this.isShuttingDown = true;

    // Stop heartbeat monitoring
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    try {
      // Send shutdown message
      await this.sendMessage({
        type: WorkerMessageType.SHUTDOWN,
        id: this.generateMessageId()
      }, 5000);  // 5 second timeout

      // Terminate worker
      await this.worker.terminate();
    } catch (error) {
      // Force terminate
      await this.worker.terminate();
    } finally {
      this.worker = undefined;
      this.isInitialized = false;
      this.isShuttingDown = false;
    }
  }

  /**
   * Send a message to the worker thread and wait for a response.
   *
   * @param message - The message to send
   * @param timeout - Maximum time to wait for response in milliseconds (default: 30000)
   * @returns The response payload
   * @throws Error if worker not initialized or message times out
   */
  private async sendMessage(message: WorkerMessage, timeout: number = 30000): Promise<any> {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingMessages.delete(message.id);
        reject(new Error(`Message timeout: ${message.type}`));
      }, timeout);

      this.pendingMessages.set(message.id, {
        resolve,
        reject,
        timeout: timeoutHandle
      });

      this.worker!.postMessage(message);
    });
  }

  /**
   * Handle an incoming message from the worker thread.
   * Routes events and heartbeats, and resolves/rejects pending message promises.
   *
   * @param message - The incoming worker message
   */
  private handleWorkerMessage(message: WorkerMessage): void {
    // Handle events (not responses to requests)
    if (message.type === WorkerMessageType.EVENT) {
      this.emit('worker-event', message.payload);
      return;
    }

    // Handle heartbeats
    if (message.type === WorkerMessageType.HEARTBEAT) {
      this.lastHeartbeat = Date.now();
      return;
    }

    // Handle responses to requests
    const pending = this.pendingMessages.get(message.id);
    if (!pending) {
      // Unexpected message
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingMessages.delete(message.id);

    if (message.type === WorkerMessageType.ERROR) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.payload);
    }
  }

  /**
   * Start periodic heartbeat monitoring to detect worker thread unresponsiveness.
   */
  private startHeartbeatMonitoring(): void {
    this.lastHeartbeat = Date.now();

    this.heartbeatInterval = setInterval(() => {
      if (!this.lastHeartbeat) return;

      const elapsed = Date.now() - this.lastHeartbeat;
      if (elapsed > this.healthCheckTimeout) {
        this.emit('error', new Error('Worker heartbeat timeout'));
      }
    }, 5000);
  }

  /**
   * Generate a unique message ID for tracking pending requests.
   *
   * @returns A unique message ID string
   */
  private generateMessageId(): string {
    return `msg_${++this.messageId}_${Date.now()}`;
  }
}
