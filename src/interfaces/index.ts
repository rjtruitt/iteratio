/**
 * Interfaces barrel — re-exports all types, interfaces, enums, and classes from
 * the iteratio core interfaces for convenient single-import use.
 * @module interfaces
 */

export type { IAgentLoop, LoopState, RunOptions } from './IAgentLoop.js';
export type { IEventBus, EventHandler } from './IEventBus.js';
export { CoreEvents } from './IEventBus.js';
export type { ILLMProvider, Message, ToolCall, LLMResponse, LLMStreamChunk, LLMOptions, ToolDefinition } from './ILLMProvider.js';
export type { ILifecycleHooks, LifecycleTurnContext, LifecycleToolCall, LifecycleToolResult, TokenUsage, LoopStatus } from './ILifecycleHooks.js';
export type { ILogger } from './ILogger.js';
export { LogLevel } from './ILogger.js';
export type { IMessageManager, GetMessagesOptions, ContextUsage, ContextWindowConfig, CompactionResult, RewindSnapshot, MessageManagerState } from './IMessageManager.js';
export type { CompressionStrategy } from './IMessageManager.js';
export type { IPlugin, PluginConfig, TurnContext } from './IPlugin.js';
export type { IStateManager } from './IStateManager.js';
export type { IStep, StepContext, StepRegistration, StepPosition } from './IStep.js';
export { StepExecutionError } from './IStep.js';
export type { ITool, IToolExecutor, ToolContext, ToolResult, ValidationResult } from './IToolExecutor.js';
export type { ITransport, TransportConfig, MessageHandler, ReplyHandler, TransportMessage, TransportStatus } from './ITransport.js';
export type { ITurnExecutor, TurnResult, ToolExecutionResult } from './ITurnExecutor.js';
export type { AgentIdentity, AgentConfig, LLMConfig, ThreadingConfig, DistributedConfig } from './IAgentConfig.js';
