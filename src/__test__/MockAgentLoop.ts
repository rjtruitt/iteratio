/**
 * MockAgentLoop - Simulates an agent loop with pause/resume/reconfigure capabilities
 * Used by hot-reconfiguration, error-propagation, and related scenario tests.
 */

class MockCircuitBreaker {
  private _state: 'closed' | 'open' | 'half-open' = 'closed';
  private _failureCount = 0;
  private _failureThreshold = 5;
  private _resetTimeoutMs = 30000;
  private _openedAt: number = -1;
  private _eventBus: any;
  private _name: string;

  constructor(name: string, eventBus: any) {
    this._name = name;
    this._eventBus = eventBus;
  }

  get state() {
    // Check if we should transition to half-open
    if (this._state === 'open' && this._openedAt >= 0) {
      const now = Date.now();
      if (now - this._openedAt >= this._resetTimeoutMs) {
        this._state = 'half-open';
      }
    }
    return this._state;
  }

  configure(config: { failureThreshold?: number; resetTimeoutMs?: number }): void {
    if (config.failureThreshold !== undefined) this._failureThreshold = config.failureThreshold;
    if (config.resetTimeoutMs !== undefined) this._resetTimeoutMs = config.resetTimeoutMs;
  }

  recordFailure(): void {
    this._failureCount++;
    if (this._failureCount >= this._failureThreshold && this._state === 'closed') {
      this._state = 'open';
      this._openedAt = Date.now();
      if (this._eventBus) {
        this._eventBus.emit('circuitBreaker:opened', { name: this._name });
      }
    }
  }

  recordSuccess(): void {
    // Access state getter to trigger time-based transitions
    const currentState = this.state;
    if (currentState === 'half-open') {
      this._state = 'closed';
      this._failureCount = 0;
      if (this._eventBus) {
        this._eventBus.emit('service:recovered', {
          name: this._name,
          downtimeMs: Date.now() - this._openedAt,
        });
      }
    }
  }

  allowRequest(): boolean {
    const currentState = this.state; // triggers state check
    if (currentState === 'open') return false;
    return true;
  }
}

export class MockAgentLoop {
  private _state: 'idle' | 'running' | 'paused' = 'idle';
  private _systemPrompt = 'Default agent prompt';
  private _steps: Array<{ name: string; execute: Function; dependsOn?: string[] }> = [];
  private _llmProvider: any;
  private _eventBus: any;
  private _executing = false;
  private _toolExecutor: any;
  private _retryPolicy: { maxRetries: number; backoffMs: number[] } | null = null;
  private _distributedLock: any;
  private _agentId: string = 'agent-default';
  private _traceContext: { traceId?: string } = {};
  private _errorHandler: ((error: any) => Promise<void>) | null = null;
  private _circuitBreakers = new Map<string, MockCircuitBreaker>();
  private _transport: any;

  constructor(llmProvider?: any, eventBus?: any) {
    this._llmProvider = llmProvider;
    this._eventBus = eventBus;
  }

  start(): void {
    this._state = 'running';
    // Subscribe to remote agent errors if transport is available
    if (this._transport && this._transport.isConnected?.()) {
      this._subscribeToTransportErrors();
    }
  }

  private async _subscribeToTransportErrors(): Promise<void> {
    try {
      await this._transport.subscribe('agent:error', (msg: any) => {
        const data = msg.data ?? msg;
        if (this._eventBus) {
          this._eventBus.emit('remoteAgent:error', data);
        }
      });
    } catch {
      // Transport not ready yet
    }
  }

  isRunning(): boolean {
    return this._state === 'running';
  }

  async pause(): Promise<void> {
    if (this._executing) {
      throw new Error('Cannot pause while step is executing');
    }
    this._state = 'paused';
  }

  resume(): void {
    this._state = 'running';
  }

  setToolExecutor(executor: any): void {
    this._toolExecutor = executor;
  }

  setRetryPolicy(policy: { maxRetries: number; backoffMs: number[] }): void {
    this._retryPolicy = policy;
  }

  setDistributedLock(redis: any): void {
    this._distributedLock = redis;
  }

