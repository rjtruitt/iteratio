import { EventEmitter } from 'events';

/** Defines how often a workflow should run. */
export interface WorkflowSchedule {
  /** Schedule type: interval-based, cron-based, or one-shot. */
  type: 'interval' | 'cron' | 'once';
  /** Interval in ms (used when type is 'interval'). */
  intervalMs?: number;
  /** Cron expression (used when type is 'cron'). */
  cron?: string;
  /** Specific epoch-ms time to run (used when type is 'once'). */
  runAt?: number;
}

/** Describes a complete scheduled workflow. */
export interface WorkflowDefinition {
  /** Unique workflow identifier. */
  id: string;
  /** Human-readable workflow name. */
  name: string;
  /** Scheduling configuration. */
  schedule: WorkflowSchedule;
  /** Ordered list of steps to execute. */
  steps: WorkflowStep[];
  /** Whether the workflow is enabled (default: true). */
  enabled?: boolean;
  /** Arbitrary metadata attached to the workflow. */
  metadata?: Record<string, unknown>;
}

/** A single step within a workflow's execution pipeline. */
export interface WorkflowStep {
  /** Step identifier. */
  id: string;
  /** Human-readable step name. */
  name: string;
  /** Async function that performs the step's work. */
  execute: (context: unknown) => Promise<unknown>;
}

/** Records a single execution run of a workflow. */
export interface WorkflowRun {
  /** Unique run identifier. */
  id: string;
  /** ID of the workflow that was executed. */
  workflowId: string;
  /** Timestamp (epoch ms) when the run started. */
  startedAt: number;
  /** Timestamp (epoch ms) when the run completed. */
  completedAt?: number;
  /** Current status of the run. */
  status: 'running' | 'completed' | 'failed';
  /** Result data produced by the workflow. */
  result?: unknown;
  /** Error message if the run failed. */
  error?: string;
  /** Context passed into the workflow at start. */
  context?: unknown;
}

/** Configuration for the ScheduledWorkflowRunner. */
export interface ScheduledWorkflowRunnerConfig {
  /** Maximum number of runs kept in history per workflow (default: 100). */
  maxHistoryPerWorkflow?: number;
  /** Callback when a run completes successfully. */
  onRunComplete?: (run: WorkflowRun) => void;
  /** Callback when a run fails. */
  onRunFailed?: (run: WorkflowRun) => void;
}

/**
 * Schedules and executes workflows on a recurring (interval / cron)
 * or one-shot basis.
 */
export class ScheduledWorkflowRunner extends EventEmitter {
  private config: ScheduledWorkflowRunnerConfig;
  private workflows: Map<string, WorkflowDefinition> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private history: Map<string, WorkflowRun[]> = new Map();
  private running = false;
  private paused: Set<string> = new Set();
  private runCounter = 0;

  /**
   * @param config - Optional configuration defaults.
   */
  constructor(config: ScheduledWorkflowRunnerConfig = {}) {
    super();
    this.config = {
      maxHistoryPerWorkflow: config.maxHistoryPerWorkflow ?? 100,
      onRunComplete: config.onRunComplete,
      onRunFailed: config.onRunFailed,
    };
  }

  /**
   * Registers a new workflow definition. If the runner is already
   * running, the workflow is scheduled immediately.
   * Emits `workflow:registered`.
   * @param definition - The workflow to register.
   * @throws If definition or its id is missing.
   */
  register(definition: WorkflowDefinition): void {
    if (!definition || !definition.id) {
      throw new Error('Workflow definition must have an id');
    }
    this.workflows.set(definition.id, { ...definition, enabled: definition.enabled ?? true });
    this.history.set(definition.id, []);
    this.emit('workflow:registered', definition);

    if (this.running && definition.enabled !== false) {
      this.scheduleWorkflow(definition);
    }
  }

