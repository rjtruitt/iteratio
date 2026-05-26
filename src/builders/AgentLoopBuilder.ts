import { Container } from 'inversify';
import { AgentLoop } from '../core/AgentLoop.js';
import { StepPipeline } from '../core/StepPipeline.js';
import { TurnExecutor } from '../core/TurnExecutor.js';
import { MessageManager } from '../core/MessageManager.js';
import { StateManager } from '../core/StateManager.js';
import { ToolExecutor } from '../core/ToolExecutor.js';
import { EventBus } from '../core/EventBus.js';
import { EventLogger } from '../core/EventLogger.js';
import { AddUserMessageStep } from '../core/steps/AddUserMessageStep.js';
import { CallLLMStep } from '../core/steps/CallLLMStep.js';
import { ExecuteToolsStep } from '../core/steps/ExecuteToolsStep.js';
import { AddToolResultsStep } from '../core/steps/AddToolResultsStep.js';
import { AddAssistantResponseStep } from '../core/steps/AddAssistantResponseStep.js';
import { ILLMProvider } from '../interfaces/ILLMProvider.js';
import { IPlugin } from '../interfaces/IPlugin.js';
import { ITool, ToolResult } from '../interfaces/IToolExecutor.js';
import { ILogger, LogLevel } from '../interfaces/ILogger.js';
import { IEventBus, CoreEvents } from '../interfaces/IEventBus.js';
import { ContextWindowConfig } from '../interfaces/IMessageManager.js';
import { TOKENS } from '../types/Tokens.js';
import { ContainerFactory } from '../container/ContainerFactory.js';

/**
 * Callbacks for observing tool invocations and results during turns.
 *
 * @property onToolCall - Optional callback invoked when a tool is called (receives tool name and args).
 * @property onToolResult - Optional callback invoked when a tool returns a result (receives name, args, result, duration).
 */
export interface ToolEventCallbacks {
  onToolCall?: (toolName: string, args: unknown) => void;
  onToolResult?: (toolName: string, args: unknown, result: ToolResult, durationMs: number) => void;
}

/**
 * Token usage data emitted after each LLM call.
 *
 * @property input_tokens - Number of tokens in the request (prompt).
 * @property output_tokens - Number of tokens in the response (completion).
 * @property total_tokens - Sum of input and output tokens.
 */
export interface UsageData {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/**
 * Fluent builder for constructing fully configured AgentLoop instances.
 *
 * Provides a chainable API for setting the LLM provider, tools, plugins, logger,
 * context window configuration, event callbacks, and more before calling `build()`.
 */
export class AgentLoopBuilder {
  private container?: Container;
  private llmProvider?: ILLMProvider;
  private plugins: IPlugin[] = [];
  private tools?: ITool[];
  private agentName?: string;
  private systemPrompt?: string;
  private logLevel: LogLevel = LogLevel.ERROR;
  private customLogger?: ILogger;
  private toolCallbacks?: ToolEventCallbacks;
  private usageCallback?: (usage: UsageData) => void;
  private contextWindowConfig?: ContextWindowConfig;

  /**
   * Set the agent name (stored in state for identification).
   *
   * @param name - The agent name to assign.
   * @returns The builder instance for chaining.
   */
  name(name: string): this {
    this.agentName = name;
    return this;
  }

  /**
   * Set the system prompt prepended to conversation history.
   *
   * @param prompt - The system-level instruction message.
   * @returns The builder instance for chaining.
   */
  withSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  /**
   * Provide a pre-configured InversifyJS container instead of creating a default.
   *
   * @param container - An existing InversifyJS Container instance.
   * @returns The builder instance for chaining.
   */
  withContainer(container: Container): this {
    this.container = container;
    return this;
  }

  /**
   * Set the LLM provider (required). Must be called before `build()`.
   *
   * @param provider - The LLM provider implementation.
   * @returns The builder instance for chaining.
   */
  withLLM(provider: ILLMProvider): this {
    this.llmProvider = provider;
    return this;
  }

