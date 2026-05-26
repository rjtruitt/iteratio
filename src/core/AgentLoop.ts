import { injectable, inject } from 'inversify';
import 'reflect-metadata';
import { IAgentLoop, RunOptions, LoopState } from '../interfaces/IAgentLoop.js';
import { IPlugin } from '../interfaces/IPlugin.js';
import { IMessageManager } from '../interfaces/IMessageManager.js';
import { IStateManager } from '../interfaces/IStateManager.js';
import { IEventBus, CoreEvents } from '../interfaces/IEventBus.js';
import { ILogger } from '../interfaces/ILogger.js';
import { ITool } from '../interfaces/IToolExecutor.js';
import { IToolExecutor } from '../interfaces/IToolExecutor.js';
import { StepPipeline } from './StepPipeline.js';
import { StepContext, StepRegistration } from '../interfaces/IStep.js';
import { TOKENS } from '../types/Tokens.js';

/** Step-based agent loop with plugin support and configurable pipeline. */
@injectable()
export class AgentLoop implements IAgentLoop {
  private plugins: IPlugin[] = [];
  private turnNumber: number = 0;
  private isRunning: boolean = false;
  private stepPipeline: StepPipeline;
  private toolExecutor: IToolExecutor;

  constructor(
    @inject(TOKENS.IMessageManager) private messageManager: IMessageManager,
    @inject(TOKENS.IStateManager) private stateManager: IStateManager,
    @inject(TOKENS.IEventBus) private eventBus: IEventBus,
    @inject(TOKENS.ILogger) private logger: ILogger,
    @inject(TOKENS.IStepPipeline) stepPipeline: StepPipeline,
    @inject(TOKENS.IToolExecutor) toolExecutor: IToolExecutor
  ) {
    this.stepPipeline = stepPipeline;
    this.toolExecutor = toolExecutor;
    this.logger.info('AgentLoop initialized');
  }

  /** Register a single tool for use during agent turns. */
  registerTool(tool: ITool): void {
    this.toolExecutor.registerTool(tool);
  }

  /** Register multiple tools at once. */
  registerTools(tools: ITool[]): void {
    for (const t of tools) this.toolExecutor.registerTool(t);
  }

  /** Remove a tool by name. Returns true if the tool existed. */
  deregisterTool(name: string): boolean {
    return this.toolExecutor.deregisterTool(name);
  }

  /** Get all registered tool instances. */
  getTools(): ITool[] {
    return this.toolExecutor.getTools();
  }

  /** Look up a single tool by name. */
  getTool(name: string): ITool | undefined {
    return this.toolExecutor.getTool(name);
  }

  /** Get LLM-ready tool definitions for all registered tools. */
  getToolDefinitions(): import('../interfaces/IToolExecutor.js').ToolDefinition[] {
    return this.toolExecutor.getToolDefinitions();
  }

  /** Register default workflow steps (called by builder during initialization). */
  registerDefaultSteps(): void {
    this.logger.info('Default workflow steps registered');
  }

  /** Register a custom workflow step with optional positioning. */
  registerStep(registration: StepRegistration): void {
    this.stepPipeline.registerStep(registration);
  }

  /** Reorder the workflow steps by name. */
  reorderSteps(order: string[]): void {
    this.stepPipeline.reorderSteps(order);
  }

  /** Get current workflow step order. */
  getWorkflowOrder(): string[] {
    return this.stepPipeline.getStepOrder();
  }

