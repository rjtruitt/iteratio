import { injectable, inject } from 'inversify';
import { IStep, StepContext, StepRegistration, StepExecutionError } from '../interfaces/IStep.js';
import { ILogger } from '../interfaces/ILogger.js';
import { IEventBus, CoreEvents } from '../interfaces/IEventBus.js';
import { TOKENS } from '../types/Tokens.js';

interface StepMeta {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  onError?: 'throw' | 'skip' | 'continue';
}

/** Ordered step pipeline with retry, timeout, and conditional execution support. */
@injectable()
export class StepPipeline {
  private steps: Map<string, IStep> = new Map();
  private stepMeta: Map<string, StepMeta> = new Map();
  private stepOrder: string[] = [];

  constructor(
    @inject(TOKENS.ILogger) private logger: ILogger,
    @inject(TOKENS.IEventBus) private eventBus: IEventBus
  ) {}

  /** Register a step with optional positional placement (before/after/priority). */
  registerStep(registration: StepRegistration): void {
    const { step, position } = registration;

    if (this.steps.has(step.name)) {
      this.logger.warn(`Step "${step.name}" already registered, replacing`);
    }

    if (position?.replace) {
      this.removeStep(position.replace);
    }

    this.steps.set(step.name, step);
    this.stepMeta.set(step.name, {
      timeout: registration.timeout,
      retries: registration.retries,
      retryDelay: registration.retryDelay,
      onError: registration.onError,
    });

    if (position?.before) {
      const index = this.stepOrder.indexOf(position.before);
      if (index >= 0) {
        this.stepOrder.splice(index, 0, step.name);
      } else {
        this.logger.warn(`Step "${position.before}" not found, appending to end`);
        this.stepOrder.push(step.name);
      }
    } else if (position?.after) {
      const index = this.stepOrder.indexOf(position.after);
      if (index >= 0) {
        this.stepOrder.splice(index + 1, 0, step.name);
      } else {
        this.logger.warn(`Step "${position.after}" not found, appending to end`);
        this.stepOrder.push(step.name);
      }
    } else if (position?.priority !== undefined) {
      this.insertByPriority(step.name, position.priority);
    } else {
      this.insertByPriority(step.name, step.priority);
    }

    this.logger.info('Step registered', {
      name: step.name,
      priority: position?.priority || step.priority,
      order: this.stepOrder
    });
  }

  /** Register multiple steps in order. */
  registerSteps(registrations: StepRegistration[]): void {
    for (const reg of registrations) {
      this.registerStep(reg);
    }
  }

  /** Remove a step by name. */
  removeStep(name: string): void {
    this.steps.delete(name);
    this.stepOrder = this.stepOrder.filter(n => n !== name);
    this.logger.info('Step removed', { name });
  }

  /** Override the step execution order with an explicit name list. */
  reorderSteps(order: string[]): void {
    this.stepOrder = order;
    this.logger.info('Steps reordered', { order });
  }

  /** Look up a registered step by name. Returns undefined if not found. */
  getStep(name: string): IStep | undefined {
    return this.steps.get(name);
  }

  /** Return all registered steps in their current execution order. */
  getSteps(): IStep[] {
    return this.stepOrder
      .map(name => this.steps.get(name))
      .filter(step => step !== undefined) as IStep[];
  }

  /** Get a copy of the current step execution order (list of step names). */
  getStepOrder(): string[] {
    return [...this.stepOrder];
  }

  /** Run all steps in order, respecting shouldExecute guards, retries, and error modes. */
  async execute(initialContext: StepContext): Promise<StepContext> {
    let context = { ...initialContext };

    this.logger.debug('Starting pipeline execution', {
      stepCount: this.stepOrder.length,
      steps: this.stepOrder
    });

    for (const stepName of this.stepOrder) {
      const step = this.steps.get(stepName);
      if (!step) {
        this.logger.warn(`Step "${stepName}" not found, skipping`);
        continue;
      }

      if (step.shouldExecute && !step.shouldExecute(context)) {
        this.logger.debug(`Step "${stepName}" skipped (shouldExecute returned false)`);
        continue;
      }

      if (!context.shouldContinue) {
        this.logger.debug(`Pipeline stopped before step "${stepName}"`);
        break;
      }

      const meta = this.stepMeta.get(stepName) ?? {};
      const maxAttempts = (meta.retries ?? 0) + 1;
      let lastError: Error | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          this.logger.debug(`Executing step: ${stepName}`, { attempt });
          this.eventBus.emit(CoreEvents.STEP_START, { stepName, context, attempt });

          const startTime = Date.now();
          context = await this.executeWithTimeout(step, context, meta.timeout);
          const duration = Date.now() - startTime;

          this.eventBus.emit(CoreEvents.STEP_END, { stepName, context, duration });
          this.logger.debug(`Step "${stepName}" completed`, { duration });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error as Error;
          this.logger.error(`Step "${stepName}" failed (attempt ${attempt}/${maxAttempts})`, lastError);
          this.eventBus.emit(CoreEvents.STEP_ERROR, { stepName, error, attempt });

          if (attempt < maxAttempts && meta.retryDelay) {
            await this.delay(meta.retryDelay);
          }
        }
      }

      if (lastError) {
        const errorMode = meta.onError ?? 'throw';
        if (errorMode === 'skip') {
          this.logger.warn(`Step "${stepName}" failed, skipping`);
          continue;
        } else if (errorMode === 'continue') {
          context.metadata.errors = context.metadata.errors ?? [];
          (context.metadata.errors as unknown[]).push({ step: stepName, error: lastError.message });
          continue;
        } else {
          throw new StepExecutionError(stepName, lastError, context);
        }
      }
    }

    this.logger.debug('Pipeline execution completed');
    return context;
  }

  private async executeWithTimeout(step: IStep, context: StepContext, timeout?: number): Promise<StepContext> {
    if (!timeout) return step.execute(context);

    return Promise.race([
      step.execute(context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Step "${step.name}" timed out after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Remove all registered steps. */
  clear(): void {
    this.steps.clear();
    this.stepOrder = [];
  }

  /** Invoke cleanup on all steps that define it. */
  async cleanup(): Promise<void> {
    for (const step of this.steps.values()) {
      if (step.cleanup) {
        await step.cleanup();
      }
    }
  }

  private insertByPriority(name: string, priority: number): void {
    let insertIndex = this.stepOrder.length;

    for (let i = 0; i < this.stepOrder.length; i++) {
      const existingStepName = this.stepOrder[i];
      const existingStep = this.steps.get(existingStepName);

      if (existingStep && priority < existingStep.priority) {
        insertIndex = i;
        break;
      }
    }

    this.stepOrder.splice(insertIndex, 0, name);
  }
}
