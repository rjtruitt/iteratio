import { AgentConfig, ThreadingConfig } from '../interfaces/IAgentConfig.js';
import { IAgentLoop, LoopState } from '../interfaces/IAgentLoop.js';
import { IMessageManager } from '../interfaces/IMessageManager.js';

/**
 * Message types for Web Worker communication
 */
export enum WebWorkerMessageType {
  INIT = 'init',
  RUN_TURN = 'run_turn',
  RUN = 'run',
  GET_STATE = 'get_state',
  SHUTDOWN = 'shutdown',
  RESPONSE = 'response',
  ERROR = 'error',
  EVENT = 'event',
  PROGRESS = 'progress'
}

export interface WebWorkerMessage {
  type: WebWorkerMessageType;
  id: string;
  payload?: any;
  error?: any;
  transfer?: Transferable[];  // For transferable objects
}

export interface WebWorkerRunnerOptions {
  agentConfig: AgentConfig;
  threadingConfig: ThreadingConfig;
  workerScriptUrl?: string;  // URL to worker script
  workerScriptBlob?: Blob;   // Inline worker script
  sharedMemory?: SharedArrayBuffer;  // For cross-worker state
}

/** Runs AgentLoop in a Browser Web Worker with postMessage communication. */
export class WebWorkerRunner implements IAgentLoop {
  private worker?: Worker;
  private agentConfig: AgentConfig;
  private threadingConfig: ThreadingConfig;
  private workerScriptUrl?: string;
  private workerScriptBlob?: Blob;
  private messageId = 0;
  private pendingMessages = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timeout: number;
  }>();
  private isInitialized = false;
  private isShuttingDown = false;
  private eventListeners = new Map<string, Set<Function>>();
  private sharedMemory?: SharedArrayBuffer;

  /**
   * Construct a new WebWorkerRunner.
   *
   * @param options - Options including agent config, threading config, and worker script source
   */
  constructor(options: WebWorkerRunnerOptions) {
    this.agentConfig = options.agentConfig;
    this.threadingConfig = options.threadingConfig;
    this.workerScriptUrl = options.workerScriptUrl;
    this.workerScriptBlob = options.workerScriptBlob;
    this.sharedMemory = options.sharedMemory;

  }

  /**
   * Create the Web Worker from a URL or Blob source and establish communication.
   * Throws if Web Workers are not supported or no script source is provided.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Check if Web Workers are supported
    if (typeof Worker === 'undefined') {
      throw new Error('Web Workers are not supported in this browser');
    }

    // Create worker from URL or Blob
    if (this.workerScriptUrl) {
      this.worker = new Worker(this.workerScriptUrl, {
        type: 'classic',
        name: this.agentConfig.name || 'agent-worker'
      });
    } else if (this.workerScriptBlob) {
      const blobUrl = URL.createObjectURL(this.workerScriptBlob);
      this.worker = new Worker(blobUrl, {
        type: 'classic',
        name: this.agentConfig.name || 'agent-worker'
      });
    } else {
      throw new Error('No worker script provided. Specify workerScriptUrl or workerScriptBlob');
    }

    // Set up message handler
    this.worker.onmessage = (event: MessageEvent<WebWorkerMessage>) => {
      this.handleWorkerMessage(event.data);
    };

    // Set up error handler
    this.worker.onerror = (error: ErrorEvent) => {
      this.handleWorkerError(error);
    };

    // Set up message error handler (for serialization errors)
    this.worker.onmessageerror = (error: MessageEvent) => {
      console.error('Worker message error:', error);
      this.emit('error', new Error('Worker message serialization error'));
    };

    // Send initialization message
    const initPayload: any = {
      agentConfig: this.agentConfig
    };

    // Include shared memory if available
    if (this.sharedMemory) {
      initPayload.sharedMemory = this.sharedMemory;
    }

    await this.sendMessage({
      type: WebWorkerMessageType.INIT,
      id: this.generateMessageId(),
      payload: initPayload
    });

    this.isInitialized = true;
  }

  /**
   * Execute one turn in the Web Worker and return the response.
   * Initializes the worker first if not already initialized.
   *
   * @param input - Input string for the turn
   * @returns The result from the worker
   */
  async runTurn(input: string): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const response = await this.sendMessage({
      type: WebWorkerMessageType.RUN_TURN,
      id: this.generateMessageId(),
      payload: { input }
    });

    return response.result;
  }

  /**
   * Run the loop until completion in the Web Worker.
   * Initializes the worker first if not already initialized.
   *
   * @param options - Optional runtime options
   */
  async run(options?: any): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    await this.sendMessage({
      type: WebWorkerMessageType.RUN,
      id: this.generateMessageId(),
      payload: { options }
    });
  }

  /**
   * Get the MessageManager interface.
   *
   * @throws Error always - MessageManager is not available in a distributed worker context
   */
  getMessageManager(): IMessageManager {
    throw new Error('getMessageManager not available in distributed context');
  }

  /**
   * Get the current loop state synchronously.
   *
   * @throws Error always - use getStateAsync() instead, as Web Worker communication is async
   */
  getState(): LoopState {
    throw new Error('getState must be async in Web Worker context. Use getStateAsync()');
  }

  /**
   * Get the current loop state from the Web Worker asynchronously.
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
      type: WebWorkerMessageType.GET_STATE,
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
    throw new Error('Cannot add plugins to Web Worker runner. Configure plugins in agentConfig instead.');
  }

  /**
   * Gracefully shutdown the Web Worker by sending a shutdown message,
   * then terminating the worker and cleaning up pending messages.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown || !this.worker) {
      return;
    }

    this.isShuttingDown = true;

    try {
      // Send shutdown message
      await this.sendMessage({
        type: WebWorkerMessageType.SHUTDOWN,
        id: this.generateMessageId()
      }, 5000);  // 5 second timeout
    } catch (error) {
      // Force terminate
      console.warn('Worker shutdown timeout, force terminating');
    } finally {
      // Terminate worker
      this.worker.terminate();
      this.worker = undefined;
      this.isInitialized = false;
      this.isShuttingDown = false;

      // Clear pending messages
      for (const [id, pending] of this.pendingMessages) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Worker terminated'));
      }
      this.pendingMessages.clear();
    }
  }

  /**
   * Send a message to the Web Worker and wait for a response.
   * Uses a pending message map with timeout support.
   *
   * @param message - The message to send
   * @param timeout - Maximum time to wait for response in milliseconds (default: 30000)
   * @returns The response payload
   * @throws Error if worker not initialized or message times out
   */
  private async sendMessage(
    message: WebWorkerMessage,
    timeout: number = 30000
  ): Promise<any> {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        this.pendingMessages.delete(message.id);
        reject(new Error(`Message timeout: ${message.type}`));
      }, timeout);

      this.pendingMessages.set(message.id, {
        resolve,
        reject,
        timeout: timeoutHandle
      });

      // Post message with optional transferable objects
      if (message.transfer && message.transfer.length > 0) {
        this.worker!.postMessage(message, message.transfer);
      } else {
        this.worker!.postMessage(message);
      }
    });
  }

  /**
   * Handle an incoming message from the Web Worker.
   * Routes events and progress updates to listeners, and resolves/rejects pending message promises.
   *
   * @param message - The incoming Web Worker message
   */
  private handleWorkerMessage(message: WebWorkerMessage): void {
    // Handle events (not responses to requests)
    if (message.type === WebWorkerMessageType.EVENT) {
      this.emit('worker-event', message.payload);
      return;
    }

    // Handle progress updates
    if (message.type === WebWorkerMessageType.PROGRESS) {
      this.emit('progress', message.payload);
      return;
    }

    // Handle responses to requests
    const pending = this.pendingMessages.get(message.id);
    if (!pending) {
      // Unexpected message
      console.warn('Received message with unknown ID:', message.id);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingMessages.delete(message.id);

    if (message.type === WebWorkerMessageType.ERROR) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.payload);
    }
  }

  /**
   * Handle an error event from the Web Worker and emit it to listeners.
   *
   * @param error - The error event from the worker
   */
  private handleWorkerError(error: ErrorEvent): void {
    console.error('Worker error:', error);
    this.emit('error', new Error(error.message));

  }

  /**
   * Event emitter methods
   */
  /**
   * Register an event listener for worker events.
   *
   * @param event - Event name
   * @param listener - Callback function
   */
  on(event: string, listener: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }

  /**
   * Remove a previously registered event listener.
   *
   * @param event - Event name
   * @param listener - The registered callback function to remove
   */
  off(event: string, listener: Function): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Emit an event to all registered listeners.
   * Catches and logs listener errors to prevent propagation.
   *
   * @param event - Event name
   * @param data - Event payload
   */
  private emit(event: string, data: any): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          console.error('Event listener error:', error);
        }
      }
    }
  }

  /**
   * Generate a unique message ID for tracking pending requests.
   *
   * @returns A unique message ID string
   */
  private generateMessageId(): string {
    return `msg_${++this.messageId}_${Date.now()}`;
  }

  /**
   * Create an inline worker Blob from a function (useful for bundling worker code).
   *
   * @param workerFunction - The function to convert into a worker script
   * @returns A Blob containing the worker JavaScript code
   */
  static createInlineWorker(workerFunction: Function): Blob {
    const workerCode = `(${workerFunction.toString()})();`;
    return new Blob([workerCode], { type: 'application/javascript' });
  }
}
