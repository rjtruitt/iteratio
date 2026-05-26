import { fork, ChildProcess, ForkOptions } from 'child_process';
import { AgentConfig, ThreadingConfig } from '../interfaces/IAgentConfig.js';
import { IAgentLoop, LoopState } from '../interfaces/IAgentLoop.js';
import { IMessageManager } from '../interfaces/IMessageManager.js';
import { EventEmitter } from 'events';
import * as path from 'path';

/**
 * Message types for child process communication
 */
export enum ChildProcessMessageType {
  INIT = 'init',
  RUN_TURN = 'run_turn',
  RUN = 'run',
  GET_STATE = 'get_state',
  SHUTDOWN = 'shutdown',
  RESPONSE = 'response',
  ERROR = 'error',
  EVENT = 'event',
  HEARTBEAT = 'heartbeat',
  RESOURCE_USAGE = 'resource_usage'
}

export interface ChildProcessMessage {
  type: ChildProcessMessageType;
  id: string;
  payload?: any;
  error?: any;
}

export interface ChildProcessRunnerOptions {
  agentConfig: AgentConfig;
  threadingConfig: ThreadingConfig;
  processScriptPath: string;  // Path to process entry point
  heartbeatInterval?: number;  // ms, default 5000
  healthCheckTimeout?: number;  // ms, default 10000
  autoRestart?: boolean;  // Auto-restart on crash
  maxRestarts?: number;  // Max restart attempts
}

export interface ProcessResourceUsage {
  cpu: number;  // Percentage
  memory: number;  // Bytes
  uptime: number;  // Seconds
  pid: number;
}

/** Runs AgentLoop in a Node.js Child Process with IPC, isolation, and auto-restart. */
export class ChildProcessRunner extends EventEmitter implements IAgentLoop {
  private process?: ChildProcess;
  private agentConfig: AgentConfig;
  private threadingConfig: ThreadingConfig;
  private processScriptPath: string;
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
  private autoRestart: boolean;
  private maxRestarts: number;
  private restartCount = 0;
  private lastResourceUsage?: ProcessResourceUsage;

  /**
   * Construct a new ChildProcessRunner.
   *
   * @param options - Options including agent config, threading config, and process script path
   */
  constructor(options: ChildProcessRunnerOptions) {
    super();
    this.agentConfig = options.agentConfig;
    this.threadingConfig = options.threadingConfig;
    this.processScriptPath = options.processScriptPath;
    this.healthCheckTimeout = options.healthCheckTimeout || 10000;
    this.autoRestart = options.autoRestart ?? true;
    this.maxRestarts = options.maxRestarts ?? 3;

  }