  /**
   * Add a single plugin to the loop.
   *
   * @param plugin - The plugin instance to add.
   * @returns The builder instance for chaining.
   */
  withPlugin(plugin: IPlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  /**
   * Add multiple plugins to the loop.
   *
   * @param plugins - An array of plugin instances to add.
   * @returns The builder instance for chaining.
   */
  withPlugins(plugins: IPlugin[]): this {
    this.plugins.push(...plugins);
    return this;
  }

  /**
   * Register tools available to the agent.
   *
   * @param tools - An array of Tool implementations.
   * @returns The builder instance for chaining.
   */
  withTools(tools: ITool[]): this {
    this.tools = tools;
    return this;
  }

  /**
   * Set the minimum log level for the default event logger.
   *
   * @param level - The minimum LogLevel to record (e.g. LogLevel.ERROR, LogLevel.DEBUG).
   * @returns The builder instance for chaining.
   */
  withLogLevel(level: LogLevel): this {
    this.logLevel = level;
    return this;
  }

  /**
   * Provide a custom logger implementation.
   *
   * @param logger - An ILogger-compatible logger instance.
   * @returns The builder instance for chaining.
   */
  withLogger(logger: ILogger): this {
    this.customLogger = logger;
    return this;
  }

  /**
   * Subscribe to tool call and result events.
   *
   * @param callbacks - An object with optional onToolCall and/or onToolResult handlers.
   * @returns The builder instance for chaining.
   */
  onToolEvents(callbacks: ToolEventCallbacks): this {
    this.toolCallbacks = callbacks;
    return this;
  }

  /**
   * Configure context window management (max tokens, compaction strategy, etc.).
   *
   * @param config - Context window configuration options.
   * @returns The builder instance for chaining.
   */
  withContextWindow(config: ContextWindowConfig): this {
    this.contextWindowConfig = config;
    return this;
  }

  /**
   * Subscribe to token usage reports at the end of each turn.
   *
   * @param callback - A function receiving UsageData (input_tokens, output_tokens, total_tokens).
   * @returns The builder instance for chaining.
   */
  onUsage(callback: (usage: UsageData) => void): this {
    this.usageCallback = callback;
    return this;
  }

  /**
   * Build and return the fully configured AgentLoop instance.
   *
   * Creates or reuses an InversifyJS container, registers all configured services
   * (LLM provider, tools, plugins, logger, steps, callbacks), and returns the
   * assembled AgentLoop ready for execution.
   *
   * @returns A fully configured AgentLoop instance.
   * @throws {Error} If no LLM provider has been set via `withLLM()`.
   */
  build(): AgentLoop {
    if (!this.llmProvider) {
      throw new Error('LLM provider required');
    }

    const container = this.container || ContainerFactory.createDefault();

    const logger = this.customLogger || new EventLogger(this.logLevel);

    container.bind(TOKENS.ILLMProvider).toConstantValue(this.llmProvider);
    container.bind(TOKENS.ITurnExecutor).to(TurnExecutor).inSingletonScope();
    container.bind(TOKENS.IMessageManager).to(MessageManager).inSingletonScope();
    container.bind(TOKENS.IStateManager).to(StateManager).inSingletonScope();
    container.bind(TOKENS.IToolExecutor).to(ToolExecutor).inSingletonScope();
    container.bind(TOKENS.IEventBus).to(EventBus).inSingletonScope();
    container.bind(TOKENS.ILogger).toConstantValue(logger);
    container.bind(TOKENS.IStepPipeline).to(StepPipeline).inSingletonScope();
    container.bind(TOKENS.IAgentLoop).to(AgentLoop).inSingletonScope();

    const loop = container.get<AgentLoop>(TOKENS.IAgentLoop);

    const eventBus = container.get<EventBus>(TOKENS.IEventBus);
    if (logger instanceof EventLogger) {
      logger.setEventBus(eventBus);
    }

    const stepPipeline = container.get<StepPipeline>(TOKENS.IStepPipeline);
    const msgManager = container.get<MessageManager>(TOKENS.IMessageManager);
    const toolExec = container.get<ToolExecutor>(TOKENS.IToolExecutor);

    if (this.tools) {
      for (const tool of this.tools) {
        toolExec.registerTool(tool);
      }
    }

    if (this.toolCallbacks) {
      toolExec.setCallbacks({
        onToolCall: this.toolCallbacks.onToolCall,
        onToolResult: this.toolCallbacks.onToolResult,
      });
    }

    stepPipeline.registerSteps([
      { step: new AddUserMessageStep(msgManager) },
      { step: new CallLLMStep(this.llmProvider, toolExec) },
      { step: new ExecuteToolsStep(toolExec) },
      { step: new AddToolResultsStep(msgManager) },
      { step: new AddAssistantResponseStep(msgManager) },
    ]);

    if (this.agentName) {
      const stateManager = container.get<StateManager>(TOKENS.IStateManager);
      stateManager.set('agentName', this.agentName);
    }

    if (this.contextWindowConfig) {
      msgManager.configure(this.contextWindowConfig);
    }
    msgManager.setLLMProvider(this.llmProvider);

    if (this.systemPrompt) {
      msgManager.addMessage({ role: 'system', content: this.systemPrompt });
    }

    if (this.usageCallback) {
      const eventBus = container.get<IEventBus>(TOKENS.IEventBus);
      const cb = this.usageCallback;
      eventBus.on(CoreEvents.ITERATION_USAGE, (data: any) => {
        if (data.usage) {
          cb(data.usage);
        }
      });
    }

    for (const plugin of this.plugins) {
      loop.addPlugin(plugin);
    }

    return loop;
  }

  /**
   * Factory method for fluent construction.
   *
   * @returns A new AgentLoopBuilder instance ready for chaining.
   */
  static create(): AgentLoopBuilder {
    return new AgentLoopBuilder();
  }
}
