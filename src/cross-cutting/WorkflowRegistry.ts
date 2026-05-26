import type { StepContext } from '../interfaces/IStep.js';

export interface WorkflowStep {
  name: string;
  priority: number;
  execute: (context: StepContext) => Promise<StepContext>;
  version?: number;
}

export interface WorkflowRegistryConfig {
  /** Maximum iterations for cycle detection */
  maxIterations?: number;
}

/**
 * Ordered registry of workflow steps with add/remove/replace/insert operations,
 * version tracking, change logging, execution, and clone support for per-worker copies.
 */
export class WorkflowRegistry {
  private steps: WorkflowStep[] = [];
  private config: WorkflowRegistryConfig;
  private _changes: Array<{ type: 'add' | 'remove' | 'replace'; step: string; timestamp: number }> = [];
  private version = 0;

  /**
   * Create a new WorkflowRegistry with optional configuration.
   *
   * @param config - Configuration including max iterations for cycle detection
   */
  constructor(config: WorkflowRegistryConfig = {}) {
    this.config = { maxIterations: config.maxIterations ?? 100 };
  }

  get changes() { return this._changes; }
  get currentVersion() { return this.version; }

  /**
   * Add a step to the workflow
   */
  addStep(step: WorkflowStep): void {
    this.steps.push(step);
    this.steps.sort((a, b) => a.priority - b.priority);
    this.version++;
    this._changes.push({ type: 'add', step: step.name, timestamp: Date.now() });
  }

  /**
   * Remove a step
   */
  removeStep(name: string): boolean {
    const idx = this.steps.findIndex(s => s.name === name);
    if (idx === -1) return false;
    this.steps.splice(idx, 1);
    this.version++;
    this._changes.push({ type: 'remove', step: name, timestamp: Date.now() });
    return true;
  }

  /**
   * Replace a step
   */
  replaceStep(name: string, newStep: WorkflowStep): boolean {
    const idx = this.steps.findIndex(s => s.name === name);
    if (idx === -1) return false;
    this.steps[idx] = newStep;
    this.steps.sort((a, b) => a.priority - b.priority);
    this.version++;
    this._changes.push({ type: 'replace', step: name, timestamp: Date.now() });
    return true;
  }

  /**
   * Insert a step between two existing steps
   */
  insertBetween(afterName: string, beforeName: string, newStep: WorkflowStep): boolean {
    const afterIdx = this.steps.findIndex(s => s.name === afterName);
    const beforeIdx = this.steps.findIndex(s => s.name === beforeName);
    if (afterIdx === -1 || beforeIdx === -1) return false;

    const afterPriority = this.steps[afterIdx].priority;
    const beforePriority = this.steps[beforeIdx].priority;
    newStep.priority = Math.floor((afterPriority + beforePriority) / 2);

    this.addStep(newStep);
    return true;
  }

  /**
   * Get ordered steps
   */
  getSteps(): WorkflowStep[] {
    return [...this.steps];
  }

  /**
   * Get step by name
   */
  getStep(name: string): WorkflowStep | undefined {
    return this.steps.find(s => s.name === name);
  }

  /**
   * Execute all steps in order
   */
  async execute(initialContext: StepContext): Promise<StepContext> {
    let context = { ...initialContext };
    for (const step of this.steps) {
      if (!context.shouldContinue) break;
      context = await step.execute(context);
    }
    return context;
  }

  /**
   * Clone the registry (for per-worker copies)
   */
  clone(): WorkflowRegistry {
    const cloned = new WorkflowRegistry(this.config);
    for (const step of this.steps) {
      cloned.steps.push({ ...step });
    }
    cloned.version = this.version;
    return cloned;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  reset(): void {
    this.steps = [];
    this._changes = [];
    this.version = 0;
  }
}