  /**
   * Unregisters a workflow, clears its timer, and removes it from
   * the paused set. Emits `workflow:unregistered`.
   * @param id - ID of the workflow to unregister.
   * @throws If the workflow is not found.
   */
  unregister(id: string): void {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }
    this.clearTimer(id);
    this.workflows.delete(id);
    this.paused.delete(id);
    this.emit('workflow:unregistered', id);
  }

  /**
   * Returns all registered workflow definitions.
   * @returns Array of WorkflowDefinition objects.
   */
  getRegistered(): WorkflowDefinition[] {
    return Array.from(this.workflows.values());
  }

  /**
   * Starts the runner, scheduling all enabled workflows.
   * Emits `runner:started`.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit('runner:started');

    for (const [id, workflow] of this.workflows) {
      if (workflow.enabled !== false && !this.paused.has(id)) {
        this.scheduleWorkflow(workflow);
      }
    }
  }

  /**
   * Stops the runner and clears all timers.
   * Emits `runner:stopped`.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const [id] of this.timers) {
      this.clearTimer(id);
    }
    this.emit('runner:stopped');
  }

  /**
   * Pauses a specific workflow by clearing its timer.
   * Emits `workflow:paused`.
   * @param id - Workflow ID to pause.
   * @throws If the workflow is not found.
   */
  pause(id: string): void {
    if (!this.workflows.has(id)) {
      throw new Error(`Workflow ${id} not found`);
    }
    this.paused.add(id);
    this.clearTimer(id);
    this.emit('workflow:paused', id);
  }

  /**
   * Resumes a paused workflow, re-scheduling it if the runner is running.
   * Emits `workflow:resumed`.
   * @param id - Workflow ID to resume.
   * @throws If the workflow is not found.
   */
  resume(id: string): void {
    if (!this.workflows.has(id)) {
      throw new Error(`Workflow ${id} not found`);
    }
    this.paused.delete(id);
    this.emit('workflow:resumed', id);

    if (this.running) {
      const workflow = this.workflows.get(id)!;
      this.scheduleWorkflow(workflow);
    }
  }

  /**
   * Executes a workflow immediately, bypassing its schedule.
   * @param id - Workflow ID to run.
   * @param context - Optional context to pass through steps.
   * @returns The resulting WorkflowRun.
   * @throws If the workflow is not found.
   */
  async runNow(id: string, context?: unknown): Promise<WorkflowRun> {
    const workflow = this.workflows.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} not found`);
    }
    return this.executeWorkflow(workflow, context);
  }

  /**
   * Returns the run history for a given workflow.
   * @param workflowId - ID of the workflow.
   * @returns Array of WorkflowRun records (empty if none).
   */
  getRunHistory(workflowId: string): WorkflowRun[] {
    return this.history.get(workflowId) ?? [];
  }

  /**
   * Schedules a workflow based on its schedule type (interval, cron, or once).
   * Emits `workflow:error` on execution failures.
   */
  private scheduleWorkflow(workflow: WorkflowDefinition): void {
    const { schedule } = workflow;

    switch (schedule.type) {
      case 'interval': {
        const intervalMs = schedule.intervalMs ?? 60000;
        const timer = setInterval(() => {
          if (!this.paused.has(workflow.id)) {
            this.executeWorkflow(workflow).catch(err => {
              this.emit('workflow:error', workflow.id, err);
            });
          }
        }, intervalMs);
        this.timers.set(workflow.id, timer);
        break;
      }
      case 'once': {
        const delay = (schedule.runAt ?? Date.now()) - Date.now();
        const timer = setTimeout(() => {
          this.executeWorkflow(workflow).catch(err => {
            this.emit('workflow:error', workflow.id, err);
          });
        }, Math.max(0, delay));
        this.timers.set(workflow.id, timer);
        break;
      }
      case 'cron': {
        const intervalMs = this.parseCronToInterval(schedule.cron ?? '*/5 * * * *');
        const timer = setInterval(() => {
          if (!this.paused.has(workflow.id)) {
            this.executeWorkflow(workflow).catch(err => {
              this.emit('workflow:error', workflow.id, err);
            });
          }
        }, intervalMs);
        this.timers.set(workflow.id, timer);
        break;
      }
    }
  }

  /**
   * Executes all steps of a workflow sequentially and records the run.
   * Emits lifecycle events: `workflow:run-started`, `workflow:run-completed`,
   * or `workflow:run-failed`.
   * @returns A populated WorkflowRun.
   */
  private async executeWorkflow(workflow: WorkflowDefinition, context?: unknown): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: `run-${++this.runCounter}`,
      workflowId: workflow.id,
      startedAt: Date.now(),
      status: 'running',
      context,
    };

    this.emit('workflow:run-started', run);

    try {
      let stepResult: unknown = context;
      for (const step of workflow.steps) {
        stepResult = await step.execute(stepResult);
      }

      run.completedAt = Date.now();
      run.status = 'completed';
      run.result = stepResult;

      this.addToHistory(workflow.id, run);
      this.emit('workflow:run-completed', run);
      if (this.config.onRunComplete) this.config.onRunComplete(run);
    } catch (error: any) {
      run.completedAt = Date.now();
      run.status = 'failed';
      run.error = error?.message ?? String(error);

      this.addToHistory(workflow.id, run);
      this.emit('workflow:run-failed', run);
      if (this.config.onRunFailed) this.config.onRunFailed(run);
    }

    return run;
  }

  /** Appends a run to the history, trimming to the configured maximum. */
  private addToHistory(workflowId: string, run: WorkflowRun): void {
    const history = this.history.get(workflowId) ?? [];
    history.push(run);
    const max = this.config.maxHistoryPerWorkflow ?? 100;
    if (history.length > max) {
      history.splice(0, history.length - max);
    }
    this.history.set(workflowId, history);
  }

  /** Clears both interval and timeout timers for a given workflow. */
  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /**
   * Parses a simple cron expression (only the minute field with an
   * asterisk-slash-N pattern) into a polling interval in ms.
   * @param cron - A cron expression string.
   * @returns Interval in milliseconds.
   */
  private parseCronToInterval(cron: string): number {
    const parts = cron.split(' ');
    const minutePart = parts[0];
    if (minutePart && minutePart.startsWith('*/')) {
      const minutes = parseInt(minutePart.slice(2), 10);
      if (!isNaN(minutes) && minutes > 0) {
        return minutes * 60 * 1000;
      }
    }
    return 5 * 60 * 1000;
  }
}
