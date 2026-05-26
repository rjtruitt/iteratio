/** Execution context passed through the step pipeline. */
export interface StepContext {
  turnNumber: number;
  messages: any[];
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  llmResponse?: any;
  toolResults?: any[];
  shouldContinue: boolean;
  data: Record<string, unknown>;
}

/** A single step in the agent loop pipeline. */
export interface IStep {
  readonly name: string;
  readonly description: string;

  /**
   * Execution priority (lower = earlier). Default steps use 100, 200, 300, etc.
   * Plugins can insert between with 150, 250, etc.
   */
  readonly priority: number;

  /** Execute this step and return updated context. */
  execute(context: StepContext): Promise<StepContext>;

  /** Return false to skip this step for the current context. */
  shouldExecute?(context: StepContext): boolean;

  /** Cleanup resources held by this step. */
  cleanup?(): Promise<void>;
}

/** Step registration options including positioning and error handling. */
export interface StepRegistration {
  step: IStep;
  position?: StepPosition;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  onError?: 'throw' | 'skip' | 'continue';
}

/** Where to insert a step relative to another. */
export interface StepPosition {
  before?: string;
  after?: string;
  replace?: string;
  priority?: number;
}

/** Error thrown when a pipeline step fails during execution. */
export class StepExecutionError extends Error {
  constructor(
    public readonly stepName: string,
    public readonly cause: Error,
    public readonly context?: StepContext
  ) {
    super(`Step "${stepName}" failed: ${cause.message}`);
    this.name = 'StepExecutionError';
  }
}