  /** Execute a single turn: before plugins → pipeline loop → after plugins → response. */
  async runTurn(input: string, maxIterations?: number): Promise<string> {
    this.turnNumber++;
    const maxTurns = maxIterations ?? 10;

    this.logger.debug('runTurn', { input, turn: this.turnNumber });
    this.eventBus.emit(CoreEvents.TURN_START, { turn: this.turnNumber, input });

    try {
      // 1. Before-turn plugins
      const ctx = { turnNumber: this.turnNumber, messages: this.messageManager.getMessages(), state: this.stateManager.toObject(), metadata: {} };
      for (const p of this.plugins) await p.beforeTurn?.(ctx);

      // 2. Pipeline loop: CallLLM → tool results → CallLLM → ... → done
      let resultContext: StepContext | undefined;
      const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

      for (let i = 0; i < maxTurns; i++) {
        resultContext = await this.stepPipeline.execute({
          turnNumber: this.turnNumber,
          messages: this.messageManager.getMessages(),
          state: this.stateManager.toObject(),
          metadata: resultContext?.metadata ?? {},
          shouldContinue: true,
          data: { userInput: i === 0 ? input : undefined },
        });

        if (resultContext.metadata.llmUsage) {
          const u = resultContext.metadata.llmUsage as any;
          usage.input_tokens += u.input_tokens ?? 0;
          usage.output_tokens += u.output_tokens ?? 0;
          usage.total_tokens += u.total_tokens ?? 0;
          this.eventBus.emit(CoreEvents.ITERATION_USAGE, { usage: u });
        }

        if (!resultContext.shouldContinue) break;
      }

      if (!resultContext) return '';

      // 3. After-turn plugins
      for (const p of this.plugins) await p.afterTurn?.({
        turnNumber: this.turnNumber, messages: resultContext.messages, state: resultContext.state, metadata: resultContext.metadata,
      });

      // 4. Build and return response
      const response = resultContext.llmResponse?.content || '';
      this.eventBus.emit(CoreEvents.TURN_END, {
        turnNumber: this.turnNumber, response,
        usage: usage.total_tokens > 0 ? usage : resultContext.metadata.llmUsage,
      });
      return response;
    } catch (error) {
      this.logger.error('Turn failed', error as Error);
      this.eventBus.emit(CoreEvents.TURN_ERROR, { turnNumber: this.turnNumber, error });
      throw error;
    }
  }

  /** Run the agent loop continuously until max turns or an explicit stop. */
  async run(options?: RunOptions): Promise<void> {
    this.logger.info('Starting agent loop');
    this.isRunning = true;

    try {
      this.eventBus.emit(CoreEvents.LOOP_START, {});
      const maxTurns = options?.maxTurns ?? 20;

      if (options?.initialMessages) {
        for (const msg of options.initialMessages) {
          this.messageManager.addMessage(msg);
        }
      }

      let turnsExecuted = 0;
      while (turnsExecuted < maxTurns && this.isRunning) {
        turnsExecuted++;

        const stepContext: StepContext = {
          turnNumber: turnsExecuted,
          messages: this.messageManager.getMessages(),
          state: this.stateManager.toObject(),
          metadata: {},
          shouldContinue: true,
          data: {}
        };

        const result = await this.stepPipeline.execute(stepContext);

        if (!result.shouldContinue) {
          break;
        }
      }

      this.logger.info('Loop execution completed', { turnsExecuted });
    } catch (error) {
      this.logger.error('Loop error', error as Error);
      this.eventBus.emit(CoreEvents.LOOP_ERROR, { error });
      throw error;
    } finally {
      this.isRunning = false;
      this.eventBus.emit(CoreEvents.LOOP_END, {});
    }
  }

  /** Add a plugin that hooks into turn lifecycle events. */
  addPlugin(plugin: IPlugin): void {
    this.plugins.push(plugin);
    this.logger.info('Plugin added', { plugin: plugin.name });
  }

  /** Snapshot of current loop state including turn number and running status. */
  getState(): LoopState {
    return {
      turnNumber: this.turnNumber,
      isRunning: this.isRunning,
      metadata: this.stateManager.toObject()
    };
  }

  /** Access the underlying message manager for direct conversation manipulation. */
  getMessageManager(): IMessageManager {
    return this.messageManager;
  }

  /** Gracefully shut down the loop, cleaning up steps and plugins. */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down agent loop');
    this.isRunning = false;

    await this.stepPipeline.cleanup();

    for (const plugin of this.plugins) {
      if (plugin.shutdown) {
        await plugin.shutdown();
      }
    }
  }
}