  setAgentId(id: string): void {
    this._agentId = id;
  }

  setTraceContext(ctx: { traceId?: string }): void {
    this._traceContext = ctx;
  }

  setErrorHandler(handler: (error: any) => Promise<void>): void {
    this._errorHandler = handler;
  }

  setTransport(transport: any): void {
    this._transport = transport;
  }

  getCircuitBreaker(name: string): MockCircuitBreaker {
    if (!this._circuitBreakers.has(name)) {
      this._circuitBreakers.set(name, new MockCircuitBreaker(name, this._eventBus));
    }
    return this._circuitBreakers.get(name)!;
  }

  categorizeError(error: any): string {
    if (error.statusCode === 401 || error.statusCode === 403) return 'fatal';
    if (error.category === 'fatal') return 'fatal';
    if (error.code === 'ECANCELLED') return 'cancelled';
    if (error.code === 'ETIMEDOUT') return 'retryable';
    if (error.statusCode === 503 || error.statusCode === 429) return 'retryable';
    return 'retryable';
  }

  async runTurn(input: string): Promise<any> {
    if (this._state !== 'running') {
      throw new Error('Agent is not running');
    }

    this._executing = true;
    const result: any = { completed: false };
    const traceId = this._traceContext.traceId ?? `trace-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Check distributed lock if configured
      if (this._distributedLock) {
        try {
          if (!this._distributedLock.connected) {
            result.fallback = true;
            result.lockAcquired = false;
            result.errorChain = [
              { layer: 'redis', message: 'Connection closed' },
              { layer: 'distributed-lock', message: 'Cannot acquire lock' },
              { layer: 'agent', message: 'Falling back to local processing' },
            ];
            if (this._eventBus) {
              this._eventBus.emit('lock:fallbackToLocal', { agentId: this._agentId });
            }
          } else {
            result.lockAcquired = true;
          }
        } catch (e: any) {
          result.fallback = true;
          result.lockAcquired = false;
        }
      }

      // Run pipeline steps
      let context: any = { input, shouldContinue: true, errors: [] };
      for (const step of this._steps) {
        if (step.execute) {
          context = await step.execute(context);
        }
      }

      // Execute tools if requested
      if (this._toolExecutor) {
        const toolResults = this._toolExecutor.getResults?.() ?? {};
        const toolErrors: any[] = [];
        for (const [toolName, toolResult] of Object.entries(toolResults) as any[]) {
          if (!toolResult.success) {
            toolErrors.push({ toolName, error: toolResult.error });
            context.errors.push({ source: 'tool', toolName, message: toolResult.error });
          }
        }
        if (toolErrors.length > 0) {
          result.toolErrors = toolErrors;
        }
      }

      // Call LLM with retry
      if (this._llmProvider) {
        const messages = [
          { role: 'system', content: this._systemPrompt },
          { role: 'user', content: input }
        ];

        let lastError: any = null;
        let attempts = 0;
        const maxRetries = this._retryPolicy?.maxRetries ?? 0;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          attempts++;
          try {
            const response = await this._llmProvider.invoke(messages);
            result.content = response.content;
            result.completed = true;
            this._executing = false;
            // Return full result object if error-handling features are configured
            if (this._retryPolicy || this._toolExecutor || this._distributedLock || this._errorHandler) {
              return result;
            }
            // Return simple string for basic agent usage (hot-reconfiguration tests)
            return result.content;
          } catch (e: any) {
            lastError = e;
            const category = this.categorizeError(e);

            if (this._eventBus) {
              this._eventBus.emit('llm:error', { error: e, attempt: attempt + 1, category });
            }

            // Don't retry fatal errors
            if (category === 'fatal') {
              break;
            }

            // If more retries available, continue
            if (attempt < maxRetries) {
              continue;
            }
          }
        }

        // All retries exhausted or fatal error
        if (lastError) {
          // Try error handler
          let metaError: any = null;
          if (this._errorHandler) {
            try {
              await this._errorHandler(lastError);
            } catch (handlerErr: any) {
              metaError = { message: handlerErr.message ?? String(handlerErr) };
            }
          }

          // Build error chain from cause
          const errorChain: any[] = [];
          let current = lastError;
          while (current) {
            errorChain.push({ message: current.message ?? String(current), layer: 'llm' });
            current = current.cause;
          }

          const errorMessage = lastError.message ?? String(lastError ?? 'Unknown error');
          result.error = {
            message: errorMessage,
            category: this.categorizeError(lastError),
            retriesExhausted: attempts > 1,
            context: {
              traceId,
              agentId: this._agentId,
              operation: 'runTurn',
              timestamp: Date.now(),
            }
          };

          if (errorChain.length > 1) {
            result.errorChain = errorChain;
          }

          if (metaError) {
            result.metaError = metaError;
          }

          this._executing = false;
          return result;
        }
      }

      result.completed = true;
      this._executing = false;
      return result.content ?? result;
    } catch (e: any) {
      this._executing = false;
      result.error = { message: e.message ?? String(e) };
      return result;
    }
  }

  addStep(step: { name: string; execute?: Function | null; dependsOn?: string[] }): void {
    this._steps.push({
      name: step.name,
      execute: step.execute ? step.execute.bind(step) : (async (ctx: any) => ctx),
      dependsOn: (step as any).dependsOn
    });
  }

  reconfigure(config: any): Promise<void> {
    if (this._state !== 'paused') {
      if (this._executing) {
        return Promise.reject(new Error('Cannot reconfigure while step is executing'));
      }
    }

    // Validate
    if (config.llmProvider === null) {
      throw new Error('Invalid LLM provider: cannot be null');
    }

    if (config.addSteps) {
      for (const step of config.addSteps) {
        if (!step.execute) {
          throw new Error('Invalid step: missing execute function');
        }
        if (this._steps.some(s => s.name === step.name)) {
          throw new Error(`Duplicate step: '${step.name}' already exists`);
        }
      }
    }

    if (config.removeSteps) {
      for (const name of config.removeSteps) {
        // Check if any other step depends on this one
        const dependents = this._steps.filter(s =>
          s.dependsOn && s.dependsOn.includes(name) && !config.removeSteps.includes(s.name)
        );
        if (dependents.length > 0) {
          throw new Error(`Cannot remove '${name}': dependency required by '${dependents[0].name}'`);
        }
      }
    }

    // Apply changes
    if (config.systemPrompt !== undefined) {
      this._systemPrompt = config.systemPrompt;
    }

    if (config.llmProvider !== undefined) {
      if (this._llmProvider && typeof this._llmProvider.shutdown === 'function') {
        this._llmProvider.shutdown();
      }
      this._llmProvider = config.llmProvider;
    }

    if (config.removeSteps) {
      this._steps = this._steps.filter(s => !config.removeSteps.includes(s.name));
    }

    if (config.addSteps) {
      for (const step of config.addSteps) {
        this._steps.push({
          name: step.name,
          execute: step.execute ? step.execute.bind(step) : (async (ctx: any) => ctx),
          dependsOn: step.dependsOn
        });
      }
    }

    return Promise.resolve();
  }

  validateReconfiguration(config: any): Array<{ field: string; message: string }> {
    const errors: Array<{ field: string; message: string }> = [];
    if (config.maxConcurrent !== undefined && config.maxConcurrent < 0) {
      errors.push({ field: 'maxConcurrent', message: 'Must be non-negative' });
    }
    if (config.systemPrompt !== undefined && config.systemPrompt === '') {
      errors.push({ field: 'systemPrompt', message: 'Must not be empty' });
    }
    return errors;
  }

  getPipeline() {
    const steps = this._steps;
    return {
      hasStep(name: string): boolean {
        return steps.some(s => s.name === name);
      },
      stepCount(): number {
        return steps.length;
      },
      getStepNames(): string[] {
        return steps.map(s => s.name);
      }
    };
  }

  getSystemPrompt(): string {
    return this._systemPrompt;
  }

  setLLMProvider(provider: any): void {
    this._llmProvider = provider;
  }
}