  /** Initialize child process and establish IPC. */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const forkOptions: ForkOptions = {
      cwd: this.threadingConfig.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(this.threadingConfig.env || {}),
        // Pass agent config as env var (for small configs)
        // For large configs, use IPC message
        AGENT_NAME: this.agentConfig.name
      },
      silent: false,
      execArgv: [],
      serialization: 'json'
    };

    // Fork the process
    this.process = fork(this.processScriptPath, [], forkOptions);

    // Set up message handler
    this.process.on('message', (message: ChildProcessMessage) => {
      this.handleProcessMessage(message);
    });

    this.process.on('error', (error: Error) => {
      this.emit('error', error);
    });

    // Set up exit handler
    this.process.on('exit', (code: number | null, signal: string | null) => {
      this.handleProcessExit(code, signal);
    });

    // Set up stdio handlers (if not silent)
    if (this.process.stdout) {
      this.process.stdout.on('data', (data: Buffer) => {
        this.emit('stdout', data.toString());
      });
    }

    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        this.emit('stderr', data.toString());
      });
    }

    // Send initialization message
    await this.sendMessage({
      type: ChildProcessMessageType.INIT,
      id: this.generateMessageId(),
      payload: { agentConfig: this.agentConfig }
    });

    // Start heartbeat monitoring
    this.startHeartbeatMonitoring();

    // Start resource monitoring
    this.startResourceMonitoring();

    this.isInitialized = true;
    this.restartCount = 0;
  }

  /**
   * Execute one turn in the child process.
   * Initializes the process first if not already initialized.
   *
   * @param input - Input string for the turn
   * @returns The result from the child process
   */
  async runTurn(input: string): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const response = await this.sendMessage({
      type: ChildProcessMessageType.RUN_TURN,
      id: this.generateMessageId(),
      payload: { input }
    });

    return response.result;
  }

  /**
   * Run the loop until completion in the child process.
   * Initializes the process first if not already initialized.
   *
   * @param options - Optional runtime options
   */
  async run(options?: any): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    await this.sendMessage({
      type: ChildProcessMessageType.RUN,
      id: this.generateMessageId(),
      payload: { options }
    });
  }

  /**
   * Get the MessageManager interface.
   *
   * @throws Error always - MessageManager is not available in a child process context
   */
  getMessageManager(): IMessageManager {
    throw new Error('getMessageManager not available in distributed context');
  }

  /**
   * Get the current loop state from the process (sync interface).
   *
   * @throws Error always - use getStateAsync() instead
   */
  getState(): LoopState {
    // This should be async, but interface requires sync
    throw new Error('getState must be async in child process context. Use getStateAsync()');
  }

  /**
   * Get the current loop state from the child process asynchronously.
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
      type: ChildProcessMessageType.GET_STATE,
      id: this.generateMessageId()
    });

    return response.state;
  }

  /**
   * Add a plugin to the runner.
   *
   * @throws Error always - plugins must be configured in agentConfig prior to process creation
   */
  addPlugin(plugin: any): void {
    throw new Error('Cannot add plugins to child process runner. Configure plugins in agentConfig instead.');
  }

  /**
   * Gracefully shutdown the child process by sending a shutdown message,
   * then force-killing with SIGTERM/SIGKILL if it does not exit cleanly.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown || !this.process) {
      return;
    }

    this.isShuttingDown = true;
    this.autoRestart = false;  // Disable auto-restart during shutdown

    // Stop monitoring
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    try {
      // Send shutdown message
      await this.sendMessage({
        type: ChildProcessMessageType.SHUTDOWN,
        id: this.generateMessageId()
      }, 5000);  // 5 second timeout

      // Give process time to exit gracefully
      await this.waitForExit(3000);
    } catch (error) {
      // Force kill
      this.process.kill('SIGTERM');
      await this.waitForExit(2000);
      this.process.kill('SIGKILL');
    } finally {
      this.process = undefined;
      this.isInitialized = false;
      this.isShuttingDown = false;
    }
  }

  /**
   * Get the current resource usage statistics for the child process.
   *
   * @returns ProcessResourceUsage or undefined if not available
   */
  getResourceUsage(): ProcessResourceUsage | undefined {
    return this.lastResourceUsage;
  }

  /**
   * Send a message to the child process and wait for a response.
   *
   * @param message - The message to send
   * @param timeout - Maximum time to wait for response in milliseconds (default: 30000)
   * @returns The response payload
   * @throws Error if process not initialized, disconnected, or message times out
   */
  private async sendMessage(message: ChildProcessMessage, timeout: number = 30000): Promise<any> {
    if (!this.process || !this.process.connected) {
      throw new Error('Process not initialized or disconnected');
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

      this.process!.send(message);
    });
  }

  /**
   * Handle an incoming message from the child process.
   * Routes events, heartbeats, and resource updates; resolves/rejects pending message promises.
   *
   * @param message - The incoming process message
   */
  private handleProcessMessage(message: ChildProcessMessage): void {
    // Handle events (not responses to requests)
    if (message.type === ChildProcessMessageType.EVENT) {
      this.emit('process-event', message.payload);
      return;
    }

    // Handle heartbeats
    if (message.type === ChildProcessMessageType.HEARTBEAT) {
      this.lastHeartbeat = Date.now();
      return;
    }

    // Handle resource usage updates
    if (message.type === ChildProcessMessageType.RESOURCE_USAGE) {
      this.lastResourceUsage = message.payload;
      this.emit('resource-usage', message.payload);
      return;
    }

    // Handle responses to requests
    const pending = this.pendingMessages.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingMessages.delete(message.id);

    if (message.type === ChildProcessMessageType.ERROR) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.payload);
    }
  }

  /**
   * Handle process exit and attempt restart if auto-restart is configured.
   * Rejects all pending messages and optionally re-initializes the process.
   *
   * @param code - Exit code (null if signal)
   * @param signal - Signal name (null if exit code)
   */
  private handleProcessExit(code: number | null, signal: string | null): void {
    if (this.isShuttingDown) {
      return;
    }

    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    this.emit('error', new Error(`Process exited with ${exitReason}`));

    // Fail all pending messages
    for (const [id, pending] of this.pendingMessages) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Process exited with ${exitReason}`));
    }
    this.pendingMessages.clear();

    // Attempt restart if enabled
    if (this.autoRestart && this.restartCount < this.maxRestarts) {
      this.restartCount++;
      this.emit('restart', { attempt: this.restartCount });
      setTimeout(() => {
        this.isInitialized = false;
        this.initialize().catch(error => {
          this.emit('error', error);
        });
      }, 1000 * this.restartCount);  // Exponential backoff
    }
  }

  /**
   * Start periodic heartbeat monitoring to detect child process unresponsiveness.
   */
  private startHeartbeatMonitoring(): void {
    this.lastHeartbeat = Date.now();

    this.heartbeatInterval = setInterval(() => {
      if (!this.lastHeartbeat) return;

      const elapsed = Date.now() - this.lastHeartbeat;
      if (elapsed > this.healthCheckTimeout) {
        this.emit('error', new Error('Process heartbeat timeout'));
      }
    }, 5000);
  }

  /**
   * Start periodic resource usage monitoring.
   * Currently a stub — child processes send RESOURCE_USAGE messages autonomously.
   */
  private startResourceMonitoring(): void {
    setInterval(() => {
      if (this.process && this.process.connected) {
        // Process sends back resource usage via RESOURCE_USAGE message type
      }
    }, 10000);
  }

  /**
   * Wait for the child process to exit within the given timeout.
   *
   * @param timeout - Maximum time to wait in milliseconds
   * @returns Promise that resolves when the process exits or timeout elapses
   */
  private waitForExit(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        resolve();
      }, timeout);

      this.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
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
