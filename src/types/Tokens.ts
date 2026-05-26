/**
 * InversifyJS DI container symbols for all iteratio services.
 *
 * Each key maps to a `Symbol.for(...)` identifier used to bind and resolve
 * service implementations through the InversifyJS container.
 *
 * @example
 * ```ts
 * container.bind<AgentLoop>(TOKENS.IAgentLoop).to(AgentLoop);
 * const loop = container.get<AgentLoop>(TOKENS.IAgentLoop);
 * ```
 */
export const TOKENS = {
  IAgentLoop: Symbol.for('IAgentLoop'),
  ITurnExecutor: Symbol.for('ITurnExecutor'),
  IMessageManager: Symbol.for('IMessageManager'),
  IStateManager: Symbol.for('IStateManager'),
  IToolExecutor: Symbol.for('IToolExecutor'),
  IToolRegistry: Symbol.for('IToolRegistry'),
  ILLMProvider: Symbol.for('ILLMProvider'),
  IStepPipeline: Symbol.for('IStepPipeline'),

  ICheckpointManager: Symbol.for('ICheckpointManager'),
  IMemoryBackend: Symbol.for('IMemoryBackend'),
  IRetryStrategy: Symbol.for('IRetryStrategy'),
  IMetricsCollector: Symbol.for('IMetricsCollector'),
  ITracingProvider: Symbol.for('ITracingProvider'),
  IConstraintManager: Symbol.for('IConstraintManager'),
  IHumanApprovalProvider: Symbol.for('IHumanApprovalProvider'),
  IAgentOrchestrator: Symbol.for('IAgentOrchestrator'),
  IParallelExecutor: Symbol.for('IParallelExecutor'),

  IWorkerPool: Symbol.for('IWorkerPool'),
  ITaskQueue: Symbol.for('ITaskQueue'),

  IWorkCoordinator: Symbol.for('IWorkCoordinator'),
  IAgentRegistry: Symbol.for('IAgentRegistry'),
  IAgentMessageBus: Symbol.for('IAgentMessageBus'),
  IHealthMonitor: Symbol.for('IHealthMonitor'),
  ILeaderElection: Symbol.for('ILeaderElection'),
  ITransport: Symbol.for('ITransport'),

  ILogger: Symbol.for('ILogger'),
  IEventBus: Symbol.for('IEventBus'),
  ISerializer: Symbol.for('ISerializer'),
  IStorageBackend: Symbol.for('IStorageBackend'),
  IConfigProvider: Symbol.for('IConfigProvider')
} as const;

/**
 * String literal union of all TOKENS keys.
 *
 * @example
 * ```ts
 * const key: TokenKey = 'IAgentLoop'; // valid
 * ```
 */
export type TokenKey = keyof typeof TOKENS;
/**
 * Symbol type for any DI token value, derived from TOKENS entries.
 */
export type Token = typeof TOKENS[TokenKey];
